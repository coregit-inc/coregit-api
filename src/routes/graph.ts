/**
 * Code graph query endpoints.
 *
 * POST /v1/repos/:slug/graph/query     — Structural graph queries (callers, dependencies, etc.)
 * POST /v1/repos/:slug/graph/index     — Trigger full graph reindex (202)
 * GET  /v1/repos/:slug/graph/index/status — Graph indexing status
 * DELETE /v1/repos/:slug/graph/index   — Delete all graph data
 *
 * All queries are version-aware (ref → commit → tree → blob filter).
 * Results cached in GRAPH_CACHE KV (600s TTL, X-Cache header).
 */

import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { resolveRef, getTreeBlobShas, hashCacheKey } from "../services/tree-resolver";
import { codeGraphIndex } from "../db/schema";
import {
  queryCallers, queryCallees, queryDependencies, queryDependents,
  queryTypeHierarchy, queryImpactAnalysis, queryFileStructure,
  querySymbolLookup, queryCommunity, queryTestsFor,
  queryUnusedExports, queryCircularDeps, queryApiRoutes,
  queryDataFlow, deleteAllForRepo,
} from "../services/graph-db";
import { checkFreeLimits } from "../services/limits";
import { recordUsage } from "../services/usage";
import type { Env, Variables } from "../types";
import type { GraphFullReindexMessage } from "../services/graph-index";

const GRAPH_CACHE_TTL = 600; // 10 minutes

const graphRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Query handler ──

interface GraphQueryRequest {
  type: string;
  name?: string;
  file_path?: string;
  community_id?: string;
  ref?: string;
  max_depth?: number;
}

const queryHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const apiLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "api_call");
  if (!apiLimit.allowed) {
    return c.json({ error: "Free tier limit exceeded" }, 429);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: GraphQueryRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.type) return c.json({ error: "type is required" }, 400);

  const ref = body.ref || resolved.repo.defaultBranch;
  const storage = resolved.storage;

  const commitSha = await resolveRef(storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  // ── Check GRAPH_CACHE ──
  const graphCache = c.env.GRAPH_CACHE as KVNamespace | undefined;
  let cacheKey: string | null = null;
  if (graphCache) {
    cacheKey = `graph:${orgId}/${resolved.repo.id}:${commitSha}:` + await hashCacheKey([
      body.type,
      body.name || "",
      body.file_path || "",
      body.community_id || "",
      String(body.max_depth || 3),
    ]);
    const cached = await graphCache.get(cacheKey, "json");
    if (cached) {
      recordUsage(
        c.executionCtx, c.env, db, orgId, c.get("dodoCustomerId"), "graph_query", 1,
        { repo_id: resolved.repo.id, query_type: body.type, cache: "hit" }
      );
      return c.json(cached, 200, { "X-Cache": "HIT" });
    }
  }

  // ── Get tree blob SHAs for version filtering ──
  const treeBlobMap = await getTreeBlobShas(storage, commitSha, c.env.TREE_CACHE);
  const blobShas = new Set(treeBlobMap.keys());

  if (blobShas.size === 0) {
    return c.json({ nodes: [], query_type: body.type, ref });
  }

  // ── Execute query ──
  const maxDepth = Math.min(body.max_depth || 3, 5);
  let result: { nodes: any[]; edges?: any[] };

  switch (body.type) {
    case "callers":
      if (!body.name) return c.json({ error: "name is required for callers" }, 400);
      result = await queryCallers(db, resolved.repo.id, body.name, blobShas);
      break;
    case "callees":
      if (!body.name) return c.json({ error: "name is required for callees" }, 400);
      result = await queryCallees(db, resolved.repo.id, body.name, blobShas);
      break;
    case "dependencies":
      if (!body.name) return c.json({ error: "name is required for dependencies" }, 400);
      result = await queryDependencies(db, resolved.repo.id, body.name, blobShas, maxDepth);
      break;
    case "dependents":
      if (!body.name) return c.json({ error: "name is required for dependents" }, 400);
      result = await queryDependents(db, resolved.repo.id, body.name, blobShas, maxDepth);
      break;
    case "type_hierarchy":
      if (!body.name) return c.json({ error: "name is required for type_hierarchy" }, 400);
      result = await queryTypeHierarchy(db, resolved.repo.id, body.name, blobShas, maxDepth);
      break;
    case "impact_analysis":
      if (!body.name) return c.json({ error: "name is required for impact_analysis" }, 400);
      result = await queryImpactAnalysis(db, resolved.repo.id, body.name, blobShas, maxDepth);
      break;
    case "file_structure":
      if (!body.file_path) return c.json({ error: "file_path is required for file_structure" }, 400);
      result = await queryFileStructure(db, resolved.repo.id, body.file_path, blobShas);
      break;
    case "symbol_lookup":
      if (!body.name) return c.json({ error: "name is required for symbol_lookup" }, 400);
      result = await querySymbolLookup(db, resolved.repo.id, body.name, blobShas);
      break;
    case "community":
      if (!body.community_id) return c.json({ error: "community_id is required for community" }, 400);
      result = await queryCommunity(db, resolved.repo.id, body.community_id, blobShas);
      break;
    case "tests_for":
      if (!body.name) return c.json({ error: "name is required for tests_for" }, 400);
      result = await queryTestsFor(db, resolved.repo.id, body.name, blobShas);
      break;
    case "unused_exports":
      result = await queryUnusedExports(db, resolved.repo.id, blobShas);
      break;
    case "circular_deps":
      result = await queryCircularDeps(db, resolved.repo.id, blobShas);
      break;
    case "api_routes":
      result = await queryApiRoutes(db, resolved.repo.id, blobShas);
      break;
    case "data_flow":
      if (!body.name) return c.json({ error: "name is required for data_flow" }, 400);
      result = await queryDataFlow(db, resolved.repo.id, body.name, blobShas, maxDepth);
      break;
    default:
      return c.json({ error: `Unknown query type: ${body.type}` }, 400);
  }

  const responseBody = { ...result, query_type: body.type, ref };

  // ── Write to GRAPH_CACHE ──
  if (graphCache && cacheKey) {
    c.executionCtx.waitUntil(
      graphCache.put(cacheKey, JSON.stringify(responseBody), { expirationTtl: GRAPH_CACHE_TTL }).catch(() => {})
    );
  }

  recordUsage(
    c.executionCtx, c.env, db, orgId, c.get("dodoCustomerId"), "graph_query", 1,
    { repo_id: resolved.repo.id, query_type: body.type, results_count: result.nodes.length, cache: "miss" }
  );

  return c.json(responseBody, 200, { "X-Cache": "MISS" });
};

