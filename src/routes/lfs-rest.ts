/**
 * LFS REST API — standard /v1/repos/:slug/lfs/* endpoints with x-api-key auth.
 *
 * These wrap the same underlying data as the Git LFS protocol endpoints,
 * but use the standard CoreGit REST pattern for SDK/dashboard access.
 *
 * GET  /v1/repos/:slug/lfs/objects       — List LFS objects for a repo
 * GET  /v1/repos/:slug/lfs/locks         — List locks
 * POST /v1/repos/:slug/lfs/locks         — Create lock
 * POST /v1/repos/:slug/lfs/locks/verify  — Verify locks (ours vs theirs)
 * POST /v1/repos/:slug/lfs/locks/:id/unlock — Unlock
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess, isMasterKey } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { lfsObject, lfsLock } from "../db/schema";
import type { Env, Variables } from "../types";

const lfsRest = new Hono<{ Bindings: Env; Variables: Variables }>();

function lockToJson(lock: any) {
  return {
    id: lock.id,
    path: lock.path,
    locked_at: lock.lockedAt.toISOString(),
    owner: { name: lock.ownerName },
  };
}

// ── List LFS Objects ──

const listObjectsHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const cursor = c.req.query("cursor");

  const whereClause = cursor
    ? and(eq(lfsObject.repoId, resolved.repo.id), desc(lfsObject.uploadedAt))
    : eq(lfsObject.repoId, resolved.repo.id);

  const rows = await db
    .select()
    .from(lfsObject)
    .where(eq(lfsObject.repoId, resolved.repo.id))
    .orderBy(desc(lfsObject.uploadedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    objects: items.map((r: any) => ({
      id: r.id,
      oid: r.oid,
      size: r.size,
      uploaded_at: r.uploadedAt.toISOString(),
    })),
    next_cursor: hasMore ? items[items.length - 1].id : null,
  });
};
lfsRest.get("/:slug/lfs/objects", apiKeyAuth, listObjectsHandler);
lfsRest.get("/:namespace/:slug/lfs/objects", apiKeyAuth, listObjectsHandler);

// ── List Locks ──

const listLocksHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const pathFilter = c.req.query("path");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 100);

  const rows = await db
    .select()
    .from(lfsLock)
    .where(eq(lfsLock.repoId, resolved.repo.id))
    .limit(limit + 1);

  let filtered = rows as typeof rows;
  if (pathFilter) filtered = filtered.filter((l: any) => l.path === pathFilter);

  const hasMore = filtered.length > limit;
  const items = hasMore ? filtered.slice(0, limit) : filtered;

  return c.json({
    locks: items.map(lockToJson),
    next_cursor: hasMore ? items[items.length - 1].id : null,
  });
};
lfsRest.get("/:slug/lfs/locks", apiKeyAuth, listLocksHandler);
lfsRest.get("/:namespace/:slug/lfs/locks", apiKeyAuth, listLocksHandler);

// ── Create Lock ──

const createLockHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: { path: string; ref?: { name: string } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.path) return c.json({ error: "path is required" }, 400);

  const [existing] = await db
    .select()
    .from(lfsLock)
    .where(and(eq(lfsLock.repoId, resolved.repo.id), eq(lfsLock.path, body.path)))
    .limit(1);

  if (existing) {
    return c.json({ lock: lockToJson(existing), error: "already locked" }, 409);
  }

  const lock = {
    id: nanoid(),
    orgId,
    repoId: resolved.repo.id,
    path: body.path,
    ownerId: c.get("apiKeyId"),
    ownerName: c.get("apiKeyId"),
    ref: body.ref?.name ?? null,
  };

  await db.insert(lfsLock).values(lock);

  return c.json(
    { lock: { id: lock.id, path: lock.path, locked_at: new Date().toISOString(), owner: { name: lock.ownerName } } },
    201
  );
};
lfsRest.post("/:slug/lfs/locks", apiKeyAuth, createLockHandler);
lfsRest.post("/:namespace/:slug/lfs/locks", apiKeyAuth, createLockHandler);

// ── Verify Locks ──

const verifyLocksHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const rows = await db
    .select()
    .from(lfsLock)
    .where(eq(lfsLock.repoId, resolved.repo.id))
    .limit(100);

  const apiKeyId = c.get("apiKeyId");
  const ours = rows.filter((l: any) => l.ownerId === apiKeyId).map(lockToJson);
  const theirs = rows.filter((l: any) => l.ownerId !== apiKeyId).map(lockToJson);

  return c.json({ ours, theirs });
};
lfsRest.post("/:slug/lfs/locks/verify", apiKeyAuth, verifyLocksHandler);
lfsRest.post("/:namespace/:slug/lfs/locks/verify", apiKeyAuth, verifyLocksHandler);

// ── Unlock ──

const unlockHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);
  const lockId = c.req.param("id");

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: { force?: boolean };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const [lock] = await db
    .select()
    .from(lfsLock)
    .where(and(eq(lfsLock.id, lockId), eq(lfsLock.repoId, resolved.repo.id)))
    .limit(1);

  if (!lock) return c.json({ error: "Lock not found" }, 404);

  if (lock.ownerId !== c.get("apiKeyId")) {
    if (!body.force || !isMasterKey(c.get("apiKeyPermissions"))) {
      return c.json({ error: "Cannot delete lock owned by another user. Use force with master key." }, 403);
    }
  }

  await db.delete(lfsLock).where(eq(lfsLock.id, lockId));

  return c.json({ lock: lockToJson(lock) });
};
lfsRest.post("/:slug/lfs/locks/:id/unlock", apiKeyAuth, unlockHandler);
lfsRest.post("/:namespace/:slug/lfs/locks/:id/unlock", apiKeyAuth, unlockHandler);

export { lfsRest };
