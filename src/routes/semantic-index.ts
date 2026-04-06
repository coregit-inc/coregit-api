/**
 * Semantic index management endpoints.
 *
 * POST   /v1/repos/:slug/index         — Trigger full reindex
 * GET    /v1/repos/:slug/index/status   — Get index status
 * DELETE /v1/repos/:slug/index         — Delete index
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { semanticIndex } from "../db/schema";
import { deleteNamespace } from "../services/pinecone";
import type { FullReindexMessage } from "../services/semantic-index";
import type { Env, Variables } from "../types";

const semanticIndexRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /v1/repos/:slug/index — Trigger full reindex
const triggerReindexHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  if (!c.env.INDEXING_QUEUE || !c.env.PINECONE_API_KEY || !c.env.VOYAGE_API_KEY || !c.env.PINECONE_INDEX_HOST) {
    return c.json({ error: "Semantic search not configured" }, 503);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: { branch?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // optional body
  }

  const branch = body.branch || resolved.repo.defaultBranch;

  const msg: FullReindexMessage = {
    type: "full_reindex",
    orgId,
    repoId: resolved.repo.id,
    repoStorageSuffix: resolved.storageSuffix,
    branch,
  };

  await c.env.INDEXING_QUEUE.send(msg);

  return c.json(
    {
      message: "Reindex queued",
      repo_slug: slug,
      branch,
    },
    202
  );
};

semanticIndexRoutes.post("/:slug/index", apiKeyAuth, triggerReindexHandler);
semanticIndexRoutes.post("/:namespace/:slug/index", apiKeyAuth, triggerReindexHandler);

// GET /v1/repos/:slug/index/status — Get index status
const getIndexStatusHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const branch = c.req.query("branch") || resolved.repo.defaultBranch;

  const [idx] = await db
    .select()
    .from(semanticIndex)
    .where(and(eq(semanticIndex.repoId, resolved.repo.id), eq(semanticIndex.branch, branch)))
    .limit(1);

  if (!idx) {
    return c.json({
      indexed: false,
      status: "not_indexed",
      branch,
    });
  }

  return c.json({
    indexed: idx.status === "ready",
    status: idx.status,
    branch,
    last_commit_sha: idx.lastCommitSha,
    chunks_count: idx.chunksCount,
    total_batches: idx.totalBatches,
    processed_batches: idx.processedBatches,
    indexed_at: idx.indexedAt,
    error: idx.error,
  });
};

semanticIndexRoutes.get("/:slug/index/status", apiKeyAuth, getIndexStatusHandler);
semanticIndexRoutes.get("/:namespace/:slug/index/status", apiKeyAuth, getIndexStatusHandler);

// DELETE /v1/repos/:slug/index — Delete index
const deleteIndexHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  if (!c.env.PINECONE_API_KEY || !c.env.PINECONE_INDEX_HOST) {
    return c.json({ error: "Semantic search not configured" }, 503);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: { branch?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // optional body
  }

  if (body.branch) {
    // Branch specified: only delete DB record (vectors are shared, can't delete per-branch)
    await db
      .delete(semanticIndex)
      .where(and(eq(semanticIndex.repoId, resolved.repo.id), eq(semanticIndex.branch, body.branch)));
    return c.json({ deleted: true, branch: body.branch, vectors_deleted: false });
  }

  // No branch: delete entire Pinecone namespace + all DB records
  const pineconeNs = `${orgId}/${resolved.repo.id}`;
  await deleteNamespace(c.env.PINECONE_INDEX_HOST!, c.env.PINECONE_API_KEY!, pineconeNs).catch((err) => {
    console.error(`deleteNamespace failed: ${err}`);
  });

  await db
    .delete(semanticIndex)
    .where(eq(semanticIndex.repoId, resolved.repo.id));

  return c.json({ deleted: true, vectors_deleted: true });
};

semanticIndexRoutes.delete("/:slug/index", apiKeyAuth, deleteIndexHandler);
semanticIndexRoutes.delete("/:namespace/:slug/index", apiKeyAuth, deleteIndexHandler);

export { semanticIndexRoutes };
