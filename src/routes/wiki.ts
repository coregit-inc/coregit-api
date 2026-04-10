/**
 * LLM Wiki endpoints
 *
 * All routes mount under /v1/repos/:slug/wiki (and /:namespace/:slug/wiki).
 *
 * POST  /:slug/wiki/init           — Create wiki from template
 * GET   /:slug/wiki/pages          — List wiki pages with parsed frontmatter
 * GET   /:slug/wiki/pages/*        — Read single page (parsed)
 * GET   /:slug/wiki/sources        — List raw sources
 * GET   /:slug/wiki/sources/*      — Read raw source
 * GET   /:slug/wiki/index          — Get index.md content
 * GET   /:slug/wiki/log            — Get log.md entries (parsed)
 * GET   /:slug/wiki/llms.txt       — Auto-generated llms.txt
 * POST  /:slug/wiki/search         — Wiki-aware semantic search
 * GET   /:slug/wiki/graph          — Knowledge graph
 * GET   /:slug/wiki/stats          — Wiki health stats
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq, and, isNull } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess, isMasterKey } from "../auth/scopes";
import { repo, organization, semanticIndex, codeGraphIndex } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseTree, parseCommit, type TreeEntry } from "../git/objects";
import { resolveRepo, buildGitUrl, buildApiUrl } from "../services/repo-resolver";
import { copyGraphForFork } from "../services/fork-graph";
import { recordUsage } from "../services/usage";
import { recordAudit } from "../services/audit";
import { checkFreeLimits } from "../services/limits";
import { extractRepoParams } from "./helpers";
import { resolveRef, getTreeFromCommit, navigateToPath, flattenTreeRecursive, isBinaryContent } from "./files";
import {
  parseFrontmatter,
  generateLlmsTxt,
  buildKnowledgeGraph,
  parseLogEntries,
  countWords,
  type WikiConfig,
  type PageSummary,
  type SourceInfo,
} from "../services/wiki";
import type { Env, Variables } from "../types";

const wiki = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Template constants ──
const WIKI_TEMPLATE_SLUG = "llm-wiki-template";
const WIKI_TEMPLATE_ORG_SLUG = "coregit"; // the org that owns the template

// ── Shared helpers ──

async function readBlob(storage: GitR2Storage, sha: string): Promise<string | null> {
  const raw = await storage.getObject(sha);
  if (!raw) return null;
  const obj = parseGitObject(raw);
  if (obj.type !== "blob") return null;
  if (isBinaryContent(obj.content)) return null;
  return new TextDecoder().decode(obj.content);
}

async function getBlobSize(storage: GitR2Storage, sha: string): Promise<number> {
  const raw = await storage.getObject(sha);
  if (!raw) return 0;
  const obj = parseGitObject(raw);
  return obj.content.length;
}

interface FlatFile {
  name: string;
  path: string;
  type: string;
  sha: string;
  mode: string;
}

async function listFilesUnderPath(
  storage: GitR2Storage,
  commitSha: string,
  dirPath: string,
  filterExtension?: string,
): Promise<FlatFile[]> {
  const rootTreeSha = await getTreeFromCommit(storage, commitSha);
  if (!rootTreeSha) return [];

  const pathParts = dirPath.split("/").filter(Boolean);
  const treeResult = await navigateToPath(storage, rootTreeSha, pathParts);
  if (!treeResult) return [];

  const items: FlatFile[] = [];
  await flattenTreeRecursive(storage, treeResult.entries, dirPath, items, 10_000);

  if (filterExtension) {
    return items.filter((f) => f.type === "file" && f.path.endsWith(filterExtension));
  }
  return items.filter((f) => f.type === "file");
}

async function readFileAtPath(
  storage: GitR2Storage,
  commitSha: string,
  filePath: string,
): Promise<{ content: string; sha: string } | null> {
  const rootTreeSha = await getTreeFromCommit(storage, commitSha);
  if (!rootTreeSha) return null;

  const parts = filePath.split("/").filter(Boolean);
  const dirParts = parts.slice(0, -1);
  const fileName = parts[parts.length - 1];

  let treeEntries: TreeEntry[];
  if (dirParts.length === 0) {
    const raw = await storage.getObject(rootTreeSha);
    if (!raw) return null;
    const obj = parseGitObject(raw);
    treeEntries = parseTree(obj.content);
  } else {
    const treeResult = await navigateToPath(storage, rootTreeSha, dirParts);
    if (!treeResult) return null;
    treeEntries = treeResult.entries;
  }

  const entry = treeEntries.find((e) => e.name === fileName);
  if (!entry || entry.mode === "40000") return null;

  const content = await readBlob(storage, entry.sha);
  if (content === null) return null;

  return { content, sha: entry.sha };
}

// ── Collect pages with parsed frontmatter ──

async function collectPages(
  storage: GitR2Storage,
  commitSha: string,
): Promise<PageSummary[]> {
  const files = await listFilesUnderPath(storage, commitSha, "wiki", ".md");
  const pages: PageSummary[] = [];

  // Read blobs in parallel (batch of 50)
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const results = await Promise.all(
      batch.map(async (f) => {
        const content = await readBlob(storage, f.sha);
        if (!content) return null;
        const parsed = parseFrontmatter(content);
        return {
          path: f.path,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          word_count: countWords(parsed.body),
        } satisfies PageSummary;
      }),
    );
    for (const r of results) {
      if (r) pages.push(r);
    }
  }

  return pages;
}

async function collectSources(
  storage: GitR2Storage,
  commitSha: string,
): Promise<SourceInfo[]> {
  const files = await listFilesUnderPath(storage, commitSha, "raw");
  const sources: SourceInfo[] = [];

  for (const f of files) {
    if (f.name === ".gitkeep") continue;
    const size = await getBlobSize(storage, f.sha);
    sources.push({ path: f.path, size });
  }

  return sources;
}

// ── Read wiki config from wiki.json ──

async function readWikiConfig(
  storage: GitR2Storage,
  commitSha: string,
): Promise<WikiConfig | null> {
  const result = await readFileAtPath(storage, commitSha, "wiki.json");
  if (!result) return null;
  try {
    return JSON.parse(result.content) as WikiConfig;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
// Route handlers
// ═══════════════════════════════════════════

// ── POST /:slug/wiki/init ──

const initHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;

  let body: { slug: string; title?: string; description?: string; namespace?: string; visibility?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.slug || typeof body.slug !== "string") {
    return c.json({ error: "slug is required" }, 400);
  }

  const slugRegex = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;
  if (!slugRegex.test(body.slug) || body.slug.includes("--")) {
    return c.json({ error: "Invalid slug" }, 400);
  }

  // Free tier check
  const repoLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "repo_created");
  if (!repoLimit.allowed) {
    return c.json({ error: "Free tier limit exceeded: repositories", used: repoLimit.used, limit: repoLimit.limit }, 429);
  }

  // Check target doesn't exist
  const ns = body.namespace || null;
  const existing = await resolveRepo(db, bucket, { orgId, slug: body.slug, namespace: ns });
  if (existing) {
    return c.json({ error: "A repository with this slug already exists" }, 409);
  }

  // Find the wiki template
  // Look up the coregit org first
  const [templateOrg] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, WIKI_TEMPLATE_ORG_SLUG))
    .limit(1);

  if (!templateOrg) {
    return c.json({ error: "Wiki template not available" }, 503);
  }

  const templateResolved = await resolveRepo(db, bucket, {
    orgId: templateOrg.id,
    slug: WIKI_TEMPLATE_SLUG,
    namespace: null,
  });

  if (!templateResolved) {
    return c.json({ error: "Wiki template not found" }, 503);
  }

  const source = templateResolved.repo;

  // Build wiki config
  const wikiConfig: WikiConfig = {
    version: 1,
    title: body.title || "My Knowledge Base",
    description: body.description,
    llms_txt: {
      include_sources: false,
      max_pages: 500,
      sort: "updated",
    },
  };

  const repoId = nanoid();

  try {
    // 1. Create DB record
    const [newRepo] = await db
      .insert(repo)
      .values({
        id: repoId,
        orgId,
        namespace: ns,
        slug: body.slug,
        description: body.description || `LLM Wiki: ${wikiConfig.title}`,
        defaultBranch: source.defaultBranch,
        visibility: body.visibility === "public" ? "public" : "private",
        autoIndex: true, // wikis should auto-index for semantic search
        isTemplate: false,
        forkedFromRepoId: source.id,
        forkedFromOrgId: source.orgId,
        forkedAt: new Date(),
        wikiConfig,
      })
      .returning();

    // 2. Copy R2 objects
    const sourceStorageSuffix = source.namespace ? `${source.namespace}/${source.slug}` : source.slug;
    const targetStorageSuffix = ns ? `${ns}/${body.slug}` : body.slug;
    const sourceBasePath = `${source.orgId}/${sourceStorageSuffix}`;
    const targetBasePath = `${orgId}/${targetStorageSuffix}`;

    await GitR2Storage.copyRepo(bucket, sourceBasePath, targetBasePath);

    // 3. Copy semantic index if exists
    const [sourceIdx] = await db
      .select()
      .from(semanticIndex)
      .where(and(eq(semanticIndex.repoId, source.id), eq(semanticIndex.branch, source.defaultBranch)))
      .limit(1);

    if (sourceIdx) {
      await db.insert(semanticIndex).values({
        id: nanoid(),
        repoId,
        orgId,
        branch: source.defaultBranch,
        lastCommitSha: sourceIdx.lastCommitSha,
        chunksCount: sourceIdx.chunksCount,
        status: "ready",
        indexedAt: new Date(),
      });
    }

    // 4. Copy code graph
    const graphResult = await copyGraphForFork(db, source.id, source.orgId, repoId, orgId);

    const [sourceGraphIdx] = await db
      .select()
      .from(codeGraphIndex)
      .where(and(eq(codeGraphIndex.repoId, source.id), eq(codeGraphIndex.branch, source.defaultBranch)))
      .limit(1);

    if (sourceGraphIdx) {
      await db.insert(codeGraphIndex).values({
        id: nanoid(),
        repoId,
        orgId,
        branch: source.defaultBranch,
        lastCommitSha: sourceGraphIdx.lastCommitSha,
        nodesCount: graphResult.nodesCount,
        edgesCount: graphResult.edgesCount,
        status: "ready",
        indexedAt: new Date(),
      });
    }

    // 5. Usage + audit
    recordUsage(c.executionCtx, db, orgId, "repo_created", 1, {
      repo_id: repoId, wiki: true,
    }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));

    recordAudit(c.executionCtx, db, {
      orgId,
      actorId: c.get("apiKeyId"),
      actorType: isMasterKey(c.get("apiKeyPermissions")) ? "master_key" : "scoped_token",
      action: "wiki.create",
      resourceType: "repo",
      resourceId: repoId,
      metadata: { slug: body.slug, namespace: ns, title: wikiConfig.title },
      requestId: c.get("requestId"),
    });

    // Look up org slug for git URL
    const [org] = await db
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    const orgSlug = org?.slug || orgId;

    return c.json({
      id: newRepo.id,
      namespace: newRepo.namespace,
      slug: newRepo.slug,
      description: newRepo.description,
      default_branch: newRepo.defaultBranch,
      visibility: newRepo.visibility,
      wiki_config: wikiConfig,
      git_url: buildGitUrl(orgSlug, body.slug, ns, c.get("customDomain")),
      api_url: buildApiUrl(body.slug, ns),
      created_at: newRepo.createdAt,
    }, 201);
  } catch (error) {
    // Rollback on failure
    await db.delete(repo).where(eq(repo.id, repoId)).catch(() => {});
    console.error("Failed to create wiki:", error);
    return c.json({ error: "Failed to create wiki" }, 500);
  }
};

// ── GET /:slug/wiki/pages ──

const listPagesHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  // Check KV cache
  const searchCache = c.env.SEARCH_CACHE as KVNamespace | undefined;
  const cacheKey = searchCache ? `wiki-pages:${orgId}/${resolved.repo.id}:${commitSha}` : null;
  if (searchCache && cacheKey) {
    const cached = await searchCache.get(cacheKey, "json");
    if (cached) return c.json(cached);
  }

  const pages = await collectPages(resolved.storage, commitSha);

  // Apply filters
  let filtered = pages;
  const typeFilter = c.req.query("type");
  if (typeFilter) {
    filtered = filtered.filter((p) => p.frontmatter.type === typeFilter);
  }
  const tagFilter = c.req.query("tag");
  if (tagFilter) {
    filtered = filtered.filter((p) => p.frontmatter.tags?.includes(tagFilter));
  }

  // Sort
  const sort = c.req.query("sort") || "updated";
  filtered.sort((a, b) => {
    const aVal = String(a.frontmatter[sort as keyof typeof a.frontmatter] || "");
    const bVal = String(b.frontmatter[sort as keyof typeof b.frontmatter] || "");
    return bVal.localeCompare(aVal);
  });

  // Pagination
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const paged = filtered.slice(offset, offset + limit);

  const response = {
    pages: paged.map((p) => ({
      path: p.path,
      title: p.frontmatter.title,
      summary: p.frontmatter.summary,
      tags: p.frontmatter.tags || [],
      type: p.frontmatter.type,
      sources: p.frontmatter.sources || [],
      related: p.frontmatter.related || [],
      created: p.frontmatter.created,
      updated: p.frontmatter.updated,
      word_count: p.word_count,
    })),
    total: filtered.length,
    ref,
  };

  // Cache
  if (searchCache && cacheKey) {
    c.executionCtx.waitUntil(
      searchCache.put(cacheKey, JSON.stringify(response), { expirationTtl: 600 }).catch(() => {}),
    );
  }

  return c.json(response);
};

// ── GET /:slug/wiki/pages/* ──

const getPageHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  // Extract the page path from the URL
  const url = new URL(c.req.url);
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  const prefix = `/v1/repos/${repoPath}/wiki/pages/`;
  const pagePath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length));

  if (!pagePath) return c.json({ error: "Page path is required" }, 400);

  const fullPath = pagePath.startsWith("wiki/") ? pagePath : `wiki/${pagePath}`;
  const result = await readFileAtPath(resolved.storage, commitSha, fullPath);
  if (!result) return c.json({ error: "Page not found" }, 404);

  const parsed = parseFrontmatter(result.content);

  return c.json({
    path: fullPath,
    frontmatter: parsed.frontmatter,
    content: parsed.body,
    word_count: countWords(parsed.body),
    sha: result.sha,
    ref,
  });
};

// ── GET /:slug/wiki/sources ──

const listSourcesHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  const sources = await collectSources(resolved.storage, commitSha);

  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  return c.json({
    sources: sources.slice(offset, offset + limit),
    total: sources.length,
    ref,
  });
};

// ── GET /:slug/wiki/sources/* ──

const getSourceHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  const url = new URL(c.req.url);
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  const prefix = `/v1/repos/${repoPath}/wiki/sources/`;
  const sourcePath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length));

  if (!sourcePath) return c.json({ error: "Source path is required" }, 400);

  const fullPath = sourcePath.startsWith("raw/") ? sourcePath : `raw/${sourcePath}`;
  const result = await readFileAtPath(resolved.storage, commitSha, fullPath);
  if (!result) return c.json({ error: "Source not found" }, 404);

  return c.json({
    path: fullPath,
    content: result.content,
    word_count: countWords(result.content),
    sha: result.sha,
    ref,
  });
};

// ── GET /:slug/wiki/index ──

const getIndexHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  const result = await readFileAtPath(resolved.storage, commitSha, "index.md");
  if (!result) return c.json({ error: "index.md not found" }, 404);

  return c.json({
    content: result.content,
    sha: result.sha,
    ref,
  });
};

// ── GET /:slug/wiki/log ──

const getLogHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  const result = await readFileAtPath(resolved.storage, commitSha, "log.md");
  if (!result) return c.json({ error: "log.md not found" }, 404);

  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const parsed = parseLogEntries(result.content, limit, offset);

  return c.json({
    entries: parsed.entries,
    total: parsed.total,
    ref,
  });
};

// ── GET /:slug/wiki/llms.txt ──

const llmsTxtHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  // Check cache
  const format = (c.req.query("format") || "compact") as "compact" | "full";
  const searchCache = c.env.SEARCH_CACHE as KVNamespace | undefined;
  const cacheKey = searchCache ? `wiki-llms:${orgId}/${resolved.repo.id}:${commitSha}:${format}` : null;
  if (searchCache && cacheKey) {
    const cached = await searchCache.get(cacheKey, "text");
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Cache": "HIT" },
      });
    }
  }

  // Build llms.txt
  const [pages, sources, config] = await Promise.all([
    collectPages(resolved.storage, commitSha),
    collectSources(resolved.storage, commitSha),
    readWikiConfig(resolved.storage, commitSha),
  ]);

  const wikiConfig = config || (resolved.repo.wikiConfig as WikiConfig) || {
    version: 1,
    title: resolved.repo.description || slug,
  };

  const text = generateLlmsTxt(pages, sources, wikiConfig, format);

  // Cache
  if (searchCache && cacheKey) {
    c.executionCtx.waitUntil(
      searchCache.put(cacheKey, text, { expirationTtl: 600 }).catch(() => {}),
    );
  }

  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Cache": "MISS",
      "Cache-Control": /^[0-9a-f]{40}$/i.test(ref) ? "public, max-age=31536000, immutable" : "public, max-age=60",
    },
  });
};

// ── POST /:slug/wiki/search ──

const searchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  if (!c.env.PINECONE_API_KEY || !c.env.VOYAGE_API_KEY || !c.env.PINECONE_INDEX_HOST) {
    return c.json({ error: "Semantic search not configured" }, 503);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  let body: { q: string; scope?: string; top_k?: number; tag?: string; type?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.q || typeof body.q !== "string") {
    return c.json({ error: "q (query) is required" }, 400);
  }

  // Determine path_pattern based on scope
  const scope = body.scope || "all";
  let pathPattern: string | undefined;
  if (scope === "wiki") pathPattern = "wiki/**/*.md";
  else if (scope === "sources") pathPattern = "raw/**/*";

  // Delegate to existing semantic search by making internal request
  // We build the internal fetch to reuse the full pipeline
  const searchUrl = new URL(c.req.url);
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  searchUrl.pathname = `/v1/repos/${repoPath}/semantic-search`;

  const searchBody = {
    q: body.q,
    ref: c.req.query("ref") || resolved.repo.defaultBranch,
    path_pattern: pathPattern,
    top_k: body.top_k || 10,
    expand_context: true,
  };

  // Forward to semantic search handler via internal fetch
  const internalReq = new Request(searchUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": c.req.header("x-api-key") || "",
      "x-internal-token": c.env.INTERNAL_TOKEN || "",
    },
    body: JSON.stringify(searchBody),
  });

  const app = c.env.__app;
  if (app) {
    // If we have access to the app instance, call it directly
    return app.fetch(internalReq, c.env, c.executionCtx);
  }

  // Fallback: just proxy the semantic search via fetch
  const resp = await fetch(internalReq);
  const result = await resp.json();

  // Enrich results with frontmatter for wiki pages
  if (result.results) {
    const ref = searchBody.ref;
    const commitSha = await resolveRef(resolved.storage, ref);
    if (commitSha) {
      for (const r of result.results as any[]) {
        if (r.file_path?.startsWith("wiki/") && r.file_path.endsWith(".md")) {
          const fileResult = await readFileAtPath(resolved.storage, commitSha, r.file_path);
          if (fileResult) {
            const parsed = parseFrontmatter(fileResult.content);
            r.frontmatter = parsed.frontmatter;
          }
        }
      }
    }
  }

  return c.json({ ...result, scope });
};

