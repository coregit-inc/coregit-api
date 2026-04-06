/**
 * Semantic code search endpoint.
 *
 * POST /v1/repos/:slug/semantic-search
 * POST /v1/repos/:namespace/:slug/semantic-search
 *
 * Version-aware: accepts `ref` (branch name or commit SHA).
 * Two-stage retrieval: embed query → Pinecone top-200 → post-filter by tree → R2 blob fetch → rerank → top-k
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { semanticIndex } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { flattenTree } from "../git/cherry-pick";
import { embedCode, rerankCode } from "../services/voyage";
import { queryVectors, type QueryMatch } from "../services/pinecone";
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
}

const PINECONE_OVER_FETCH = 200; // over-fetch to compensate for post-filtering
const RERANK_CANDIDATES = 50;

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Resolve a ref (branch name or commit SHA) to a commit SHA.
 */
async function resolveRef(storage: GitR2Storage, ref: string): Promise<string | null> {
  // Try as branch first
  const branchSha = await storage.getRef(`refs/heads/${ref}`);
  if (branchSha) return branchSha;

  // Try as raw commit SHA (40 hex chars)
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const raw = await storage.getObject(ref);
    if (raw) {
      const obj = parseGitObject(raw);
      if (obj.type === "commit") return ref;
    }
  }

  return null;
}

/**
 * Get the set of blob SHAs for a commit, with KV caching.
 * Commit SHA → tree is immutable, so cache never invalidates.
 */
async function getTreeBlobShas(
  storage: GitR2Storage,
  commitSha: string,
  kv?: KVNamespace
): Promise<Map<string, string>> {
  // Map<blobSha, filePath> — we need both for post-filtering and display
  const cacheKey = `tree:${commitSha}`;

  // Try KV cache
  if (kv) {
    const cached = await kv.get(cacheKey, "json") as Array<[string, string]> | null;
    if (cached) {
      return new Map(cached);
    }
  }

  // Cache miss — flatten tree from R2
  const raw = await storage.getObject(commitSha);
  if (!raw) throw new Error(`Commit not found: ${commitSha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") throw new Error(`Not a commit: ${commitSha}`);
  const commit = parseCommit(obj.content);
  const tree = await flattenTree(storage, commit.tree);

  // Build blobSha → filePath map (skip dirs)
  const blobMap = new Map<string, string>();
  for (const [path, entry] of tree) {
    if (entry.mode === "40000") continue;
    blobMap.set(entry.sha, path);
  }

  // Store in KV (commit SHA is immutable — no TTL needed)
  if (kv) {
    await kv.put(cacheKey, JSON.stringify([...blobMap.entries()])).catch(() => {});
  }

  return blobMap;
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
  const storage = resolved.storage;

  // 1. Resolve ref → commit SHA
  const commitSha = await resolveRef(storage, ref);
  if (!commitSha) {
    return c.json({ error: `Ref not found: ${ref}` }, 404);
  }

  // 2. Get tree blob SHAs (cached in KV)
  let treeBlobMap: Map<string, string>;
  try {
    treeBlobMap = await getTreeBlobShas(storage, commitSha, c.env.TREE_CACHE);
  } catch (err) {
    return c.json({ error: `Failed to resolve tree for ref: ${ref}` }, 500);
  }

  const treeBlobShas = new Set(treeBlobMap.keys());

  if (treeBlobShas.size === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, ref });
  }

  // 3. Embed query
  const [queryVector] = await embedCode([body.q], "query", c.env.VOYAGE_API_KEY!);

  // 4. Query Pinecone (over-fetch to compensate for post-filtering)
  const pineconeNs = `${orgId}/${resolved.repo.id}`;
  let filter: Record<string, unknown> | undefined;
  if (body.language) {
    filter = { language: { $eq: body.language } };
  }

  const matches = await queryVectors(
    c.env.PINECONE_INDEX_HOST!,
    c.env.PINECONE_API_KEY!,
    pineconeNs,
    queryVector,
    PINECONE_OVER_FETCH,
    filter
  );

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
  const validMatches: Array<QueryMatch & { resolvedPath: string }> = [];

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
    validMatches.push({ ...match, resolvedPath });
  }

  if (validMatches.length === 0) {
    return c.json({ results: [], query: body.q, repo_slug: slug, ref });
  }

  // 7. Rerank
  const reranked = await rerankCode(body.q, matchTexts, topK, c.env.VOYAGE_API_KEY!);

  // 8. Build response
  const results = reranked.map((r) => {
    const match = validMatches[r.index];
    return {
      file_path: match.resolvedPath,
      score: r.score,
      language: match.metadata.language,
      start_line: match.metadata.start_line,
      end_line: match.metadata.end_line,
      snippet: matchTexts[r.index],
    };
  });

  recordUsage(
    c.executionCtx, db, orgId, "semantic_search_query", 1,
    { repo_id: resolved.repo.id, results_count: results.length },
    c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId")
  );

  return c.json({ results, query: body.q, repo_slug: slug, ref });
};

semanticSearch.post("/:slug/semantic-search", apiKeyAuth, semanticSearchHandler);
semanticSearch.post("/:namespace/:slug/semantic-search", apiKeyAuth, semanticSearchHandler);

export { semanticSearch };
