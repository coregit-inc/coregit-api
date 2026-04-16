/**
 * Branch management endpoints
 *
 * POST   /v1/repos/:slug/branches                — Create branch
 * GET    /v1/repos/:slug/branches                — List branches
 * GET    /v1/repos/:slug/branches/:name           — Get branch
 * DELETE /v1/repos/:slug/branches/:name           — Delete branch
 * POST   /v1/repos/:slug/branches/:name/merge     — Merge branch
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { GitR2Storage } from "../git/storage";
import {
  findMergeBase,
  getCommitRange,
  cherryPickCommits,
  flattenTree,
  diffFlattenedTrees,
  applyDiffsToTree,
  buildTreeFromFlat,
  type FlatTree,
} from "../git/cherry-pick";
import {
  parseGitObject,
  parseCommit,
  createCommit,
  hashGitObject,
} from "../git/objects";
import { isValidRefName } from "../git/validation";
import { recordAudit } from "../services/audit";
import type { Env, Variables } from "../types";

const branches = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /v1/repos/:slug/branches
const createBranchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  let body: { name: string; from?: string; from_sha?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { name, from, from_sha } = body;
  if (!name || typeof name !== "string") {
    return c.json({ error: "Branch name is required" }, 400);
  }
  if (!isValidRefName(name)) {
    return c.json({ error: "Invalid branch name" }, 400);
  }

  try {
    // Parallel: resolve source + check if target branch already exists (2 R2 reads → 1 round-trip)
    let sourceSha: string | null = null;
    if (from_sha) {
      // from_sha: verify existence + check target in parallel
      const [exists, existing] = await Promise.all([
        storage.hasObject(from_sha),
        storage.getRef(`refs/heads/${name}`),
      ]);
      if (!exists) return c.json({ error: "from_sha not found" }, 404);
      if (existing) return c.json({ error: `Branch '${name}' already exists` }, 409);
      sourceSha = from_sha;
    } else {
      // from branch: resolve source ref + check target in parallel
      const sourceBranch = from || found.defaultBranch;
      const [sourceRef, existing] = await Promise.all([
        storage.getRef(`refs/heads/${sourceBranch}`),
        storage.getRef(`refs/heads/${name}`),
      ]);
      if (!sourceRef) {
        return c.json({ error: `Source branch '${sourceBranch}' not found` }, 404);
      }
      if (existing) return c.json({ error: `Branch '${name}' already exists` }, 409);
      sourceSha = sourceRef;
    }

    await storage.setRef(`refs/heads/${name}`, sourceSha);

    recordAudit(c.executionCtx, db, {
      orgId, actorId: c.get("apiKeyId"),
      actorType: c.get("apiKeyPermissions") === null ? "master_key" : "scoped_token",
      action: "branch.create", resourceType: "branch", resourceId: name,
      metadata: { repo: slug, sha: sourceSha }, requestId: c.get("requestId"),
    });

    return c.json({ name, sha: sourceSha, created: true }, 201);
  } catch (error) {
    console.error("Failed to create branch:", error);
    return c.json({ error: "Failed to create branch" }, 500);
  }
};
branches.post("/:slug/branches", apiKeyAuth, createBranchHandler);
branches.post("/:namespace/:slug/branches", apiKeyAuth, createBranchHandler);

// GET /v1/repos/:slug/branches
const listBranchesHandler = async (c: any) => {
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
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const cursor = c.req.query("cursor"); // branch name to start after (alphabetical)

  try {
    const refs = await storage.listRefs();
    const branchList: { name: string; sha: string }[] = [];

    for (const [refName, sha] of refs) {
      if (refName.startsWith("refs/heads/")) {
        branchList.push({ name: refName.slice(11), sha });
      }
    }

    branchList.sort((a, b) => a.name.localeCompare(b.name));

    // Apply cursor: skip branches <= cursor name
    let startIdx = 0;
    if (cursor) {
      startIdx = branchList.findIndex((b) => b.name > cursor);
      if (startIdx === -1) startIdx = branchList.length;
    }

    const page = branchList.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < branchList.length;
    const nextCursor = hasMore ? page[page.length - 1].name : null;

    return c.json({
      branches: page,
      default_branch: found.defaultBranch,
      total: branchList.length,
      next_cursor: nextCursor,
    });
  } catch (error) {
    console.error("Failed to list branches:", error);
    return c.json({ error: "Failed to list branches" }, 500);
  }
};
branches.get("/:slug/branches", apiKeyAuth, listBranchesHandler);
branches.get("/:namespace/:slug/branches", apiKeyAuth, listBranchesHandler);

// GET /v1/repos/:slug/branches/:name
const getBranchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);
  const name = c.req.param("name");

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const storage = resolved.storage;
  const sha = await storage.getRef(`refs/heads/${name}`);
  if (!sha) return c.json({ error: "Branch not found" }, 404);

  return c.json({ name, sha });
};
branches.get("/:slug/branches/:name", apiKeyAuth, getBranchHandler);
branches.get("/:namespace/:slug/branches/:name", apiKeyAuth, getBranchHandler);

// DELETE /v1/repos/:slug/branches/:name
const deleteBranchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);
  const name = c.req.param("name");

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  if (name === found.defaultBranch) {
    return c.json({ error: "Cannot delete the default branch" }, 400);
  }

  const sha = await storage.getRef(`refs/heads/${name}`);
  if (!sha) return c.json({ error: "Branch not found" }, 404);

  await storage.deleteRef(`refs/heads/${name}`);

  recordAudit(c.executionCtx, db, {
    orgId, actorId: c.get("apiKeyId"),
    actorType: c.get("apiKeyPermissions") === null ? "master_key" : "scoped_token",
    action: "branch.delete", resourceType: "branch", resourceId: name,
    metadata: { repo: slug }, requestId: c.get("requestId"),
  });

  return c.json({ deleted: true, name });
};
branches.delete("/:slug/branches/:name", apiKeyAuth, deleteBranchHandler);
branches.delete("/:namespace/:slug/branches/:name", apiKeyAuth, deleteBranchHandler);

async function getTreeSha(storage: GitR2Storage, commitSha: string): Promise<string | null> {
  const raw = await storage.getObject(commitSha);
  if (!raw) return null;
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return null;
  return parseCommit(obj.content).tree;
}

// POST /v1/repos/:slug/branches/:name/merge
const mergeBranchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);
  const name = c.req.param("name");

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  let body: {
    source: string;
    strategy?: "fast-forward" | "merge-commit" | "squash";
    message?: string;
    author?: { name: string; email: string };
    expected_sha?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const target = name;
  const source = body.source;
  const strategy = body.strategy || "fast-forward";

  if (!source) {
    return c.json({ error: "Source branch is required (body.source)" }, 400);
  }

  if (!["fast-forward", "merge-commit", "squash"].includes(strategy)) {
    return c.json({ error: "Invalid strategy. Must be: fast-forward, merge-commit, or squash" }, 400);
  }

  const sourceSha = await storage.getRef(`refs/heads/${source}`);
  if (!sourceSha) return c.json({ error: `Source branch '${source}' not found` }, 404);

  const targetRef = await storage.getRefWithEtag(`refs/heads/${target}`);
  if (!targetRef) return c.json({ error: `Target branch '${target}' not found` }, 404);
  const targetSha = targetRef.sha;

  // Optional CAS: verify target hasn't moved
  if (body.expected_sha && targetSha !== body.expected_sha) {
    return c.json({
      error: "Target branch was updated concurrently (expected_sha mismatch)",
      current_sha: targetSha,
    }, 409);
  }

  if (sourceSha === targetSha) {
    return c.json({ merged: true, sha: targetSha, strategy: "already_up_to_date" });
  }

  try {
    const mergeBase = await findMergeBase(storage, sourceSha, targetSha);

    // ── Fast-forward ──
    if (strategy === "fast-forward") {
      if (mergeBase !== targetSha) {
        return c.json(
          { error: "Cannot fast-forward. Target has diverged from source." },
          409
        );
      }

      const ok = await storage.setRefConditional(`refs/heads/${target}`, sourceSha, targetRef.etag);
      if (!ok) {
        return c.json({ error: "Branch was updated concurrently, retry merge" }, 409);
      }
      return c.json({ merged: true, sha: sourceSha, strategy: "fast-forward" });
    }

    if (!mergeBase) {
      return c.json({ error: "No common ancestor found between branches" }, 422);
    }

    const now = Math.floor(Date.now() / 1000);
    const authorLine = body.author
      ? `${body.author.name} <${body.author.email}> ${now} +0000`
      : `Coregit <noreply@coregit.dev> ${now} +0000`;

    // ── Merge-commit ──
    if (strategy === "merge-commit") {
      // Cherry-pick source commits onto target to produce the merged tree
      const sourceCommits = await getCommitRange(storage, mergeBase, sourceSha);
      const result = await cherryPickCommits(storage, sourceCommits, targetSha);

      if (!result.success) {
        return c.json({
          merged: false,
          strategy: "merge-commit",
          conflicts: result.conflicts || [],
        }, 409);
      }

      // Get the merged tree SHA from the cherry-picked head
      const mergedTreeSha = await getTreeSha(storage, result.headSha!);
      if (!mergedTreeSha) {
        return c.json({ error: "Failed to resolve merged tree" }, 500);
      }

      // Create merge commit with two parents
      const mergeMessage = body.message || `Merge branch '${source}' into ${target}`;
      const mergeCommitContent = createCommit({
        tree: mergedTreeSha,
        parents: [targetSha, sourceSha],
        author: authorLine,
        committer: authorLine,
        message: mergeMessage,
      });
      const mergeCommitSha = await hashGitObject("commit", mergeCommitContent);
      await storage.putObject(mergeCommitSha, "commit", mergeCommitContent);

      // Update target ref with CAS
      const ok = await storage.setRefConditional(`refs/heads/${target}`, mergeCommitSha, targetRef.etag);
      if (!ok) {
        return c.json({ error: "Branch was updated concurrently, retry merge" }, 409);
      }

      return c.json({
        merged: true,
        sha: mergeCommitSha,
        strategy: "merge-commit",
        merge_sha: mergeCommitSha,
      });
    }

    // ── Squash ──
    if (strategy === "squash") {
      const treeCache = new Map<string, FlatTree>();

      // Get merge-base tree, source tree, and target tree
      const [mergeBaseTreeSha, sourceTreeSha, targetTreeSha] = await Promise.all([
        getTreeSha(storage, mergeBase),
        getTreeSha(storage, sourceSha),
        getTreeSha(storage, targetSha),
      ]);

      if (!mergeBaseTreeSha || !sourceTreeSha || !targetTreeSha) {
        return c.json({ error: "Failed to resolve commit trees" }, 500);
      }

      // Diff: what changed in source since merge-base
      const kvCache = c.env.TREE_CACHE as KVNamespace | undefined;
      const [mergeBaseFlat, sourceFlat] = await Promise.all([
        flattenTree(storage, mergeBaseTreeSha, "", treeCache, kvCache),
        flattenTree(storage, sourceTreeSha, "", treeCache, kvCache),
      ]);
      const diffs = diffFlattenedTrees(mergeBaseFlat, sourceFlat);

      if (diffs.length === 0) {
        return c.json({ merged: true, sha: targetSha, strategy: "already_up_to_date" });
      }

      // Apply those diffs onto the target tree (with 3-way conflict detection)
      const { treeSha, conflicts } = await applyDiffsToTree(
        storage, targetTreeSha, diffs, mergeBaseTreeSha, treeCache
      );

      if (conflicts.length > 0) {
        return c.json({
          merged: false,
          strategy: "squash",
          conflicts,
        }, 409);
      }

      // Create squash commit (single parent = target)
      const squashMessage = body.message || `Squash merge branch '${source}' into ${target}`;
      const squashCommitContent = createCommit({
        tree: treeSha!,
        parents: [targetSha],
        author: authorLine,
        committer: authorLine,
        message: squashMessage,
      });
      const squashCommitSha = await hashGitObject("commit", squashCommitContent);
      await storage.putObject(squashCommitSha, "commit", squashCommitContent);

      // Update target ref with CAS
      const ok = await storage.setRefConditional(`refs/heads/${target}`, squashCommitSha, targetRef.etag);
      if (!ok) {
        return c.json({ error: "Branch was updated concurrently, retry merge" }, 409);
      }

      return c.json({
        merged: true,
        sha: squashCommitSha,
        strategy: "squash",
      });
    }
  } catch (error) {
    console.error("Failed to merge:", error);
    return c.json({ error: "Failed to merge branch" }, 500);
  }
};
branches.post("/:slug/branches/:name/merge", apiKeyAuth, mergeBranchHandler);
branches.post("/:namespace/:slug/branches/:name/merge", apiKeyAuth, mergeBranchHandler);

export { branches };