// ── GET /:slug/wiki/graph ──

const graphHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  // Check cache
  const searchCache = c.env.SEARCH_CACHE as KVNamespace | undefined;
  const cacheKey = searchCache ? `wiki-graph:${orgId}/${resolved.repo.id}:${commitSha}` : null;
  if (searchCache && cacheKey) {
    const cached = await searchCache.get(cacheKey, "json");
    if (cached) return c.json(cached);
  }

  const [pages, sources] = await Promise.all([
    collectPages(resolved.storage, commitSha),
    collectSources(resolved.storage, commitSha),
  ]);

  const graph = buildKnowledgeGraph(pages, sources);

  if (searchCache && cacheKey) {
    c.executionCtx.waitUntil(
      searchCache.put(cacheKey, JSON.stringify(graph), { expirationTtl: 600 }).catch(() => {}),
    );
  }

  return c.json({ ...graph, ref });
};

// ── GET /:slug/wiki/stats ──

const statsHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const ref = c.req.query("ref") || resolved.repo.defaultBranch;
  const commitSha = await resolveRef(resolved.storage, ref);
  if (!commitSha) return c.json({ error: `Ref not found: ${ref}` }, 404);

  const [pages, sources] = await Promise.all([
    collectPages(resolved.storage, commitSha),
    collectSources(resolved.storage, commitSha),
  ]);

  const graph = buildKnowledgeGraph(pages, sources);

  // Type distribution
  const types: Record<string, number> = {};
  for (const p of pages) {
    const t = p.frontmatter.type || "untyped";
    types[t] = (types[t] || 0) + 1;
  }

  // Average word count
  const totalWords = pages.reduce((sum, p) => sum + p.word_count, 0);

  // Last activity from log
  const logResult = await readFileAtPath(resolved.storage, commitSha, "log.md");
  let lastActivity: string | null = null;
  if (logResult) {
    const parsed = parseLogEntries(logResult.content, 1, 0);
    if (parsed.entries.length > 0) {
      lastActivity = parsed.entries[0].date;
    }
  }

  return c.json({
    pages: pages.length,
    sources: sources.length,
    links: graph.stats.links,
    orphans: graph.stats.orphans,
    total_words: totalWords,
    avg_words_per_page: pages.length > 0 ? Math.round(totalWords / pages.length) : 0,
    types,
    tags: Object.keys(graph.tag_clusters).length,
    last_activity: lastActivity,
    ref,
  });
};

