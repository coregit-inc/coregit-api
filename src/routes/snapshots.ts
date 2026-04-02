/**
 * Snapshot endpoints (named restore points)
 *
 * POST   /v1/repos/:slug/snapshots               — Create snapshot
 * GET    /v1/repos/:slug/snapshots               — List snapshots
 * GET    /v1/repos/:slug/snapshots/:name          — Get snapshot
 * DELETE /v1/repos/:slug/snapshots/:name          — Delete snapshot
 * POST   /v1/repos/:slug/snapshots/:name/restore  — Restore snapshot
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repo, snapshot } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import type { Env, Variables } from "../types";

const snapshots = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /v1/repos/:slug/snapshots
const createSnapshotHandler = async (c: any) => {
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

  let body: { name: string; branch?: string; metadata?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.name) return c.json({ error: "name is required" }, 400);

  const branch = body.branch || found.defaultBranch;
  const commitSha = await storage.getRef(`refs/heads/${branch}`);
  if (!commitSha) return c.json({ error: `Branch '${branch}' not found` }, 404);

  try {
    // Check uniqueness
    const existing = await db
      .select({ id: snapshot.id })
      .from(snapshot)
      .where(and(eq(snapshot.repoId, found.id), eq(snapshot.name, body.name)))
      .limit(1);

    if (existing.length > 0) {
      return c.json({ error: `Snapshot '${body.name}' already exists` }, 409);
    }

    const [created] = await db
      .insert(snapshot)
      .values({
        id: nanoid(),
        repoId: found.id,
        name: body.name,
        branch,
        commitSha,
        metadata: body.metadata || null,
      })
      .returning();

    return c.json(
      {
        name: created.name,
        branch: created.branch,
        commit_sha: created.commitSha,
        metadata: created.metadata,
        created_at: created.createdAt,
      },
      201
    );
  } catch (error) {
    console.error("Failed to create snapshot:", error);
    return c.json({ error: "Failed to create snapshot" }, 500);
  }
};
snapshots.post("/:slug/snapshots", apiKeyAuth, createSnapshotHandler);
snapshots.post("/:namespace/:slug/snapshots", apiKeyAuth, createSnapshotHandler);

// GET /v1/repos/:slug/snapshots
const listSnapshotsHandler = async (c: any) => {
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

  const list = await db
    .select()
    .from(snapshot)
    .where(eq(snapshot.repoId, found.id))
    .orderBy(snapshot.createdAt);

  return c.json({
    snapshots: list.map((s: any) => ({
      name: s.name,
      branch: s.branch,
      commit_sha: s.commitSha,
      metadata: s.metadata,
      created_at: s.createdAt,
    })),
  });
};
snapshots.get("/:slug/snapshots", apiKeyAuth, listSnapshotsHandler);
snapshots.get("/:namespace/:slug/snapshots", apiKeyAuth, listSnapshotsHandler);

// GET /v1/repos/:slug/snapshots/:name
const getSnapshotHandler = async (c: any) => {
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

  const found = resolved.repo;

  const [snap] = await db
    .select()
    .from(snapshot)
    .where(and(eq(snapshot.repoId, found.id), eq(snapshot.name, name)))
    .limit(1);

  if (!snap) return c.json({ error: "Snapshot not found" }, 404);

  return c.json({
    name: snap.name,
    branch: snap.branch,
    commit_sha: snap.commitSha,
    metadata: snap.metadata,
    created_at: snap.createdAt,
  });
};
snapshots.get("/:slug/snapshots/:name", apiKeyAuth, getSnapshotHandler);
snapshots.get("/:namespace/:slug/snapshots/:name", apiKeyAuth, getSnapshotHandler);

// DELETE /v1/repos/:slug/snapshots/:name
const deleteSnapshotHandler = async (c: any) => {
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

  const [snap] = await db
    .select()
    .from(snapshot)
    .where(and(eq(snapshot.repoId, found.id), eq(snapshot.name, name)))
    .limit(1);

  if (!snap) return c.json({ error: "Snapshot not found" }, 404);

  await db.delete(snapshot).where(eq(snapshot.id, snap.id));
  return c.json({ deleted: true });
};
snapshots.delete("/:slug/snapshots/:name", apiKeyAuth, deleteSnapshotHandler);
snapshots.delete("/:namespace/:slug/snapshots/:name", apiKeyAuth, deleteSnapshotHandler);

// POST /v1/repos/:slug/snapshots/:name/restore
const restoreSnapshotHandler = async (c: any) => {
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

  const [snap] = await db
    .select()
    .from(snapshot)
    .where(and(eq(snapshot.repoId, found.id), eq(snapshot.name, name)))
    .limit(1);

  if (!snap) return c.json({ error: "Snapshot not found" }, 404);

  let body: { target_branch?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const targetBranch = body.target_branch || snap.branch;

  // Verify commit still exists
  const exists = await storage.hasObject(snap.commitSha);
  if (!exists) {
    return c.json({ error: "Snapshot commit no longer exists in storage" }, 410);
  }

  // CAS: if branch exists, use conditional update to prevent race
  const currentRef = await storage.getRefWithEtag(`refs/heads/${targetBranch}`);
  if (currentRef) {
    const ok = await storage.setRefConditional(`refs/heads/${targetBranch}`, snap.commitSha, currentRef.etag);
    if (!ok) {
      return c.json({ error: "Branch was updated concurrently, retry restore" }, 409);
    }
  } else {
    await storage.setRef(`refs/heads/${targetBranch}`, snap.commitSha);
  }

  return c.json({
    restored: true,
    branch: targetBranch,
    sha: snap.commitSha,
  });
};
snapshots.post("/:slug/snapshots/:name/restore", apiKeyAuth, restoreSnapshotHandler);
snapshots.post("/:namespace/:slug/snapshots/:name/restore", apiKeyAuth, restoreSnapshotHandler);

export { snapshots };
