/**
 * Ref management endpoints — low-level ref CRUD with CAS
 *
 * GET    /v1/repos/:slug/refs             — List all refs
 * GET    /v1/repos/:slug/refs/*           — Get single ref
 * PUT    /v1/repos/:slug/refs/*           — Update ref (with optional CAS)
 * DELETE /v1/repos/:slug/refs/*           — Delete ref
 *
 * These are low-level primitives for platforms that need direct control
 * over branch/tag pointers with atomic compare-and-swap guarantees.
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { isValidRefPath, isValidSha } from "../git/validation";

import { checkFreeLimits } from "../services/limits";
import type { Env, Variables } from "../types";

const refs = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Extract the ref path from the URL wildcard.
 * Handles both /:slug/refs/* and /:namespace/:slug/refs/* patterns.
 * e.g. /v1/repos/my-repo/refs/heads/main → "refs/heads/main"
 * e.g. /v1/repos/my-ns/my-repo/refs/heads/main → "refs/heads/main"
 */
function extractRefPath(c: any, slug: string, namespace: string | null): string {
  const fullPath = c.req.path;
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  const marker = `/repos/${repoPath}/refs/`;
  const idx = fullPath.indexOf(marker);
  if (idx === -1) return "";
  return "refs/" + fullPath.slice(idx + marker.length);
}

// GET /v1/repos/:slug/refs — list all refs
const listRefsHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const storage = resolved.storage;
  const allRefs = await storage.listRefs();

  const result: { ref: string; sha: string }[] = [];
  for (const [name, sha] of allRefs) {
    result.push({ ref: name, sha });
  }

  return c.json({ refs: result });
};
refs.get("/:slug/refs", apiKeyAuth, listRefsHandler);
refs.get("/:namespace/:slug/refs", apiKeyAuth, listRefsHandler);

// GET /v1/repos/:slug/refs/* — get single ref
const getRefHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const refPath = extractRefPath(c, slug, namespace);

  if (!refPath || refPath === "refs/") {
    return c.json({ error: "Ref path is required" }, 400);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const storage = resolved.storage;
  const sha = await storage.getRef(refPath);
  if (!sha) return c.json({ error: `Ref '${refPath}' not found` }, 404);

  return c.json({ ref: refPath, sha });
};
refs.get("/:slug/refs/*", apiKeyAuth, getRefHandler);
refs.get("/:namespace/:slug/refs/*", apiKeyAuth, getRefHandler);

// PUT /v1/repos/:slug/refs/* — update ref (with optional CAS)
const updateRefHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const refPath = extractRefPath(c, slug, namespace);

  if (!refPath || refPath === "refs/") {
    return c.json({ error: "Ref path is required" }, 400);
  }

  if (!isValidRefPath(refPath)) {
    return c.json({ error: "Invalid ref path. Must be refs/heads/* or refs/tags/*" }, 400);
  }

  // Free tier check
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

  const storage = resolved.storage;

  let body: { sha: string; expected_sha?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { sha, expected_sha } = body;

  if (!sha || !isValidSha(sha)) {
    return c.json({ error: "Valid 40-char hex SHA is required" }, 400);
  }

  // Verify the target object exists
  const exists = await storage.hasObject(sha);
  if (!exists) return c.json({ error: `Object '${sha}' not found` }, 404);

  let previousSha: string | null = null;

  if (expected_sha) {
    // CAS update
    if (!isValidSha(expected_sha)) {
      return c.json({ error: "Invalid expected_sha format" }, 400);
    }

    const current = await storage.getRefWithEtag(refPath);
    if (!current) {
      return c.json({ error: `Ref '${refPath}' not found (cannot CAS a non-existent ref)` }, 404);
    }

    if (current.sha !== expected_sha) {
      return c.json({
        error: "Ref was updated concurrently (expected_sha mismatch)",
        current_sha: current.sha,
      }, 409);
    }

    const ok = await storage.setRefConditional(refPath, sha, current.etag);
    if (!ok) {
      return c.json({ error: "Ref was updated concurrently, retry" }, 409);
    }
    previousSha = current.sha;
  } else {
    // Plain set — get previous value for response
    const current = await storage.getRef(refPath);
    previousSha = current;
    await storage.setRef(refPath, sha);
  }

  return c.json({
    ref: refPath,
    sha,
    previous_sha: previousSha,
  });
};
refs.put("/:slug/refs/*", apiKeyAuth, updateRefHandler);
refs.put("/:namespace/:slug/refs/*", apiKeyAuth, updateRefHandler);

// DELETE /v1/repos/:slug/refs/* — delete ref
const deleteRefHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const refPath = extractRefPath(c, slug, namespace);

  if (!refPath || refPath === "refs/") {
    return c.json({ error: "Ref path is required" }, 400);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  // Prevent deleting default branch
  if (refPath === `refs/heads/${found.defaultBranch}`) {
    return c.json({ error: "Cannot delete the default branch" }, 400);
  }

  const sha = await storage.getRef(refPath);
  if (!sha) return c.json({ error: `Ref '${refPath}' not found` }, 404);

  await storage.deleteRef(refPath);

  return c.json({ deleted: true, ref: refPath, sha });
};
refs.delete("/:slug/refs/*", apiKeyAuth, deleteRefHandler);
refs.delete("/:namespace/:slug/refs/*", apiKeyAuth, deleteRefHandler);

export { refs };