// ── Reindex handler ──

const reindexHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as { branch?: string };
  const branch = body.branch || resolved.repo.defaultBranch;

  if (!c.env.INDEXING_QUEUE) {
    return c.json({ error: "Indexing queue not configured" }, 503);
  }

  const msg: GraphFullReindexMessage = {
    type: "graph_full_reindex",
    orgId,
    repoId: resolved.repo.id,
    repoStorageSuffix: resolved.storageSuffix,
    branch,
  };
  c.executionCtx.waitUntil(c.env.INDEXING_QUEUE.send(msg));

  return c.json({ status: "accepted", branch }, 202);
};

// ── Status handler ──

const statusHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const [index] = await db
    .select()
    .from(codeGraphIndex)
    .where(eq(codeGraphIndex.repoId, resolved.repo.id))
    .limit(1);

  if (!index) {
    return c.json({ status: "not_indexed", repo_slug: slug });
  }

  return c.json({
    status: index.status,
    branch: index.branch,
    last_commit_sha: index.lastCommitSha,
    nodes_count: index.nodesCount,
    edges_count: index.edgesCount,
    total_batches: index.totalBatches,
    processed_batches: index.processedBatches,
    indexed_at: index.indexedAt,
    error: index.error,
  });
};

// ── Delete handler ──

const deleteHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  await deleteAllForRepo(db, resolved.repo.id);
  await db.delete(codeGraphIndex).where(eq(codeGraphIndex.repoId, resolved.repo.id));

  // Note: GRAPH_CACHE/HYBRID_CACHE entries expire naturally via TTL (600s).
  // CF KV doesn't support prefix delete — stale entries will return empty/outdated
  // results for at most 10 minutes after deletion.

  return c.json({ status: "deleted" });
};

// ── Route registration (both /:slug and /:namespace/:slug) ──

graphRoutes.post("/:slug/graph/query", apiKeyAuth, queryHandler);
graphRoutes.post("/:namespace/:slug/graph/query", apiKeyAuth, queryHandler);

graphRoutes.post("/:slug/graph/index", apiKeyAuth, reindexHandler);
graphRoutes.post("/:namespace/:slug/graph/index", apiKeyAuth, reindexHandler);

graphRoutes.get("/:slug/graph/index/status", apiKeyAuth, statusHandler);
graphRoutes.get("/:namespace/:slug/graph/index/status", apiKeyAuth, statusHandler);

graphRoutes.delete("/:slug/graph/index", apiKeyAuth, deleteHandler);
graphRoutes.delete("/:namespace/:slug/graph/index", apiKeyAuth, deleteHandler);

export { graphRoutes };
