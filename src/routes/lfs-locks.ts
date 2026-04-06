/**
 * Git LFS File Locking API.
 *
 * POST /:org/:repo.git/info/lfs/locks           — Create lock
 * GET  /:org/:repo.git/info/lfs/locks           — List locks
 * POST /:org/:repo.git/info/lfs/locks/verify    — Verify locks (ours vs theirs)
 * POST /:org/:repo.git/info/lfs/locks/:id/unlock — Delete lock
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { organization, lfsLock } from "../db/schema";
import { parseBasicAuthKey, verifyCredentialForGit } from "../auth/middleware";
import { hasRepoAccess, isMasterKey } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import type { Env, Variables } from "../types";

const lfsLocks = new Hono<{ Bindings: Env; Variables: Variables }>();

const LFS_JSON = "application/vnd.git-lfs+json";

function extractLfsRepoParams(c: any): { orgParam: string; repoSlug: string; namespace: string | null } {
  const orgParam = c.req.param("org") || "";
  const namespace = c.req.param("namespace") ?? null;
  let repoSlug = c.req.param("repo") || "";
  if (repoSlug.endsWith(".git")) repoSlug = repoSlug.slice(0, -4);
  return { orgParam, repoSlug, namespace };
}

interface LockAuthResult {
  orgId: string;
  repoId: string;
  apiKeyId: string;
  scopes: Record<string, string[]> | null;
}

async function authLfs(c: any, requiredAccess: "read" | "write"): Promise<LockAuthResult | Response> {
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { orgParam, repoSlug, namespace } = extractLfsRepoParams(c);
  if (!orgParam || !repoSlug) {
    return c.json({ message: "Invalid path" }, 400, { "Content-Type": LFS_JSON });
  }

  const credentialValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (!credentialValue) {
    return c.json({ message: "Credentials required" }, 401, { "Content-Type": LFS_JSON });
  }

  const authResult = await verifyCredentialForGit(db, credentialValue);
  if (!authResult) {
    return c.json({ message: "Invalid credentials" }, 401, { "Content-Type": LFS_JSON });
  }

  const resolved = await resolveRepo(db, bucket, { orgId: authResult.orgId, slug: repoSlug, namespace });
  if (!resolved) {
    return c.json({ message: "Repository not found" }, 404, { "Content-Type": LFS_JSON });
  }

  if (!hasRepoAccess(authResult.scopes, resolved.scopeKey, requiredAccess)) {
    return c.json({ message: "Insufficient permissions" }, 403, { "Content-Type": LFS_JSON });
  }

  return {
    orgId: authResult.orgId,
    repoId: resolved.repo.id,
    apiKeyId: authResult.tokenId,
    scopes: authResult.scopes,
  };
}

function lockToJson(lock: any) {
  return {
    id: lock.id,
    path: lock.path,
    locked_at: lock.lockedAt.toISOString(),
    owner: { name: lock.ownerName },
  };
}

// ── Create Lock ──

async function createLockHandler(c: any) {
  const db = c.get("db");
  const auth = await authLfs(c, "write");
  if (auth instanceof Response) return auth;

  let body: { path: string; ref?: { name: string } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ message: "Invalid JSON body" }, 400, { "Content-Type": LFS_JSON });
  }

  if (!body.path) {
    return c.json({ message: "path is required" }, 400, { "Content-Type": LFS_JSON });
  }

  // Check if already locked
  const [existing] = await db
    .select()
    .from(lfsLock)
    .where(and(eq(lfsLock.repoId, auth.repoId), eq(lfsLock.path, body.path)))
    .limit(1);

  if (existing) {
    return c.json(
      { lock: lockToJson(existing), message: "already created lock" },
      409,
      { "Content-Type": LFS_JSON }
    );
  }

  const lock = {
    id: nanoid(),
    orgId: auth.orgId,
    repoId: auth.repoId,
    path: body.path,
    ownerId: auth.apiKeyId,
    ownerName: auth.apiKeyId,  // use key ID as owner name
    ref: body.ref?.name ?? null,
  };

  await db.insert(lfsLock).values(lock);

  return c.json(
    { lock: { id: lock.id, path: lock.path, locked_at: new Date().toISOString(), owner: { name: lock.ownerName } } },
    201,
    { "Content-Type": LFS_JSON }
  );
}

lfsLocks.post("/:org/:repo/info/lfs/locks", createLockHandler);
lfsLocks.post("/:org/:namespace/:repo/info/lfs/locks", createLockHandler);

// ── List Locks ──

async function listLocksHandler(c: any) {
  const db = c.get("db");
  const auth = await authLfs(c, "read");
  if (auth instanceof Response) return auth;

  const pathFilter = c.req.query("path");
  const idFilter = c.req.query("id");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 100);
  const cursor = c.req.query("cursor");

  let query = db
    .select()
    .from(lfsLock)
    .where(eq(lfsLock.repoId, auth.repoId))
    .limit(limit + 1);

  // Filtering is done in-app for simplicity (low lock count per repo)
  const rows = await query;

  let filtered = rows as typeof rows;
  if (pathFilter) filtered = filtered.filter((l: any) => l.path === pathFilter);
  if (idFilter) filtered = filtered.filter((l: any) => l.id === idFilter);

  const hasMore = filtered.length > limit;
  const items = hasMore ? filtered.slice(0, limit) : filtered;
  const nextCursor = hasMore ? items[items.length - 1].id : undefined;

  return c.json(
    {
      locks: items.map(lockToJson),
      next_cursor: nextCursor ?? "",
    },
    200,
    { "Content-Type": LFS_JSON }
  );
}

lfsLocks.get("/:org/:repo/info/lfs/locks", listLocksHandler);
lfsLocks.get("/:org/:namespace/:repo/info/lfs/locks", listLocksHandler);

// ── Verify Locks ──

async function verifyLocksHandler(c: any) {
  const db = c.get("db");
  const auth = await authLfs(c, "write");
  if (auth instanceof Response) return auth;

  let body: { ref?: { name: string }; cursor?: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const limit = Math.min(body.limit || 100, 100);

  const rows = await db
    .select()
    .from(lfsLock)
    .where(eq(lfsLock.repoId, auth.repoId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  const ours = items.filter((l: any) => l.ownerId === auth.apiKeyId).map(lockToJson);
  const theirs = items.filter((l: any) => l.ownerId !== auth.apiKeyId).map(lockToJson);

  return c.json(
    {
      ours,
      theirs,
      next_cursor: hasMore ? items[items.length - 1].id : "",
    },
    200,
    { "Content-Type": LFS_JSON }
  );
}

lfsLocks.post("/:org/:repo/info/lfs/locks/verify", verifyLocksHandler);
lfsLocks.post("/:org/:namespace/:repo/info/lfs/locks/verify", verifyLocksHandler);

// ── Unlock ──

async function unlockHandler(c: any) {
  const db = c.get("db");
  const auth = await authLfs(c, "write");
  if (auth instanceof Response) return auth;

  const lockId = c.req.param("id");

  let body: { force?: boolean; ref?: { name: string } };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const [lock] = await db
    .select()
    .from(lfsLock)
    .where(and(eq(lfsLock.id, lockId), eq(lfsLock.repoId, auth.repoId)))
    .limit(1);

  if (!lock) {
    return c.json({ message: "Lock not found" }, 404, { "Content-Type": LFS_JSON });
  }

  // Only owner can unlock, unless force + master key
  if (lock.ownerId !== auth.apiKeyId) {
    if (!body.force || !isMasterKey(auth.scopes)) {
      return c.json({ message: "Cannot delete lock owned by another user. Use force with master key." }, 403, { "Content-Type": LFS_JSON });
    }
  }

  await db.delete(lfsLock).where(eq(lfsLock.id, lockId));

  return c.json({ lock: lockToJson(lock) }, 200, { "Content-Type": LFS_JSON });
}

lfsLocks.post("/:org/:repo/info/lfs/locks/:id/unlock", unlockHandler);
lfsLocks.post("/:org/:namespace/:repo/info/lfs/locks/:id/unlock", unlockHandler);

export { lfsLocks };
