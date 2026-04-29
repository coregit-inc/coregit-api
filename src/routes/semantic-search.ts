/**
 * Semantic code search endpoint.
 *
 * POST /v1/repos/:slug/semantic-search
 * POST /v1/repos/:namespace/:slug/semantic-search
 *
 * Version-aware: accepts `ref` (branch name or commit SHA).
 * Two-stage retrieval: embed query → Pinecone top-N → post-filter by tree → R2 blob fetch → rerank → MMR → top-k
 *
 * Optimisations:
 *   - Parallel tree-fetch + query embedding (P0.1)
 *   - KV result cache keyed by commitSha (P0.2)
 *   - MMR diversification across files (P0.3)
 *   - Neighbour-chunk context expansion (P1.2)
 *   - Tuned over-fetch / rerank candidates (P1.3)
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { resolveSearchTargets } from "../services/fork-resolver";
import { extractRepoParams } from "./helpers";
import { semanticIndex } from "../db/schema";
import { parseGitObject } from "../git/objects";
import { embedCode, rerankCode } from "../services/voyage";
import { queryVectors, type QueryMatch } from "../services/pinecone";
import { resolveRef, getTreeBlobShas, hashCacheKey } from "../services/tree-resolver";
import { checkFreeLimits } from "../services/limits";
import { recordUsage } from "../services/usage";
import type { Env, Variables } from "../types";

const semanticSearch = new Hono<{ Bindings: Env; Variables: Variables }>();

interface SemanticSearchRequest {
  q: string;
  ref?: string;
  path_pattern?: string;
  language?: string;
  top_k?: number;
  expand_context?: boolean;
}

// ── Tuned constants (P1.3) ──
const PINECONE_OVER_FETCH = 150;
const RERANK_CANDIDATES = 30;
const MMR_LAMBDA = 0.3;
const SEARCH_CACHE_TTL = 600; // 10 minutes

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

// ── MMR diversification (P0.3) ──

function mmrSelect(
  reranked: Array<{ index: number; score: number }>,
  validMatches: Array<{ resolvedPath: string }>,
  topK: number,
  lambda: number = MMR_LAMBDA
): Array<{ index: number; score: number }> {
  if (reranked.length <= topK) return reranked;

  const selected: Array<{ index: number; score: number }> = [];
  const remaining = [...reranked];
  const selectedPaths = new Map<string, number>(); // path → count

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const filePath = validMatches[candidate.index].resolvedPath;
      const duplicates = selectedPaths.get(filePath) || 0;
      // Graduated penalty: first dupe penalised lightly, subsequent ones harder
      const penalty = duplicates > 0 ? 0.3 + 0.2 * Math.min(duplicates - 1, 3) : 0;
      const mmrScore = (1 - lambda) * candidate.score - lambda * penalty;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    const winner = remaining.splice(bestIdx, 1)[0];
    selected.push(winner);
    const winPath = validMatches[winner.index].resolvedPath;
    selectedPaths.set(winPath, (selectedPaths.get(winPath) || 0) + 1);
  }

  return selected;
}

const semanticSearchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  if (!c.env.PINECONE_API_KEY || !c.env.VOYAGE_API_KEY || !c.env.PINECONE_INDEX_HOST) {
    return c.json({ error: "Semantic search not configured" }, 503);
  }

  const apiLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "api_call");
  if (!apiLimit.allowed) {
    return c.json({ error: "Free tier limit exceeded", used: apiLimit.used, limit: apiLimit.limit }, 429);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: SemanticSearchRequest;
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
  const expandContext = body.expand_context === true;
  const storage = resolved.storage;

  // 1. Resolve ref → commit SHA
  const commitSha = await resolveRef(storage, ref);
  if (!commitSha) {
    return c.json({ error: `Ref not found: ${ref}` }, 404);
  }

  // ── P0.2: Check search result cache ──
  const searchCache = c.env.SEARCH_CACHE as KVNamespace | undefined;
  let cacheKey: string | null = null;
  if (searchCache) {
    cacheKey = `search:${orgId}/${resolved.repo.id}:${commitSha}:` + await hashCacheKey([
      body.q,
      body.language || "",
      body.path_pattern || "",
      String(topK),
      String(expandContext),
    ]);
    const cached = await searchCache.get(cacheKey, "json");
    if (cached) {
      recordUsage(
        c.executionCtx, c.env, db, orgId, c.get("dodoCustomerId"), "semantic_search_query", 1,
        { repo_id: resolved.repo.id, results_count: (cached as any).results?.length || 0, cache: "hit" }
      );
      return c.json(cached, 200, { "X-Cache": "HIT" });
    }
  }

  // 2+3. Parallel: get tree blob SHAs + embed query (P0.1)
  let treeBlobMap: Map<string, string>;
  let queryVector: number[];
  try {
    const [treeResult, embedResult] = await Promise.all([
      getTreeBlobShas(storage, commitSha, c.env.TREE_CACHE),
      embedCode([body.q], "query", c.env.VOYAGE_API_KEY!),
    ]);
    treeBlobMap = treeResult;
    queryVector = embedResult[0];
  } catch (err) {
    return c.json({ error: `Failed to prepare search: ${(err as Error).message}` }, 500);
  }

  const treeBlobShas = new Set(treeBlobMap.keys());

  if (treeBlobShas.size === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, ref });
  }

  // 4. Query Pinecone (over-fetch to compensate for post-filtering).
  // For instant forks: query both fork and parent namespaces, merge with
  // fork results taking priority.
  const targets = resolveSearchTargets(resolved.repo);

  let filter: Record<string, unknown> | undefined;
  if (body.language) {
    filter = { language: { $eq: body.language } };
  }

  const [forkMatches, parentMatches] = await Promise.all([
    queryVectors(c.env.PINECONE_INDEX_HOST!, c.env.PINECONE_API_KEY!, targets.selfNs, queryVector, PINECONE_OVER_FETCH, filter),
    targets.parentNs
      ? queryVectors(c.env.PINECONE_INDEX_HOST!, c.env.PINECONE_API_KEY!, targets.parentNs, queryVector, PINECONE_OVER_FETCH, filter).catch(() => [] as QueryMatch[])
      : Promise.resolve([] as QueryMatch[]),
  ]);

  // Merge: fork results take priority, dedup by vector ID
  const seenIds = new Set<string>();
  const matches: QueryMatch[] = [];
  for (const m of forkMatches) { seenIds.add(m.id); matches.push(m); }
  for (const m of parentMatches) { if (!seenIds.has(m.id)) matches.push(m); }

  if (matches.length === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, ref });
  }

  // 5. Post-filter: keep only matches whose blob_sha is in this commit's tree
  let filteredMatches = matches.filter((m) => treeBlobShas.has(m.metadata.blob_sha));

  // Also filter by path_pattern if specified
  if (body.path_pattern) {
    const pathRegex = globToRegex(body.path_pattern);
    filteredMatches = filteredMatches.filter((m) => {
      // Use file_path from tree (authoritative for this commit) or metadata
      const filePath = treeBlobMap.get(m.metadata.blob_sha) || m.metadata.file_path;
      return pathRegex.test(filePath);
    });
  }

  if (filteredMatches.length === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, ref });
  }

  // Take top RERANK_CANDIDATES for reranking
  const candidates = filteredMatches.slice(0, RERANK_CANDIDATES);

  // 6. Fetch text from R2 — deduplicated + parallel
  const uniqueBlobs = new Map<string, null>();
  for (const m of candidates) uniqueBlobs.set(m.metadata.blob_sha, null);

  const blobMap = new Map<string, Uint8Array>();
  const blobEntries = await Promise.all(
    [...uniqueBlobs.keys()].map(async (sha) => {
      const data = await storage.getObject(sha);
      return [sha, data] as const;
    })
  );
  for (const [sha, data] of blobEntries) {
    if (data) blobMap.set(sha, data);
  }

  // Extract text snippets
  const matchTexts: string[] = [];
  const validMatches: Array<QueryMatch & { resolvedPath: string; fullLines: string[] }> = [];

  for (const match of candidates) {
    const blobRaw = blobMap.get(match.metadata.blob_sha);
    if (!blobRaw) continue;

    const blobObj = parseGitObject(blobRaw);
    if (blobObj.type !== "blob") continue;

    const fullText = new TextDecoder().decode(blobObj.content);
    const lines = fullText.split("\n");
    const start = Math.max(0, match.metadata.start_line - 1);
    const end = Math.min(lines.length, match.metadata.end_line);
    const snippet = lines.slice(start, end).join("\n");

    matchTexts.push(snippet);
    // Use file path from tree (authoritative for this version)
    const resolvedPath = treeBlobMap.get(match.metadata.blob_sha) || match.metadata.file_path;
    validMatches.push({ ...match, resolvedPath, fullLines: lines });
  }

  if (validMatches.length === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, ref });
  }

  // 7. Rerank
  const reranked = await rerankCode(body.q, matchTexts, Math.min(topK * 3, matchTexts.length), c.env.VOYAGE_API_KEY!);

  // 8. MMR diversification (P0.3)
  const diversified = mmrSelect(reranked, validMatches, topK);

  // 9. Build response
  const results = diversified.map((r) => {
    const match = validMatches[r.index];
    const result: Record<string, unknown> = {
      file_path: match.resolvedPath,
      score: r.score,
      language: match.metadata.language,
      start_line: match.metadata.start_line,
      end_line: match.metadata.end_line,
      snippet: matchTexts[r.index],
    };

    // P1.2: Neighbour chunk context expansion
    if (expandContext) {
      const chunkIdx = match.metadata.chunk_index;
      const lines = match.fullLines;

      if (chunkIdx > 0) {
        // Show lines before this chunk's start
        const ctxStart = Math.max(0, match.metadata.start_line - 1 - 20);
        const ctxEnd = Math.max(0, match.metadata.start_line - 1);
        if (ctxEnd > ctxStart) {
          result.context_before = lines.slice(ctxStart, ctxEnd).join("\n");
        }
      }

      // Show lines after this chunk's end
      const ctxStart = Math.min(lines.length, match.metadata.end_line);
      const ctxEnd = Math.min(lines.length, match.metadata.end_line + 20);
      if (ctxEnd > ctxStart) {
        result.context_after = lines.slice(ctxStart, ctxEnd).join("\n");
      }
    }

    return result;
  });

  const responseBody = { results, query: body.q, repo_slug: slug, ref };

  // ── P0.2: Write to search cache ──
  if (searchCache && cacheKey) {
    c.executionCtx.waitUntil(
      searchCache.put(cacheKey, JSON.stringify(responseBody), { expirationTtl: SEARCH_CACHE_TTL }).catch(() => {})
    );
  }

  recordUsage(
    c.executionCtx, c.env, db, orgId, c.get("dodoCustomerId"), "semantic_search_query", 1,
    { repo_id: resolved.repo.id, results_count: results.length, cache: "miss" }
  );

  return c.json(responseBody, 200, { "X-Cache": "MISS" });
};

semanticSearch.post("/:slug/semantic-search", apiKeyAuth, semanticSearchHandler);
semanticSearch.post("/:namespace/:slug/semantic-search", apiKeyAuth, semanticSearchHandler);

export { semanticSearch };
