/**
 * File browsing endpoints
 *
 * GET /v1/repos/:slug/tree/:ref/*path  — List directory
 * GET /v1/repos/:slug/blob/:ref/*path  — Read file content
 * GET /v1/repos/:slug/refs             — List branches and tags
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseTree, parseCommit, type TreeEntry } from "../git/objects";
import type { Env, Variables } from "../types";

const files = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Helpers ──

export async function resolveRef(storage: GitR2Storage, ref: string): Promise<string | null> {
  if (ref === "HEAD") return storage.resolveHead();
  const branchSha = await storage.getRef(`refs/heads/${ref}`);
  if (branchSha) return branchSha;
  const tagSha = await storage.getRef(`refs/tags/${ref}`);
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

async function getRepoAndStorage(c: any): Promise<{ found: any; storage: GitR2Storage } | Response> {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const slug = c.req.param("slug");
  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);
  const storage = new GitR2Storage(c.env.REPOS_BUCKET, orgId, slug);
  return { found, storage };
}

// GET /v1/repos/:slug/refs
files.get("/:slug/refs", apiKeyAuth, async (c) => {
  const result = await getRepoAndStorage(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;

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

    return c.json({ branches: branchList, tags: tagList, default_branch: found.defaultBranch });
  } catch (error) {
    console.error("Failed to list refs:", error);
    return c.json({ error: "Failed to list refs" }, 500);
  }
});

// GET /v1/repos/:slug/tree/*
files.get("/:slug/tree/*", apiKeyAuth, async (c) => {
  const result = await getRepoAndStorage(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;
  const slug = c.req.param("slug");

  const url = new URL(c.req.url);
  const treePrefix = `/v1/repos/${slug}/tree/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(treePrefix) + treePrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathStr = parts.slice(1).join("/");
  const pathParts = pathStr.split("/").filter(Boolean);

  try {
    const commitSha = await resolveRef(storage, ref);
    if (!commitSha) return c.json({ error: "Ref not found" }, 404);

    const rootTreeSha = await getTreeFromCommit(storage, commitSha);
    if (!rootTreeSha) return c.json({ error: "Invalid commit" }, 500);

    const treeResult = await navigateToPath(storage, rootTreeSha, pathParts);
    if (!treeResult) return c.json({ error: "Path not found" }, 404);

    const items = treeResult.entries.map((entry) => ({
      name: entry.name,
      path: pathStr ? `${pathStr}/${entry.name}` : entry.name,
      type: entry.mode === "40000" ? "folder" : "file",
      sha: entry.sha,
      mode: entry.mode,
    }));

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({ items, path: pathStr, ref, sha: treeResult.sha });
  } catch (error) {
    console.error("Failed to fetch tree:", error);
    return c.json({ error: "Failed to fetch tree" }, 500);
  }
});

// GET /v1/repos/:slug/blob/*
files.get("/:slug/blob/*", apiKeyAuth, async (c) => {
  const result = await getRepoAndStorage(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;
  const slug = c.req.param("slug");

  const url = new URL(c.req.url);
  const blobPrefix = `/v1/repos/${slug}/blob/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(blobPrefix) + blobPrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathParts = parts.slice(1);
  const pathStr = pathParts.join("/");

  if (!pathStr) return c.json({ error: "File path is required" }, 400);

  try {
    const commitSha = await resolveRef(storage, ref);
    if (!commitSha) return c.json({ error: "Ref not found" }, 404);

    const rootTreeSha = await getTreeFromCommit(storage, commitSha);
    if (!rootTreeSha) return c.json({ error: "Invalid commit" }, 500);

    // Navigate to parent directory
    const dirParts = pathParts.slice(0, -1);
    const fileName = pathParts[pathParts.length - 1];

    let treeEntries: TreeEntry[];
    if (dirParts.length === 0) {
      const raw = await storage.getObject(rootTreeSha);
      if (!raw) return c.json({ error: "Tree not found" }, 500);
      const obj = parseGitObject(raw);
      treeEntries = parseTree(obj.content);
    } else {
      const treeResult = await navigateToPath(storage, rootTreeSha, dirParts);
      if (!treeResult) return c.json({ error: "Directory not found" }, 404);
      treeEntries = treeResult.entries;
    }

    const fileEntry = treeEntries.find((e) => e.name === fileName);
    if (!fileEntry) return c.json({ error: "File not found" }, 404);
    if (fileEntry.mode === "40000") return c.json({ error: "Path is a directory" }, 400);

    const MAX_BLOB_SIZE = 50 * 1024 * 1024; // 50 MB
    const blobData = await storage.getObject(fileEntry.sha);
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
      // Chunk-based base64 to avoid stack overflow on large binary files
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
      sha: fileEntry.sha,
      size: parsed.content.length,
    });
  } catch (error) {
    console.error("Failed to fetch blob:", error);
    return c.json({ error: "Failed to fetch blob" }, 500);
  }
});

export { files };
