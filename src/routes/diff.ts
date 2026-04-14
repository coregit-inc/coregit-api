/**
 * Diff endpoint
 *
 * GET /v1/repos/:slug/diff?base=main&head=feature-x
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { flattenTree, diffFlattenedTrees, computeDiffStatsFromDiffs, type FileDiff } from "../git/cherry-pick";
import { unifiedFileDiff, isBinaryString } from "../services/unified-diff";
import type { Env, Variables } from "../types";

const diff = new Hono<{ Bindings: Env; Variables: Variables }>();

async function resolveRef(storage: GitR2Storage, ref: string): Promise<string | null> {
  // Parallel branch + tag lookup
  const [branchSha, tagSha] = await Promise.all([
    storage.getRef(`refs/heads/${ref}`),
    storage.getRef(`refs/tags/${ref}`),
  ]);
  if (branchSha) return branchSha;
  if (tagSha) return tagSha;
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  return null;
}

async function getTreeSha(storage: GitR2Storage, commitSha: string): Promise<string | null> {
  const raw = await storage.getObject(commitSha);
  if (!raw) return null;
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return null;
  return parseCommit(obj.content).tree;
}

/**
 * Generate unified patch for a single file diff.
 * Returns null for binary files.
 */
async function generatePatch(
  storage: GitR2Storage,
  fileDiff: FileDiff,
  contextLines: number
): Promise<string | null> {
  const MAX_PATCH_SIZE = 1024 * 1024; // 1MB per file

  async function readBlob(sha: string): Promise<{ content: Uint8Array; text: string | null }> {
    const raw = await storage.getObject(sha);
    if (!raw) return { content: new Uint8Array(0), text: "" };
    const obj = parseGitObject(raw);
    if (obj.type !== "blob") return { content: new Uint8Array(0), text: "" };
    if (obj.content.byteLength > MAX_PATCH_SIZE) return { content: obj.content, text: null };
    if (isBinaryString(obj.content)) return { content: obj.content, text: null };
    return { content: obj.content, text: new TextDecoder().decode(obj.content) };
  }

  let oldText: string | null = null;
  let newText: string | null = null;

  if (fileDiff.type === "add") {
    if (!fileDiff.newSha) return null;
    const blob = await readBlob(fileDiff.newSha);
    if (blob.text === null) return "Binary file added";
    oldText = "";
    newText = blob.text;
  } else if (fileDiff.type === "delete") {
    if (!fileDiff.oldSha) return null;
    const blob = await readBlob(fileDiff.oldSha);
    if (blob.text === null) return "Binary file deleted";
    oldText = blob.text;
    newText = "";
  } else {
    // modify
    if (!fileDiff.oldSha || !fileDiff.newSha) return null;
    const [oldBlob, newBlob] = await Promise.all([
      readBlob(fileDiff.oldSha),
      readBlob(fileDiff.newSha),
    ]);
    if (oldBlob.text === null || newBlob.text === null) return "Binary files differ";
    oldText = oldBlob.text;
    newText = newBlob.text;
  }

  const oldPath = fileDiff.type === "add" ? "/dev/null" : fileDiff.path;
  const newPath = fileDiff.type === "delete" ? "/dev/null" : fileDiff.path;
  return unifiedFileDiff(oldPath, newPath, oldText, newText, contextLines) || null;
}

// GET /v1/repos/:slug/diff
const diffHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const baseRef = c.req.query("base");
  const headRef = c.req.query("head");

  if (!baseRef || !headRef) {
    return c.json({ error: "base and head query parameters are required" }, 400);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const storage = resolved.storage;

  const [baseSha, headSha] = await Promise.all([
    resolveRef(storage, baseRef),
    resolveRef(storage, headRef),
  ]);
  if (!baseSha) return c.json({ error: `Base ref '${baseRef}' not found` }, 404);
  if (!headSha) return c.json({ error: `Head ref '${headRef}' not found` }, 404);

  const includePatch = c.req.query("patch") === "true";
  const contextLines = Math.min(parseInt(c.req.query("context") || "3", 10), 20);

  try {
    const [baseTreeSha, headTreeSha] = await Promise.all([
      getTreeSha(storage, baseSha),
      getTreeSha(storage, headSha),
    ]);
    if (!baseTreeSha) return c.json({ error: "Invalid base commit" }, 500);
    if (!headTreeSha) return c.json({ error: "Invalid head commit" }, 500);

    // Shared treeCache: subtrees common to both base and head are fetched once
    const treeCache = new Map();
    const [baseFlat, headFlat] = await Promise.all([
      flattenTree(storage, baseTreeSha, "", treeCache),
      flattenTree(storage, headTreeSha, "", treeCache),
    ]);

    const diffs = diffFlattenedTrees(baseFlat, headFlat);
    const stats = await computeDiffStatsFromDiffs(storage, diffs);

    // Build file list, optionally with unified patch
    const fileList = await Promise.all(diffs.map(async (d) => {
      const file: Record<string, unknown> = {
        path: d.path,
        status: d.type === "add" ? "added" : d.type === "delete" ? "removed" : "modified",
        old_sha: d.oldSha || null,
        new_sha: d.newSha || null,
      };

      if (includePatch) {
        file.patch = await generatePatch(storage, d, contextLines);
      }

      return file;
    }));

    return c.json({
      base: baseSha,
      head: headSha,
      files: fileList,
      total_files_changed: stats.filesChanged,
      total_additions: stats.additions,
      total_deletions: stats.deletions,
    });
  } catch (error) {
    console.error("Failed to compute diff:", error);
    return c.json({ error: "Failed to compute diff" }, 500);
  }
};
diff.get("/:slug/diff", apiKeyAuth, diffHandler);
diff.get("/:namespace/:slug/diff", apiKeyAuth, diffHandler);

export { diff };