// ═══════════════════════════════════════════
// Route registration (dual: with and without namespace)
// ═══════════════════════════════════════════

wiki.post("/:slug/wiki/init", apiKeyAuth, initHandler);
wiki.post("/:namespace/:slug/wiki/init", apiKeyAuth, initHandler);

wiki.get("/:slug/wiki/pages", apiKeyAuth, listPagesHandler);
wiki.get("/:namespace/:slug/wiki/pages", apiKeyAuth, listPagesHandler);

wiki.get("/:slug/wiki/pages/*", apiKeyAuth, getPageHandler);
wiki.get("/:namespace/:slug/wiki/pages/*", apiKeyAuth, getPageHandler);

wiki.get("/:slug/wiki/sources", apiKeyAuth, listSourcesHandler);
wiki.get("/:namespace/:slug/wiki/sources", apiKeyAuth, listSourcesHandler);

wiki.get("/:slug/wiki/sources/*", apiKeyAuth, getSourceHandler);
wiki.get("/:namespace/:slug/wiki/sources/*", apiKeyAuth, getSourceHandler);

wiki.get("/:slug/wiki/index", apiKeyAuth, getIndexHandler);
wiki.get("/:namespace/:slug/wiki/index", apiKeyAuth, getIndexHandler);

wiki.get("/:slug/wiki/log", apiKeyAuth, getLogHandler);
wiki.get("/:namespace/:slug/wiki/log", apiKeyAuth, getLogHandler);

wiki.get("/:slug/wiki/llms.txt", apiKeyAuth, llmsTxtHandler);
wiki.get("/:namespace/:slug/wiki/llms.txt", apiKeyAuth, llmsTxtHandler);

wiki.post("/:slug/wiki/search", apiKeyAuth, searchHandler);
wiki.post("/:namespace/:slug/wiki/search", apiKeyAuth, searchHandler);

wiki.get("/:slug/wiki/graph", apiKeyAuth, graphHandler);
wiki.get("/:namespace/:slug/wiki/graph", apiKeyAuth, graphHandler);

wiki.get("/:slug/wiki/stats", apiKeyAuth, statsHandler);
wiki.get("/:namespace/:slug/wiki/stats", apiKeyAuth, statsHandler);

export { wiki };
