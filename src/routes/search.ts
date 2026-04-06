/**
 * Cross-repo code search.
 *
 * POST /v1/search — Search code across all (or selected) repos in the org.
 *
 * Body:
 *   q:              string    — search query (substring or regex)
 *   repos?:         string[]  — filter to specific repo slugs (default: all)
 *   regex?:         boolean   — treat q as regex (default: false)
 *   case_sensitive?: boolean  — (default: false)
 *   context_lines?: number   — lines of context around matches (default: 2, max: 10)
 *   max_results?:   number   — total matches to return (default: 100, max: 500)
 *   ref?:           string   — branch name or commit SHA (default: each repo's default branch)
 *   path_pattern?:  string   — glob-like filter on file paths (e.g. "src/*.ts")
 */

import { Hono } from "hono";
import { eq, and, isNull, or } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess, getAccessibleRepoKeys } from "../auth/scopes";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { flattenTree, type FlatTree } from "../git/cherry-pick";
import { checkFreeLimits } from "../services/limits";
import type { Env, Variables } from "../types";

const search = new Hono<{ Bindings: Env; Variables: Variables }>();

interface SearchMatch {
  repo_slug: string;
  repo_namespace: string | null;
  path: string;
  line: number;
  content: string;
  context_before: string[];
  context_after: string[];
}

interface SearchRequest {
  q: string;
  repos?: string[];
  regex?: boolean;
  case_sensitive?: boolean;
  context_lines?: number;
  max_results?: number;
  ref?: string;
  path_pattern?: string;
}

const MAX_BLOB_SIZE = 512 * 1024; // Skip files >512KB
const MAX_REPOS_PER_SEARCH = 50;
const SEARCH_DEADLINE_MS = 20_000; // 20s hard deadline

/** Simple glob to regex: *.ts → /\.ts$/, src/*.ts → /^src\/.*\.ts$/ */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function isBinary(content: Uint8Array): boolean {
  const len = Math.min(content.length, 8192);
  for (let i = 0; i < len; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

async function searchRepo(
  storage: GitR2Storage,
  repoSlug: string,
  repoNamespace: string | null,
  ref: string,
  query: RegExp,
  pathFilter: RegExp | null,
  contextLines: number,
  maxResults: number,
  deadline: number
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const matches: SearchMatch[] = [];

  // Resolve ref (branch name or commit SHA) → commit → tree
  let commitSha = await storage.getRef(`refs/heads/${ref}`);
  if (!commitSha && /^[0-9a-f]{40}$/i.test(ref)) {
    commitSha = ref; // treat as raw commit SHA
  }
  if (!commitSha) return { matches: [], truncated: false };

  const raw = await storage.getObject(commitSha);
  if (!raw) return { matches: [], truncated: false };
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return { matches: [], truncated: false };
  const treeSha = parseCommit(obj.content).tree;

  // Flatten tree to get all file paths
  const flat = await flattenTree(storage, treeSha);

  // Collect blob SHAs to search (filter by path, skip dirs)
  const toSearch: { path: string; sha: string }[] = [];
  for (const [path, entry] of flat) {
    if (entry.mode === "40000") continue; // directory
    if (pathFilter && !pathFilter.test(path)) continue;
    toSearch.push({ path, sha: entry.sha });
  }

  // Search blobs in batches
  for (const { path, sha } of toSearch) {
    if (Date.now() > deadline) return { matches, truncated: true };
    if (matches.length >= maxResults) return { matches, truncated: true };

    const blobRaw = await storage.getObject(sha);
    if (!blobRaw) continue;

    const blobObj = parseGitObject(blobRaw);
    if (blobObj.type !== "blob") continue;
    if (blobObj.content.byteLength > MAX_BLOB_SIZE) continue;
    if (isBinary(blobObj.content)) continue;

    const text = new TextDecoder().decode(blobObj.content);
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) return { matches, truncated: true };
      if (query.test(lines[i])) {
        matches.push({
          repo_slug: repoSlug,
          repo_namespace: repoNamespace,
          path,
          line: i + 1,
          content: lines[i],
          context_before: lines.slice(Math.max(0, i - contextLines), i),
          context_after: lines.slice(i + 1, i + 1 + contextLines),
        });
      }
    }
  }

  return { matches, truncated: false };
}

