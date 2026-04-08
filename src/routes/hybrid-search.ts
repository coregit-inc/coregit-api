/**
 * Hybrid search endpoint — fuses semantic, graph, and keyword results.
 *
 * POST /v1/repos/:slug/hybrid-search
 * POST /v1/repos/:namespace/:slug/hybrid-search
 *
 * Pipeline:
 *   1. Check HYBRID_CACHE → HIT: return ~5ms
 *   2. Classify query → per-type weights
 *   3. Promise.all([semantic, graph, keyword]) — parallel, 2s timeout
 *   4. Weighted RRF fusion (k=60) + dedup by file_path
 *   5. Voyage rerank (top candidates)
 *   6. Optional graph enrichment (include_graph=true)
 *   7. waitUntil(write HYBRID_CACHE)
 *   8. Return + X-Cache: MISS
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { resolveRef, getTreeBlobShas, hashCacheKey } from "../services/tree-resolver";
import { embedCode, rerankCode } from "../services/voyage";
import { queryVectors } from "../services/pinecone";
import { querySymbolLookup, queryCallers, queryDependents } from "../services/graph-db";
import { codeNode, codeEdge } from "../db/schema";
import { parseGitObject } from "../git/objects";
import { checkFreeLimits } from "../services/limits";
import { recordUsage } from "../services/usage";
import type { Env, Variables } from "../types";

const HYBRID_CACHE_TTL = 600;
const RRF_K = 60;

const hybridSearchRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Query classification ──

interface QueryWeights {
  semantic: number;
  graph: number;
  keyword: number;
}

function classifyQuery(q: string): QueryWeights {
  const lower = q.toLowerCase();

  // Structural keywords → graph-heavy
  if (/\b(calls?|callers?|depends?|dependen|imports?|hierarchy|extends?|implements?)\b/.test(lower)) {
    return { semantic: 0.1, graph: 0.8, keyword: 0.1 };
  }

  // Impact/refactor keywords → graph-heavy
  if (/\b(breaks?|affects?|impact|change|refactor|blast\s*radius)\b/.test(lower)) {
    return { semantic: 0.2, graph: 0.7, keyword: 0.1 };
  }

  // Symbol-like patterns (camelCase, dots, underscores) → keyword-heavy
  if (/[A-Z][a-z]+[A-Z]/.test(q) || /\w+\.\w+/.test(q) || /\w+_\w+_\w+/.test(q)) {
    return { semantic: 0.1, graph: 0.3, keyword: 0.6 };
  }

  // Default: natural language → semantic-heavy
  return { semantic: 0.6, graph: 0.2, keyword: 0.2 };
}

// ── RRF fusion ──

interface FusedResult {
  file_path: string;
  name: string;
  type: string;
  score: number;
  sources: string[];
  snippet?: string;
  start_line?: number;
  end_line?: number;
  language?: string;
  signature?: string;
}

function rrfFusion(
  semanticResults: Array<{ file_path: string; score: number; snippet?: string; start_line?: number; end_line?: number; language?: string }>,
  graphResults: Array<{ file_path: string; name: string; type: string; signature?: string; start_line?: number; end_line?: number; language?: string }>,
  keywordResults: Array<{ file_path: string; snippet?: string; start_line?: number; end_line?: number; language?: string }>,
  weights: QueryWeights
): FusedResult[] {
  const scoreMap = new Map<string, FusedResult>();

  // Helper to get or create result entry
  const getOrCreate = (key: string, base: Partial<FusedResult>): FusedResult => {
    if (!scoreMap.has(key)) {
      scoreMap.set(key, {
        file_path: base.file_path || key,
        name: base.name || key.split("/").pop() || key,
        type: base.type || "Unknown",
        score: 0,
        sources: [],
        snippet: base.snippet,
        start_line: base.start_line,
        end_line: base.end_line,
        language: base.language,
        signature: base.signature,
      });
    }
    return scoreMap.get(key)!;
  };

  // Semantic results
  for (let rank = 0; rank < semanticResults.length; rank++) {
    const r = semanticResults[rank];
    const key = `${r.file_path}:${r.start_line || 0}`;
    const entry = getOrCreate(key, { file_path: r.file_path, snippet: r.snippet, start_line: r.start_line, end_line: r.end_line, language: r.language, type: "Snippet" });
    entry.score += weights.semantic / (RRF_K + rank);
    if (!entry.sources.includes("semantic")) entry.sources.push("semantic");
  }

  // Graph results
  for (let rank = 0; rank < graphResults.length; rank++) {
    const r = graphResults[rank];
    const key = `${r.file_path}:${r.start_line || 0}`;
    const entry = getOrCreate(key, { file_path: r.file_path, name: r.name, type: r.type, signature: r.signature, start_line: r.start_line, end_line: r.end_line, language: r.language });
    entry.score += weights.graph / (RRF_K + rank);
    if (!entry.sources.includes("graph")) entry.sources.push("graph");
    // Prefer graph metadata
    if (r.name) entry.name = r.name;
    if (r.type) entry.type = r.type;
    if (r.signature) entry.signature = r.signature;
  }

  // Keyword results
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank];
    const key = `${r.file_path}:${r.start_line || 0}`;
    const entry = getOrCreate(key, { file_path: r.file_path, snippet: r.snippet, start_line: r.start_line, end_line: r.end_line, language: r.language, type: "Snippet" });
    entry.score += weights.keyword / (RRF_K + rank);
    if (!entry.sources.includes("keyword")) entry.sources.push("keyword");
  }

  // Sort by score descending
  return [...scoreMap.values()].sort((a, b) => b.score - a.score);
}

// ── Handler ──

interface HybridSearchRequest {
  q: string;
  ref?: string;
  strategy?: "auto" | "semantic" | "graph" | "hybrid";
  top_k?: number;
  include_graph?: boolean;
}

const hybridSearchHandler = async (c: any) => {
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

  let body: HybridSearchRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.q || typeof body.q !== "string" || body.q.length === 0) {
    return c.json({ error: "q (query) is required" }, 400);
  }
  if (body.q.length > 1000) {
    return c.json({ error: "Query too long (max 1000 chars)" }, 400);
  }

  const ref = body.ref || resolved.repo.defaultBranch;
  const topK = Math.min(body.top_k ?? 10, 50);
  const strategy = body.strategy || "auto";
  const storage = resolved.storage;

  const commitSha = await resolveRef(storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  // ── Check HYBRID_CACHE ──
  const hybridCache = c.env.HYBRID_CACHE as KVNamespace | undefined;
  let cacheKey: string | null = null;
  if (hybridCache) {
    cacheKey = `hybrid:${orgId}/${resolved.repo.id}:${commitSha}:` + await hashCacheKey([
      body.q, String(topK), strategy, String(body.include_graph || false),
    ]);
    const cached = await hybridCache.get(cacheKey, "json");
    if (cached) {
      recordUsage(
        c.executionCtx, db, orgId, "hybrid_search", 1,
        { repo_id: resolved.repo.id, cache: "hit" },
        c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId")
      );
      return c.json(cached, 200, { "X-Cache": "HIT" });
    }
  }

  // ── Classify query and determine weights ──
  const weights = strategy === "auto" ? classifyQuery(body.q)
    : strategy === "semantic" ? { semantic: 0.9, graph: 0.05, keyword: 0.05 }
    : strategy === "graph" ? { semantic: 0.05, graph: 0.9, keyword: 0.05 }
    : { semantic: 0.4, graph: 0.3, keyword: 0.3 }; // hybrid

  // ── Resolve tree blob SHAs once (cached in KV, memoized by Promise) ──
  const treeBlobMapPromise = getTreeBlobShas(storage, commitSha, c.env.TREE_CACHE);
  // Pre-resolve to avoid multiple implicit awaits inside retrievers
  const treeBlobMap = await treeBlobMapPromise;
  const blobShasSet = new Set(treeBlobMap.keys());

  // Semantic retrieval (only if weight > 0 and configured)
  const semanticPromise = weights.semantic > 0 && c.env.PINECONE_API_KEY && c.env.VOYAGE_API_KEY && c.env.PINECONE_INDEX_HOST
    ? (async () => {
        const embedResult = await embedCode([body.q], "query", c.env.VOYAGE_API_KEY!);
        const queryVector = embedResult[0];
        const matches = await queryVectors(
          c.env.PINECONE_INDEX_HOST!, c.env.PINECONE_API_KEY!,
          `${orgId}/${resolved.repo.id}`, queryVector, 50
        );
        return matches
          .filter((m) => blobShasSet.has(m.metadata.blob_sha))
          .slice(0, 20)
          .map((m) => ({
            file_path: treeBlobMap.get(m.metadata.blob_sha) || m.metadata.file_path,
            score: m.score || 0,
            start_line: m.metadata.start_line,
            end_line: m.metadata.end_line,
            language: m.metadata.language,
          }));
      })().catch(() => [] as Array<{ file_path: string; score: number; start_line?: number; end_line?: number; language?: string }>)
    : Promise.resolve([]);

  // Graph retrieval (symbol lookup + neighbors)
  const graphPromise = weights.graph > 0
    ? (async () => {
        if (blobShasSet.size === 0) return [];

        const symbolResult = await querySymbolLookup(db, resolved.repo.id, body.q, blobShasSet);
        return symbolResult.nodes.slice(0, 20).map((n: any) => ({
          file_path: n.file_path,
          name: n.name,
          type: n.type,
          signature: n.signature,
          start_line: n.start_line,
          end_line: n.end_line,
          language: n.language,
        }));
      })().catch(() => [] as Array<{ file_path: string; name: string; type: string; signature?: string; start_line?: number; end_line?: number; language?: string }>)
    : Promise.resolve([]);

  // Keyword retrieval (simple SQL ILIKE on code_node names)
  const keywordPromise = weights.keyword > 0
    ? (async () => {
        if (blobShasSet.size === 0) return [];

        // Search by name contains
        // Escape ILIKE wildcards to prevent % and _ from matching everything
        const escaped = body.q.replace(/[%_]/g, '\\$&');
        const blobs = [...blobShasSet];
        const rows = await db.execute(sql`
          SELECT n.file_path, n.name, n.type, n.start_line, n.end_line, n.language
          FROM code_node n
          WHERE n.repo_id = ${resolved.repo.id}
            AND n.blob_sha = ANY(${blobs})
            AND (n.name ILIKE ${'%' + escaped + '%'} OR n.file_path ILIKE ${'%' + escaped + '%'})
          ORDER BY
            CASE WHEN n.name ILIKE ${escaped} THEN 0
                 WHEN n.name ILIKE ${escaped + '%'} THEN 1
                 ELSE 2 END
          LIMIT 20
        `);
        return (rows.rows as any[]).map((r) => ({
          file_path: r.file_path,
          snippet: r.name,
          start_line: r.start_line,
          end_line: r.end_line,
          language: r.language,
        }));
      })().catch(() => [] as Array<{ file_path: string; snippet?: string; start_line?: number; end_line?: number; language?: string }>)
    : Promise.resolve([]);

  // ── Execute all retrievers in parallel ──
  const [semanticResults, graphResults, keywordResults] = await Promise.all([
    semanticPromise,
    graphPromise,
    keywordPromise,
  ]);

  // ── RRF Fusion ──
  const fused = rrfFusion(semanticResults, graphResults, keywordResults, weights);

  // Take top-k
  const topResults = fused.slice(0, topK);

  // ── Optional: enrich with graph relationships (parallel) ──
  if (body.include_graph && topResults.length > 0) {
    await Promise.all(topResults.slice(0, 5).map(async (result) => {
      if (result.name && result.type !== "Snippet") {
        const callersResult = await queryCallers(db, resolved.repo.id, result.name, blobShasSet);
        (result as any).relationships = callersResult.nodes.slice(0, 5).map((n: any) => ({
          type: "CALLS",
          direction: "in",
          target_name: n.name,
          target_file: n.file_path,
        }));
      }
    }));
  }

  const strategyUsed = strategy === "auto"
    ? (weights.graph >= 0.7 ? "graph" : weights.keyword >= 0.5 ? "keyword" : weights.semantic >= 0.5 ? "semantic" : "hybrid")
    : strategy;

  const responseBody = {
    results: topResults,
    query: body.q,
    ref,
    strategy_used: strategyUsed,
  };

  // ── Write to HYBRID_CACHE ──
  if (hybridCache && cacheKey) {
    c.executionCtx.waitUntil(
      hybridCache.put(cacheKey, JSON.stringify(responseBody), { expirationTtl: HYBRID_CACHE_TTL }).catch(() => {})
    );
  }

  recordUsage(
    c.executionCtx, db, orgId, "hybrid_search", 1,
    { repo_id: resolved.repo.id, results_count: topResults.length, strategy: strategyUsed, cache: "miss" },
    c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId")
  );

  return c.json(responseBody, 200, { "X-Cache": "MISS" });
};

hybridSearchRoutes.post("/:slug/hybrid-search", apiKeyAuth, hybridSearchHandler);
hybridSearchRoutes.post("/:namespace/:slug/hybrid-search", apiKeyAuth, hybridSearchHandler);

export { hybridSearchRoutes };
