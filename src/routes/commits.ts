/**
 * Commit endpoints
 *
 * POST /v1/repos/:slug/commits       — Create commit via API (no git push needed)
 * GET  /v1/repos/:slug/commits       — List commits
 * GET  /v1/repos/:slug/commits/:sha  — Get single commit
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { createApiCommit, ConflictError, type FileChange, type CommitAuthor } from "../services/commit-builder";
import { recordUsage } from "../services/usage";
import { checkFreeLimits } from "../services/limits";
import type { Env, Variables } from "../types";

const commits = new Hono<{ Bindings: Env; Variables: Variables }>();

export function parseAuthorString(author: string): { name: string; email: string; timestamp: number } {
  const match = author.match(/^(.+?)\s+<([^>]+)>\s+(\d+)/);
  if (match) {
    return { name: match[1], email: match[2], timestamp: parseInt(match[3], 10) };
  }
  return { name: author, email: "", timestamp: 0 };
}

// POST /v1/repos/:slug/commits
commits.post("/:slug/commits", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();

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

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

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
  if (!message) return c.json({ error: "message is required" }, 400);
  if (!author?.name || !author?.email) return c.json({ error: "author.name and author.email are required" }, 400);
  if (!changes || !Array.isArray(changes) || changes.length === 0) {
    return c.json({ error: "changes array is required and must not be empty" }, 400);
  }
  if (changes.length > 1000) {
    return c.json({ error: "Maximum 1000 file changes per commit" }, 400);
  }
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  for (const change of changes) {
    if (change.content && change.content.length > MAX_FILE_SIZE) {
      return c.json({ error: `File content exceeds 10 MB limit: ${change.path}` }, 400);
    }
  }

  const storage = new GitR2Storage(bucket, orgId, slug);

  try {
    const result = await createApiCommit(storage, branch, message, author, changes, parent_sha);

    recordUsage(c.executionCtx, db, orgId, "api_call", 1, {
      operation: "commit",
      repo_slug: slug,
    }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));

    return c.json(
      {
        sha: result.sha,
        tree_sha: result.treeSha,
        branch,
        parent: result.parentSha,
      },
      201
    );
  } catch (error) {
    if (error instanceof ConflictError) {
      return c.json({ error: error.message }, 409);
    }
    console.error("Failed to create commit:", error);
    return c.json({ error: "Failed to create commit" }, 500);
  }
});

// GET /v1/repos/:slug/commits
commits.get("/:slug/commits", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();
  const ref = c.req.query("ref") || c.req.query("branch");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

  const storage = new GitR2Storage(bucket, orgId, slug);
  const branchName = ref || found.defaultBranch;
  let commitSha = await storage.getRef(`refs/heads/${branchName}`);

  // Try as raw SHA
  if (!commitSha && branchName && /^[0-9a-f]{40}$/i.test(branchName)) {
    commitSha = branchName;
  }

  if (!commitSha) return c.json({ error: "Ref not found" }, 404);

  try {
    const commitList: any[] = [];
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

    return c.json({
      commits: commitList,
      ref: branchName,
      has_more: currentSha !== null && commitList.length >= limit,
    });
  } catch (error) {
    console.error("Failed to list commits:", error);
    return c.json({ error: "Failed to list commits" }, 500);
  }
});

// GET /v1/repos/:slug/commits/:sha
commits.get("/:slug/commits/:sha", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, sha } = c.req.param();

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

  const storage = new GitR2Storage(bucket, orgId, slug);
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
});

export { commits };
