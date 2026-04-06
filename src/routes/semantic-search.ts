/**
 * Semantic code search endpoint.
 *
 * POST /v1/repos/:slug/semantic-search
 * POST /v1/repos/:namespace/:slug/semantic-search
 *
 * Two-stage retrieval: embed query → Pinecone top-50 → R2 blob fetch → Voyage rerank → top-k
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { semanticIndex } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject } from "../git/objects";
import { embedCode, rerankCode } from "../services/voyage";
import { queryVectors, type QueryMatch } from "../services/pinecone";
import { checkFreeLimits } from "../services/limits";
import { recordUsage } from "../services/usage";
import type { Env, Variables } from "../types";

const semanticSearch = new Hono<{ Bindings: Env; Variables: Variables }>();

interface SemanticSearchRequest {
  q: string;
  branch?: string;
  path_pattern?: string;
  language?: string;
  top_k?: number;
}

const PINECONE_TOP_K = 50;

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

const semanticSearchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  // Check required env vars
  if (!c.env.PINECONE_API_KEY || !c.env.VOYAGE_API_KEY || !c.env.PINECONE_INDEX_HOST) {
    return c.json({ error: "Semantic search not configured" }, 503);
  }

  // Free tier check
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

  const branch = body.branch || resolved.repo.defaultBranch;
  const topK = Math.min(body.top_k ?? 10, 50);

  // Check index status
  const [idx] = await db
    .select()
    .from(semanticIndex)
    .where(and(eq(semanticIndex.repoId, resolved.repo.id), eq(semanticIndex.branch, branch)))
    .limit(1);

  if (!idx || idx.status === "pending") {
    return c.json({ error: "Repository branch is not indexed. POST /v1/repos/:slug/index to start indexing." }, 404);
  }
  if (idx.status === "indexing") {
    return c.json({ error: "Indexing in progress", status: "indexing" }, 202);
  }
  if (idx.status === "failed") {
    return c.json({ error: "Index failed", detail: idx.error }, 500);
  }

  // 1. Embed query
  const [queryVector] = await embedCode([body.q], "query", c.env.VOYAGE_API_KEY!);

  // 2. Query Pinecone
  const pineconeNs = `${orgId}/${resolved.repo.id}/${branch}`;
  let filter: Record<string, unknown> | undefined;
  if (body.language) {
    filter = { language: { $eq: body.language } };
  }

  const matches = await queryVectors(
    c.env.PINECONE_INDEX_HOST!,
    c.env.PINECONE_API_KEY!,
    pineconeNs,
    queryVector,
    PINECONE_TOP_K,
    filter
  );

  if (matches.length === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, branch });
  }

  // 3. Filter by path_pattern if specified
  let filteredMatches = matches;
  if (body.path_pattern) {
    const pathRegex = globToRegex(body.path_pattern);
    filteredMatches = matches.filter((m) => pathRegex.test(m.metadata.file_path));
  }

  if (filteredMatches.length === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, branch });
  }

  // 4. Fetch text from R2 — deduplicated + parallel
  const storage = resolved.storage;
  const uniqueBlobs = new Map<string, null>();
  for (const m of filteredMatches) {
    uniqueBlobs.set(m.metadata.blob_sha, null);
  }

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

  // Extract text snippets for each match
  const matchTexts: string[] = [];
  const validMatches: QueryMatch[] = [];

  for (const match of filteredMatches) {
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
    validMatches.push(match);
  }

  if (validMatches.length === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, branch });
  }

  // 5. Rerank
  const reranked = await rerankCode(body.q, matchTexts, topK, c.env.VOYAGE_API_KEY!);

  // 6. Build response
  const results = reranked.map((r) => {
    const match = validMatches[r.index];
    return {
      file_path: match.metadata.file_path,
      score: r.score,
      language: match.metadata.language,
      start_line: match.metadata.start_line,
      end_line: match.metadata.end_line,
      snippet: matchTexts[r.index],
    };
  });

  // Track usage (fire-and-forget)
  recordUsage(
    c.executionCtx,
    db,
    orgId,
    "semantic_search_query",
    1,
    { repo_id: resolved.repo.id, results_count: results.length },
    c.env.DODO_PAYMENTS_API_KEY,
    c.get("dodoCustomerId")
  );

  return c.json({
    results,
    query: body.q,
    repo_slug: slug,
    branch,
  });
};

semanticSearch.post("/:slug/semantic-search", apiKeyAuth, semanticSearchHandler);
semanticSearch.post("/:namespace/:slug/semantic-search", apiKeyAuth, semanticSearchHandler);

export { semanticSearch };
