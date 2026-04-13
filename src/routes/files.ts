/**
 * File browsing endpoints
 *
 * GET /v1/repos/:slug/tree/:ref/*path  — List directory
 * GET /v1/repos/:slug/blob/:ref/*path  — Read file content
 * GET /v1/repos/:slug/refs             — List branches and tags
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseTree, parseCommit, type TreeEntry } from "../git/objects";
import { getTreeBlobShas } from "../services/tree-resolver";
import type { Env, Variables } from "../types";

const files = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Helpers ──

export async function resolveRef(storage: GitR2Storage, ref: string): Promise<string | null> {
  if (ref === "HEAD") return storage.resolveHead();
  // Parallel branch + tag lookup (2 R2 reads → 1 round-trip)
  const [branchSha, tagSha] = await Promise.all([
    storage.getRef(`refs/heads/${ref}`),
    storage.getRef(`refs/tags/${ref}`),
  ]);
  if (branchSha) return branchSha;
  if (tagSha) return tagSha;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const exists = await storage.hasObject(ref);
    if (exists) return ref;
  }
  return null;
}

export async function getTreeFromCommit(storage: GitR2Storage, commitSha: string): Promise<string | null> {
  const raw = await storage.getObject(commitSha);
  if (!raw) return null;
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return null;
  return parseCommit(obj.content).tree;
}

export async function navigateToPath(
  storage: GitR2Storage,
  treeSha: string,
  pathParts: string[]
): Promise<{ entries: TreeEntry[]; sha: string } | null> {
  let currentSha = treeSha;
  for (const part of pathParts) {
    if (!part) continue;
    const raw = await storage.getObject(currentSha);
    if (!raw) return null;
    const obj = parseGitObject(raw);
    if (obj.type !== "tree") return null;
    const entries = parseTree(obj.content);
    const entry = entries.find((e) => e.name === part);
    if (!entry || entry.mode !== "40000") return null;
    currentSha = entry.sha;
  }
  const raw = await storage.getObject(currentSha);
  if (!raw) return null;
  const obj = parseGitObject(raw);
  if (obj.type !== "tree") return null;
  return { entries: parseTree(obj.content), sha: currentSha };
}

export function isBinaryContent(content: Uint8Array): boolean {
  const len = Math.min(content.length, 8192);
  for (let i = 0; i < len; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

export async function flattenTreeRecursive(
  storage: GitR2Storage,
  entries: TreeEntry[],
  basePath: string,
  out: { name: string; path: string; type: string; sha: string; mode: string }[],
  limit: number,
): Promise<void> {
  for (const entry of entries) {
    if (out.length >= limit) return;
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.mode === "40000") {
      // Directory — recurse into it
      out.push({ name: entry.name, path: entryPath, type: "folder", sha: entry.sha, mode: entry.mode });
      if (out.length >= limit) return;
      const raw = await storage.getObject(entry.sha);
      if (raw) {
        const obj = parseGitObject(raw);
        if (obj.type === "tree") {
          const subEntries = parseTree(obj.content);
          await flattenTreeRecursive(storage, subEntries, entryPath, out, limit);
        }
      }
    } else {
      out.push({ name: entry.name, path: entryPath, type: "file", sha: entry.sha, mode: entry.mode });
    }
  }
}

// GET /v1/repos/:slug/refs
const listRefsHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);
  if (c.get("sessionStub")) resolved.storage.setSessionStub(c.get("sessionStub") as DurableObjectStub);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const cursor = c.req.query("cursor"); // full ref name to start after

  try {
    const refs = await storage.listRefs();
    const branchList: { name: string; sha: string; type: string }[] = [];
    const tagList: { name: string; sha: string; type: string }[] = [];

    for (const [refName, sha] of refs) {
      if (refName.startsWith("refs/heads/")) {
        branchList.push({ name: refName.slice(11), sha, type: "branch" });
      } else if (refName.startsWith("refs/tags/")) {
        tagList.push({ name: refName.slice(10), sha, type: "tag" });
      }
    }

    branchList.sort((a, b) => a.name.localeCompare(b.name));
    tagList.sort((a, b) => a.name.localeCompare(b.name));

    // Combine into single sorted list for pagination
    const allRefs = [
      ...branchList.map((b) => ({ ...b, sortKey: `branch:${b.name}` })),
      ...tagList.map((t) => ({ ...t, sortKey: `tag:${t.name}` })),
    ];
    allRefs.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    let startIdx = 0;
    if (cursor) {
      startIdx = allRefs.findIndex((r) => r.sortKey > cursor);
      if (startIdx === -1) startIdx = allRefs.length;
    }

    const page = allRefs.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < allRefs.length;
    const nextCursor = hasMore ? page[page.length - 1].sortKey : null;

    // Split page back into branches and tags for response
    const pageBranches = page.filter((r) => r.type === "branch").map(({ name, sha, type }) => ({ name, sha, type }));
    const pageTags = page.filter((r) => r.type === "tag").map(({ name, sha, type }) => ({ name, sha, type }));

    return c.json({
      branches: pageBranches,
      tags: pageTags,
      default_branch: found.defaultBranch,
      total: allRefs.length,
      next_cursor: nextCursor,
    });
  } catch (error) {
    console.error("Failed to list refs:", error);
    return c.json({ error: "Failed to list refs" }, 500);
  }
};
files.get("/:slug/refs", apiKeyAuth, listRefsHandler);
files.get("/:namespace/:slug/refs", apiKeyAuth, listRefsHandler);

// GET /v1/repos/:slug/tree/*
const treeHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);
  if (c.get("sessionStub")) resolved.storage.setSessionStub(c.get("sessionStub") as DurableObjectStub);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  const url = new URL(c.req.url);
  // Build the prefix dynamically based on namespace
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  const treePrefix = `/v1/repos/${repoPath}/tree/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(treePrefix) + treePrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathStr = parts.slice(1).join("/");
  const pathParts = pathStr.split("/").filter(Boolean);

  const recursive = c.req.query("recursive") === "true";

  try {
    const commitSha = await resolveRef(storage, ref);
    if (!commitSha) return c.json({ error: "Ref not found" }, 404);

    const rootTreeSha = await getTreeFromCommit(storage, commitSha);
    if (!rootTreeSha) return c.json({ error: "Invalid commit" }, 500);

    const treeResult = await navigateToPath(storage, rootTreeSha, pathParts);
    if (!treeResult) return c.json({ error: "Path not found" }, 404);

    // ETag: tree SHA is content-addressed and immutable
    const etag = `"${treeResult.sha}"`;
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    // Determine Cache-Control: immutable for commit SHA refs, short cache for branch/tag
    const isCommitSha = /^[0-9a-f]{40}$/i.test(ref);
    const cacheControl = isCommitSha
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60";

    let items: { name: string; path: string; type: string; sha: string; mode: string }[];
    let truncated = false;

    if (recursive) {
      const RECURSIVE_LIMIT = 10_000;
      const flatItems: typeof items = [];
      await flattenTreeRecursive(storage, treeResult.entries, pathStr, flatItems, RECURSIVE_LIMIT);
      truncated = flatItems.length >= RECURSIVE_LIMIT;
      items = flatItems;
    } else {
      items = treeResult.entries.map((entry) => ({
        name: entry.name,
        path: pathStr ? `${pathStr}/${entry.name}` : entry.name,
        type: entry.mode === "40000" ? "folder" : "file",
        sha: entry.sha,
        mode: entry.mode,
      }));
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json(
      { items, path: pathStr, ref, sha: treeResult.sha, truncated },
      200,
      { "ETag": etag, "Cache-Control": cacheControl },
    );
  } catch (error) {
    console.error("Failed to fetch tree:", error);
    return c.json({ error: "Failed to fetch tree" }, 500);
  }
};
files.get("/:slug/tree/*", apiKeyAuth, treeHandler);
files.get("/:namespace/:slug/tree/*", apiKeyAuth, treeHandler);

// GET /v1/repos/:slug/blob/*
//
// Optimized read path:
// 1. Resolve ref → commitSha (1 R2 read)
// 2. getTreeBlobShas() — KV cached flat tree (0 R2 reads on cache hit)
// 3. Lookup file path in flat map → get blobSha (in-memory)
// 4. getObject(blobSha) — 1 R2 read
// Total: 2 R2 reads (was 5-8 with tree navigation)
const blobHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);
  if (c.get("sessionStub")) resolved.storage.setSessionStub(c.get("sessionStub") as DurableObjectStub);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  const url = new URL(c.req.url);
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  const blobPrefix = `/v1/repos/${repoPath}/blob/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(blobPrefix) + blobPrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathParts = parts.slice(1);
  const pathStr = pathParts.join("/");

  if (!pathStr) return c.json({ error: "File path is required" }, 400);

  try {
    // 1. Resolve ref → commitSha (1 R2 read)
    const commitSha = await resolveRef(storage, ref);
    if (!commitSha) return c.json({ error: "Ref not found" }, 404);

    // 2. Get flat tree from KV cache (0 R2 reads on hit, flattens on miss)
    // Returns Map<blobSha, filePath> — skips all tree navigation
    const treeBlobMap = await getTreeBlobShas(storage, commitSha, c.env.TREE_CACHE);

    // 3. Find file by path (in-memory lookup, no R2)
    let fileSha: string | null = null;
    for (const [sha, path] of treeBlobMap) {
      if (path === pathStr) {
        fileSha = sha;
        break;
      }
    }

    if (!fileSha) return c.json({ error: "File not found" }, 404);

    // ETag: git objects are immutable by SHA — cache forever
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === `"${fileSha}"`) {
      return new Response(null, { status: 304 });
    }

    // 4. Read blob (1 R2 read)
    const MAX_BLOB_SIZE = 50 * 1024 * 1024;
    const blobData = await storage.getObject(fileSha);
    if (!blobData) return c.json({ error: "Blob not found" }, 500);
    if (blobData.byteLength > MAX_BLOB_SIZE) {
      return c.json({ error: "File exceeds 50 MB size limit", size: blobData.byteLength }, 400);
    }

    const parsed = parseGitObject(blobData);
    if (parsed.type !== "blob") return c.json({ error: "Invalid blob" }, 500);

    const binary = isBinaryContent(parsed.content);
    let content: string;
    let encoding: "utf-8" | "base64";

    if (binary) {
      const chunkSize = 8192;
      let binaryStr = '';
      for (let i = 0; i < parsed.content.length; i += chunkSize) {
        const chunk = parsed.content.subarray(i, Math.min(i + chunkSize, parsed.content.length));
        binaryStr += String.fromCharCode.apply(null, chunk as unknown as number[]);
      }
      content = btoa(binaryStr);
      encoding = "base64";
    } else {
      content = new TextDecoder().decode(parsed.content);
      encoding = "utf-8";
    }

    return c.json({
      content,
      encoding,
      path: pathStr,
      sha: fileSha,
      size: parsed.content.length,
    }, 200, {
      "ETag": `"${fileSha}"`,
      "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
    });
  } catch (error) {
    console.error("Failed to fetch blob:", error);
    return c.json({ error: "Failed to fetch blob" }, 500);
  }
};
files.get("/:slug/blob/*", apiKeyAuth, blobHandler);
files.get("/:namespace/:slug/blob/*", apiKeyAuth, blobHandler);

export { files };