search.post("/search", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;

  // Free tier check
  const apiLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "api_call");
  if (!apiLimit.allowed) {
    return c.json({
      error: "Free tier limit exceeded: API calls",
      used: apiLimit.used,
      limit: apiLimit.limit,
    }, 429);
  }

  let body: SearchRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.q || typeof body.q !== "string" || body.q.length === 0) {
    return c.json({ error: "q (query) is required" }, 400);
  }
  if (body.q.length > 500) {
    return c.json({ error: "Query too long (max 500 chars)" }, 400);
  }

  const caseSensitive = body.case_sensitive ?? false;
  const contextLines = Math.min(body.context_lines ?? 2, 10);
  const maxResults = Math.min(body.max_results ?? 100, 500);

  // Build query regex
  let query: RegExp;
  try {
    const flags = caseSensitive ? "g" : "gi";
    query = body.regex
      ? new RegExp(body.q, flags)
      : new RegExp(body.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch {
    return c.json({ error: "Invalid regex pattern" }, 400);
  }

  // Path filter
  const pathFilter = body.path_pattern ? globToRegex(body.path_pattern) : null;

  // Get repos to search
  let conditions: ReturnType<typeof eq> | ReturnType<typeof and> = eq(repo.orgId, orgId);

  // Scoped token filtering
  const accessibleKeys = getAccessibleRepoKeys(c.get("apiKeyPermissions"));
  if (accessibleKeys !== null && accessibleKeys.length > 0) {
    const scopeConditions = accessibleKeys.map((key) => {
      const slashIdx = key.indexOf("/");
      if (slashIdx !== -1) {
        const ns = key.slice(0, slashIdx);
        const slug = key.slice(slashIdx + 1);
        return and(eq(repo.namespace, ns), eq(repo.slug, slug));
      }
      return and(isNull(repo.namespace), eq(repo.slug, key));
    });
    conditions = and(conditions, or(...scopeConditions))!;
  } else if (accessibleKeys !== null) {
    return c.json({ matches: [], total: 0, truncated: false });
  }

  // Filter to specific repos if requested
  if (body.repos && body.repos.length > 0) {
    const repoConditions = body.repos.map((slug) => eq(repo.slug, slug));
    conditions = and(conditions, or(...repoConditions))!;
  }

  const repos = await db
    .select()
    .from(repo)
    .where(conditions)
    .limit(MAX_REPOS_PER_SEARCH);

  const deadline = Date.now() + SEARCH_DEADLINE_MS;
  const allMatches: SearchMatch[] = [];
  let truncated = false;
  let reposSearched = 0;

  for (const r of repos) {
    if (Date.now() > deadline || allMatches.length >= maxResults) {
      truncated = true;
      break;
    }

    // Check repo access for scoped tokens
    const scopeKey = r.namespace ? `${r.namespace}/${r.slug}` : r.slug;
    if (!hasRepoAccess(c.get("apiKeyPermissions"), scopeKey, "read")) continue;

    const storageSuffix = r.namespace ? `${r.namespace}/${r.slug}` : r.slug;
    const storage = new GitR2Storage(bucket, orgId, storageSuffix);
    const ref = body.ref || r.defaultBranch;

    const result = await searchRepo(
      storage,
      r.slug,
      r.namespace,
      ref,
      query,
      pathFilter,
      contextLines,
      maxResults - allMatches.length,
      deadline
    );

    allMatches.push(...result.matches);
    if (result.truncated) truncated = true;
    reposSearched++;
  }

  return c.json({
    matches: allMatches,
    total: allMatches.length,
    repos_searched: reposSearched,
    truncated,
  });
});

export { search };
