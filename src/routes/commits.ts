/**
 * Commit endpoints
 *
 * POST /v1/repos/:slug/commits       — Create commit via API (no git push needed)
 * GET  /v1/repos/:slug/commits       — List commits
 * GET  /v1/repos/:slug/commits/:sha  — Get single commit
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { createApiCommit, ConflictError, EditConflictError, InvalidBase64Error, setTreeCacheRef, type FileChange, type CommitAuthor } from "../services/commit-builder";
import { MorphError } from "../services/morph";
import { recordUsage } from "../services/usage";

import { checkFreeLimits } from "../services/limits";
import { isValidRefName, validateFilePath } from "../git/validation";
import type { IndexFileMessage } from "../services/semantic-index";
import type { GraphIndexFileMessage } from "../services/graph-index";
import type { Env, Variables } from "../types";

const commits = new Hono<{ Bindings: Env; Variables: Variables }>();

const COMMIT_LIST_CACHE_TTL = 600; // 10 min — commit SHAs are immutable

export function parseAuthorString(author: string): { name: string; email: string; timestamp: number } {
  const match = author.match(/^(.+?)\s+<([^>]+)>\s+(\d+)/);
  if (match) {
    return { name: match[1], email: match[2], timestamp: parseInt(match[3], 10) };
  }
  return { name: author, email: "", timestamp: 0 };
}

// POST /v1/repos/:slug/commits
const createCommitHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  // Free tier: check API call limit
  const apiLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "api_call");
  if (!apiLimit.allowed) {
    return c.json({
      error: "Free tier limit exceeded: API calls",
      used: apiLimit.used,
      limit: apiLimit.limit,
      upgrade_url: "https://app.coregit.dev/dashboard/billing",
    }, 429);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  let body: {
    branch: string;
    message: string;
    author: CommitAuthor;
    changes: FileChange[];
    parent_sha?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { branch, message, author, changes, parent_sha } = body;

  if (!branch) return c.json({ error: "branch is required" }, 400);
  if (!isValidRefName(branch)) return c.json({ error: "Invalid branch name" }, 400);
  if (!message) return c.json({ error: "message is required" }, 400);
  if (message.length > 51200) return c.json({ error: "Commit message exceeds 50 KB limit" }, 400);
  if (!author?.name || !author?.email) return c.json({ error: "author.name and author.email are required" }, 400);
  if (!changes || !Array.isArray(changes) || changes.length === 0) {
    return c.json({ error: "changes array is required and must not be empty" }, 400);
  }
  if (changes.length > 1000) {
    return c.json({ error: "Maximum 1000 file changes per commit" }, 400);
  }
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  const MAX_LAZY_EDIT_SNIPPET = 200 * 1024; // 200 KB (~50k tokens, well under Morph's 128k limit)
  const MAX_LAZY_EDITS_PER_COMMIT = 50; // soft cap — CF Worker subrequest budget + sensible UX
  let lazyEditCount = 0;
  for (const change of changes) {
    if (change.content && change.content.length > MAX_FILE_SIZE) {
      return c.json({ error: `File content exceeds 10 MB limit: ${change.path}` }, 400);
    }
    // Validate file paths: no traversal, null bytes, or empty segments
    const pathError = validateFilePath(change.path);
    if (pathError) {
      return c.json({ error: pathError }, 400);
    }
    if (change.action === "rename" && change.new_path) {
      const newPathError = validateFilePath(change.new_path);
      if (newPathError) {
        return c.json({ error: newPathError }, 400);
      }
    }
    if (change.action === "edit") {
      if (!change.edits || !Array.isArray(change.edits) || change.edits.length === 0) {
        return c.json({ error: `edits array required for action "edit": ${change.path}` }, 400);
      }
      for (const edit of change.edits) {
        if (!edit.range && edit.old_string === undefined) {
          return c.json({ error: `Each edit must have either "range" or "old_string": ${change.path}` }, 400);
        }
      }
    }
    if (change.action === "lazy_edit") {
      lazyEditCount += 1;
      if (!change.edit_snippet || change.edit_snippet.length === 0) {
        return c.json({ error: `edit_snippet required for action "lazy_edit": ${change.path}` }, 400);
      }
      if (change.edit_snippet.length > MAX_LAZY_EDIT_SNIPPET) {
        return c.json({ error: `edit_snippet exceeds 200 KB: ${change.path}` }, 400);
      }
    }
    // Validate base64 content
    if (change.encoding === "base64" && change.content) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(change.content)) {
        return c.json({ error: `Invalid base64 content for file: ${change.path}` }, 400);
      }
    }
  }

  // lazy_edit is a paid-tier feature (remote LLM merge via Morph, billed per output token)
  if (lazyEditCount > 0) {
    if (c.get("orgTier") === "free") {
      return c.json(
        {
          error: "lazy_edit requires a paid plan",
          upgrade_url: "https://app.coregit.dev/dashboard/billing",
        },
        402
      );
    }
    if (lazyEditCount > MAX_LAZY_EDITS_PER_COMMIT) {
      return c.json(
        { error: `Maximum ${MAX_LAZY_EDITS_PER_COMMIT} lazy_edit changes per commit` },
        400
      );
    }
    if (!c.env.MORPH_API_KEY) {
      return c.json({ error: "lazy_edit is not configured on this deployment" }, 503);
    }
  }

  try {
    // Enable KV tree cache for commit-builder (immutable flat tree by commitSha)
    setTreeCacheRef(c.env.TREE_CACHE as KVNamespace | undefined);
    // Session hot layer (Level 2) — if X-Session-Id present, override RepoDO with SessionDO
    if (c.get("sessionStub")) {
      storage.setSessionStub(c.get("sessionStub") as DurableObjectStub);
    }
    // Note: RepoDO (Level 1) is attached automatically by resolveRepo
    const result = await createApiCommit(
      storage,
      branch,
      message,
      author,
      changes,
      parent_sha,
      c.env.MORPH_API_KEY
    );

    // Billable: Morph Fast Apply output tokens (only charged on commit success)
    if (result.morphUsage && result.morphUsage.outputTokens > 0) {
      recordUsage(
        c.executionCtx,
        c.env,
        db,
        orgId,
        c.get("dodoCustomerId"),
        "lazy_edit_tokens",
        result.morphUsage.outputTokens,
        {
          call_count: result.morphUsage.callCount,
          model: "morph-v3-fast",
          commit_sha: result.sha,
        }
      );
    }

    // Trigger delta indexing if auto_index enabled
    if (found.autoIndex && c.env.INDEXING_QUEUE) {
      const indexMsg: IndexFileMessage = {
        type: "index_files",
        orgId,
        repoId: found.id,
        repoStorageSuffix: resolved.storageSuffix,
        branch,
        commitSha: result.sha,
        files: changes.map((ch) => {
          const finalPath = ch.action === "rename" ? ch.new_path! : ch.path;
          return {
            path: finalPath,
            action: (ch.action || "create") as "create" | "edit" | "delete" | "rename",
            blobSha: ch.action === "delete" ? undefined : result.changedBlobs.get(finalPath),
            oldPath: ch.action === "rename" ? ch.path : undefined,
          };
        }),
      };
      c.executionCtx.waitUntil(c.env.INDEXING_QUEUE.send(indexMsg));

      // Also trigger code graph indexing
      const graphMsg: GraphIndexFileMessage = {
        type: "graph_index_files",
        orgId,
        repoId: found.id,
        repoStorageSuffix: resolved.storageSuffix,
        branch,
        commitSha: result.sha,
        files: indexMsg.files,
      };
      c.executionCtx.waitUntil(c.env.INDEXING_QUEUE.send(graphMsg));
    }

    return c.json(
      {
        sha: result.sha,
        tree_sha: result.treeSha,
        branch,
        parent: result.parentSha,
        _timing: result.timing,
      },
      201
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof EditConflictError) {
      return c.json({ error: error.message, context: error.context }, 422);
    }
    if (error instanceof InvalidBase64Error) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof MorphError) {
      return c.json({ error: `Lazy merge failed: ${error.message}` }, 502);
    }
    console.error("Failed to create commit:", error);
    return c.json({ error: "Failed to create commit" }, 500);
  }
};
commits.post("/:slug/commits", apiKeyAuth, createCommitHandler);
commits.post("/:namespace/:slug/commits", apiKeyAuth, createCommitHandler);

// GET /v1/repos/:slug/commits
const listCommitsHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  const ref = c.req.query("ref") || c.req.query("branch");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const cursor = c.req.query("cursor"); // SHA to resume from (exclusive)

  const branchName = ref || found.defaultBranch;

  // If cursor provided, start from the cursor's parent; otherwise resolve ref
  let commitSha: string | null = null;
  if (cursor && /^[0-9a-f]{40}$/i.test(cursor)) {
    // Walk from cursor's first parent (cursor itself was already returned)
    const cursorRaw = await storage.getObject(cursor);
    if (!cursorRaw) return c.json({ error: "Cursor commit not found" }, 400);
    const cursorObj = parseGitObject(cursorRaw);
    if (cursorObj.type !== "commit") return c.json({ error: "Cursor is not a commit" }, 400);
    const cursorCommit = parseCommit(cursorObj.content);
    commitSha = cursorCommit.parents[0] || null;
  } else {
    commitSha = await storage.getRef(`refs/heads/${branchName}`);
    // Try as raw SHA
    if (!commitSha && branchName && /^[0-9a-f]{40}$/i.test(branchName)) {
      commitSha = branchName;
    }
  }

  if (!commitSha) {
    if (cursor) return c.json({ commits: [], ref: branchName, has_more: false, next_cursor: null });
    return c.json({ error: "Ref not found" }, 404);
  }

  try {
    // KV cache: keyed by immutable commitSha + limit
    const searchCache = c.env.SEARCH_CACHE as KVNamespace | undefined;
    const cacheKey = searchCache
      ? `commits:${orgId}/${found.id}:${commitSha}:${limit}`
      : null;

    if (searchCache && cacheKey) {
      const cached = await searchCache.get(cacheKey, "json");
      if (cached) {
        return c.json(cached, 200, { "X-Cache": "HIT" });
      }
    }

    const commitList: { sha: string; message: string; author_name: string; author_email: string; timestamp: number; parents: string[] }[] = [];
    let currentSha: string | null = commitSha;

    while (currentSha && commitList.length < limit) {
      const raw = await storage.getObject(currentSha);
      if (!raw) break;
      const obj = parseGitObject(raw);
      if (obj.type !== "commit") break;
      const commit = parseCommit(obj.content);
      const authorInfo = parseAuthorString(commit.author);

      commitList.push({
        sha: currentSha,
        message: commit.message,
        author_name: authorInfo.name,
        author_email: authorInfo.email,
        timestamp: authorInfo.timestamp,
        parents: commit.parents,
      });

      currentSha = commit.parents[0] || null;
    }

    const hasMore = currentSha !== null && commitList.length >= limit;
    const nextCursor = hasMore ? commitList[commitList.length - 1].sha : null;

    const response = {
      commits: commitList,
      ref: branchName,
      has_more: hasMore,
      next_cursor: nextCursor,
    };

    // Fire-and-forget cache write
    if (searchCache && cacheKey) {
      c.executionCtx.waitUntil(
        searchCache.put(cacheKey, JSON.stringify(response), { expirationTtl: COMMIT_LIST_CACHE_TTL }).catch(() => {}),
      );
    }

    return c.json(response, 200, { "X-Cache": "MISS" });
  } catch (error) {
    console.error("Failed to list commits:", error);
    return c.json({ error: "Failed to list commits" }, 500);
  }
};
commits.get("/:slug/commits", apiKeyAuth, listCommitsHandler);
commits.get("/:namespace/:slug/commits", apiKeyAuth, listCommitsHandler);

// GET /v1/repos/:slug/commits/:sha
const getCommitHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);
  const sha = c.req.param("sha");

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const storage = resolved.storage;
  const raw = await storage.getObject(sha);
  if (!raw) return c.json({ error: "Commit not found" }, 404);

  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return c.json({ error: "Object is not a commit" }, 400);

  const commit = parseCommit(obj.content);
  const authorInfo = parseAuthorString(commit.author);

  return c.json({
    sha,
    message: commit.message,
    tree: commit.tree,
    author_name: authorInfo.name,
    author_email: authorInfo.email,
    timestamp: authorInfo.timestamp,
    parents: commit.parents,
  });
};
commits.get("/:slug/commits/:sha", apiKeyAuth, getCommitHandler);
commits.get("/:namespace/:slug/commits/:sha", apiKeyAuth, getCommitHandler);

export { commits };
