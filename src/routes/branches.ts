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
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { findMergeBase } from "../git/cherry-pick";
import type { Env, Variables } from "../types";

const branches = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Validate a git ref name per git-check-ref-format rules. */
function isValidRefName(name: string): boolean {
  if (!name || name.length > 256) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name.includes("\\") || name.includes(" ") || name.includes("~") || name.includes("^") || name.includes(":") || name.includes("?") || name.includes("*") || name.includes("[")) return false;
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

// POST /v1/repos/:slug/branches
branches.post("/:slug/branches", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

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

  const storage = new GitR2Storage(bucket, orgId, slug);

  try {
    // Determine source SHA
    let sourceSha: string | null = null;
    if (from_sha) {
      // Create from specific commit
      const exists = await storage.hasObject(from_sha);
      if (!exists) return c.json({ error: "from_sha not found" }, 404);
      sourceSha = from_sha;
    } else {
      // Create from branch (default: repo's default branch)
      const sourceBranch = from || found.defaultBranch;
      sourceSha = await storage.getRef(`refs/heads/${sourceBranch}`);
      if (!sourceSha) {
        return c.json({ error: `Source branch '${sourceBranch}' not found` }, 404);
      }
    }

    // Check if branch already exists
    const existing = await storage.getRef(`refs/heads/${name}`);
    if (existing) {
      return c.json({ error: `Branch '${name}' already exists` }, 409);
    }

    await storage.setRef(`refs/heads/${name}`, sourceSha);

    return c.json({ name, sha: sourceSha, created: true }, 201);
  } catch (error) {
    console.error("Failed to create branch:", error);
    return c.json({ error: "Failed to create branch" }, 500);
  }
});

// GET /v1/repos/:slug/branches
branches.get("/:slug/branches", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

  const storage = new GitR2Storage(bucket, orgId, slug);

  try {
    const refs = await storage.listRefs();
    const branchList: { name: string; sha: string }[] = [];

    for (const [refName, sha] of refs) {
      if (refName.startsWith("refs/heads/")) {
        branchList.push({ name: refName.slice(11), sha });
      }
    }

    branchList.sort((a, b) => a.name.localeCompare(b.name));

    return c.json({ branches: branchList, default_branch: found.defaultBranch });
  } catch (error) {
    console.error("Failed to list branches:", error);
    return c.json({ error: "Failed to list branches" }, 500);
  }
});

// GET /v1/repos/:slug/branches/:name
branches.get("/:slug/branches/:name", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, name } = c.req.param();

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

  const storage = new GitR2Storage(bucket, orgId, slug);
  const sha = await storage.getRef(`refs/heads/${name}`);
  if (!sha) return c.json({ error: "Branch not found" }, 404);

  return c.json({ name, sha });
});

// DELETE /v1/repos/:slug/branches/:name
branches.delete("/:slug/branches/:name", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, name } = c.req.param();

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

  if (name === found.defaultBranch) {
    return c.json({ error: "Cannot delete the default branch" }, 400);
  }

  const storage = new GitR2Storage(bucket, orgId, slug);
  const sha = await storage.getRef(`refs/heads/${name}`);
  if (!sha) return c.json({ error: "Branch not found" }, 404);

  await storage.deleteRef(`refs/heads/${name}`);
  return c.json({ deleted: true, name });
});

// POST /v1/repos/:slug/branches/:name/merge
branches.post("/:slug/branches/:name/merge", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, name } = c.req.param();

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

  let body: { target?: string; strategy?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const target = body.target || found.defaultBranch;

  const storage = new GitR2Storage(bucket, orgId, slug);
  const sourceSha = await storage.getRef(`refs/heads/${name}`);
  if (!sourceSha) return c.json({ error: `Source branch '${name}' not found` }, 404);

  const targetSha = await storage.getRef(`refs/heads/${target}`);
  if (!targetSha) return c.json({ error: `Target branch '${target}' not found` }, 404);

  if (sourceSha === targetSha) {
    return c.json({ merged: true, sha: targetSha, strategy: "already_up_to_date" });
  }

  try {
    // Verify fast-forward: target must be ancestor of source
    const mergeBase = await findMergeBase(storage, sourceSha, targetSha);
    if (mergeBase !== targetSha) {
      return c.json(
        { error: "Cannot fast-forward. Target has diverged from source." },
        409
      );
    }

    await storage.setRef(`refs/heads/${target}`, sourceSha);
    return c.json({ merged: true, sha: sourceSha, strategy: "fast-forward" });
  } catch (error) {
    console.error("Failed to merge:", error);
    return c.json({ error: "Failed to merge branch" }, 500);
  }
});

export { branches };
