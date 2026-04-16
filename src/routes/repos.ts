/**
 * Repository CRUD endpoints
 *
 * POST   /v1/repos          — Create repository
 * GET    /v1/repos          — List repositories
 * GET    /v1/repos/:slug    — Get repository
 * PATCH  /v1/repos/:slug    — Update repository
 * DELETE /v1/repos/:slug    — Delete repository
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq, and, or, isNull, sql, desc } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { createTree, createCommit, hashGitObject, createGitObjectRaw, parseGitObject, parseCommit } from "../git/objects";
import { recordUsage } from "../services/usage";
import { recordAudit } from "../services/audit";
import { deleteNamespace } from "../services/pinecone";
import { checkFreeLimits } from "../services/limits";
import { isMasterKey, hasRepoAccess, getAccessibleRepoKeys } from "../auth/scopes";
import { resolveRepo, buildGitUrl, buildApiUrl, invalidateRepoCache, getOrgSlug, attachRepoHotDO } from "../services/repo-resolver";
import { extractRepoParams, validateNamespace } from "./helpers";
import type { Env, Variables } from "../types";

const repos = new Hono<{ Bindings: Env; Variables: Variables }>();

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;

// Git empty tree SHA — well-known constant: SHA-1("tree 0\0") = 4b825dc...
// Avoids an async crypto.subtle.digest call on every repo creation.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf899d15006ef8a2f";
const EMPTY_TREE_BYTES = createTree([]);

function validateSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !slug.includes("--");
}

// POST /v1/repos
repos.post("/", apiKeyAuth, async (c) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can create repositories" }, 403);
  }
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;

  let body: {
    slug: string;
    namespace?: string;
    description?: string;
    default_branch?: string;
    visibility?: string;
    init?: boolean;
    is_template?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { slug, namespace, description, default_branch = "main", visibility = "private", init = true, is_template = false } = body;

  if (!slug || typeof slug !== "string") {
    return c.json({ error: "slug is required" }, 400);
  }
  if (!validateSlug(slug)) {
    return c.json({ error: "Invalid slug. Use lowercase letters, numbers, hyphens. 1-100 chars." }, 400);
  }
  if (namespace !== undefined && namespace !== null) {
    if (typeof namespace !== "string" || !validateNamespace(namespace)) {
      return c.json({ error: "Invalid namespace. Use lowercase letters, numbers, hyphens. 1-100 chars." }, 400);
    }
  }
  if (visibility !== "public" && visibility !== "private") {
    return c.json({ error: "visibility must be 'public' or 'private'" }, 400);
  }
  if (description && description.length > 500) {
    return c.json({ error: "Description must be at most 500 characters" }, 400);
  }

  try {
    const ns = namespace || null;

    // Parallel: check free limits + uniqueness + pre-fetch org slug (3 DB/KV ops → 1 round-trip)
    const [repoLimit, existingRepo, orgSlug] = await Promise.all([
      checkFreeLimits(db, orgId, c.get("orgTier"), "repo_created"),
      resolveRepo(db, bucket, { orgId, slug, namespace: ns }),
      getOrgSlug(db, orgId),
    ]);

    if (!repoLimit.allowed) {
      return c.json({
        error: "Free tier limit exceeded: repositories",
        used: repoLimit.used,
        limit: repoLimit.limit,
        upgrade_url: "https://app.coregit.dev/dashboard/billing",
      }, 429);
    }
    if (existingRepo) {
      return c.json({ error: "A repository with this slug already exists" }, 409);
    }

    const repoId = nanoid();

    // Pre-compute git objects (CPU-only, no I/O) before DB+R2 parallel writes
    const storageSuffix = ns ? `${ns}/${slug}` : slug;
    let commitSha: string | undefined;
    let commitContent: Uint8Array | undefined;

    if (init) {
      // Tree SHA is a well-known constant (empty tree), no need to hash.
      // Only the commit needs async SHA-1 (timestamp varies per call).
      const timestamp = Math.floor(Date.now() / 1000);
      const identity = `CoreGit <noreply@coregit.dev> ${timestamp} +0000`;
      commitContent = createCommit({
        tree: EMPTY_TREE_SHA,
        parents: [],
        author: identity,
        committer: identity,
        message: "Initial commit",
      });
      commitSha = await hashGitObject("commit", commitContent);
    }

    // Parallel: DB insert + R2 storage init (independent operations)
    const storage = new GitR2Storage(bucket, orgId, storageSuffix);
    storage.setRefCacheKv(c.env.AUTH_CACHE as KVNamespace | undefined);
    storage.setObjCacheKv(c.env.GIT_OBJ_CACHE as KVNamespace | undefined);
    attachRepoHotDO(storage, orgId, storageSuffix, repoId);
    const [dbResult] = await Promise.all([
      db.insert(repo).values({
        id: repoId,
        orgId,
        namespace: ns,
        slug,
        description: description || null,
        defaultBranch: default_branch,
        visibility,
        isTemplate: is_template,
      }).returning(),
      init
        ? Promise.all([
            storage.setHead(`refs/heads/${default_branch}`),
            storage.putObject(EMPTY_TREE_SHA, "tree", EMPTY_TREE_BYTES),
            storage.putObject(commitSha!, "commit", commitContent!),
            storage.setRef(`refs/heads/${default_branch}`, commitSha!),
          ])
        : storage.setHead(`refs/heads/${default_branch}`),
    ]);

    const [newRepo] = dbResult;

    // Track usage + audit (fire-and-forget, already non-blocking)
    recordUsage(c.executionCtx, db, orgId, "repo_created", 1, { repo_id: repoId }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));
    recordAudit(c.executionCtx, db, {
      orgId, actorId: c.get("apiKeyId"), actorType: "master_key",
      action: "repo.create", resourceType: "repo", resourceId: repoId,
      metadata: { slug, namespace: ns }, requestId: c.get("requestId"),
    });

    return c.json(
      {
        id: newRepo.id,
        namespace: newRepo.namespace,
        slug: newRepo.slug,
        description: newRepo.description,
        default_branch: newRepo.defaultBranch,
        visibility: newRepo.visibility,
        is_template: newRepo.isTemplate,
        git_url: buildGitUrl(orgSlug, slug, ns, c.get("customDomain")),
        api_url: buildApiUrl(slug, ns),
        created_at: newRepo.createdAt,
      },
      201
    );
  } catch (error) {
    console.error("Failed to create repo:", error);
    return c.json({ error: "Failed to create repository" }, 500);
  }
});

// Cursor helpers for keyset pagination
function encodeCursor(updatedAt: Date, id: string): string {
  return btoa(`${updatedAt.toISOString()}|${id}`);
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const decoded = atob(cursor);
    const pipe = decoded.indexOf("|");
    if (pipe === -1) return null;
    const ts = new Date(decoded.slice(0, pipe));
    const id = decoded.slice(pipe + 1);
    if (isNaN(ts.getTime()) || !id) return null;
    return { updatedAt: ts, id };
  } catch {
    return null;
  }
}

// GET /v1/repos
const LIST_REPOS_CACHE_TTL = 30; // 30s — short TTL, no invalidation needed

repos.get("/", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const cursor = c.req.query("cursor");
  const nsFilter = c.req.query("namespace");
  const templateFilter = c.req.query("is_template");

  // Backward compat: offset still works when no cursor provided
  const offset = cursor ? 0 : Math.max(parseInt(c.req.query("offset") || "0", 10), 0);

  // KV cache for master key (non-scoped) requests
  const accessibleKeys = getAccessibleRepoKeys(c.get("apiKeyPermissions"));
  const authCache = c.env.AUTH_CACHE as KVNamespace | undefined;
  const isCacheable = accessibleKeys === null && authCache; // only cache master key requests

  if (isCacheable) {
    const cacheKey = `repos:${orgId}:${limit}:${cursor || ""}:${nsFilter || ""}:${templateFilter || ""}:${offset}`;
    const cached = await authCache.get(cacheKey, "json");
    if (cached) return c.json(cached);
  }

  try {
    let conditions: ReturnType<typeof eq> | ReturnType<typeof and> = eq(repo.orgId, orgId);
    if (nsFilter) {
      conditions = and(conditions, eq(repo.namespace, nsFilter))!;
    }
    if (templateFilter === "true") {
      conditions = and(conditions, eq(repo.isTemplate, true))!;
    }

    // Scoped tokens: push scope filter to SQL for correct pagination
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
      return c.json({ repos: [], limit, next_cursor: null });
    }

    // Keyset pagination: if cursor is provided, add WHERE clause
    if (cursor) {
      const parsed = decodeCursor(cursor);
      if (!parsed) {
        return c.json({ error: "Invalid cursor", code: "VALIDATION_ERROR" }, 400);
      }
      // (updated_at, id) < (cursor_updated_at, cursor_id) for DESC order
      conditions = and(
        conditions,
        sql`(${repo.updatedAt}, ${repo.id}) < (${parsed.updatedAt.toISOString()}::timestamptz, ${parsed.id})`
      )!;
    }

    const repoList = await db
      .select()
      .from(repo)
      .where(conditions)
      .orderBy(desc(repo.updatedAt), desc(repo.id))
      .limit(limit + 1)  // fetch one extra to detect next page
      .offset(cursor ? 0 : offset);

    const hasMore = repoList.length > limit;
    const results = hasMore ? repoList.slice(0, limit) : repoList;
    const nextCursor = hasMore
      ? encodeCursor(results[results.length - 1].updatedAt, results[results.length - 1].id)
      : null;

    const response = {
      repos: results.map((r) => ({
        id: r.id,
        namespace: r.namespace,
        slug: r.slug,
        description: r.description,
        default_branch: r.defaultBranch,
        visibility: r.visibility,
        is_template: r.isTemplate,
        forked_from: r.forkedFromRepoId ? { repo_id: r.forkedFromRepoId, org_id: r.forkedFromOrgId } : null,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
      limit,
      next_cursor: nextCursor,
      ...(cursor ? {} : { offset }),
    };

    // Cache result (fire-and-forget)
    if (isCacheable) {
      const cacheKey = `repos:${orgId}:${limit}:${cursor || ""}:${nsFilter || ""}:${templateFilter || ""}:${offset}`;
      authCache.put(cacheKey, JSON.stringify(response), { expirationTtl: LIST_REPOS_CACHE_TTL }).catch(() => {});
    }

    return c.json(response);
  } catch (error) {
    console.error("Failed to list repos:", error);
    return c.json({ error: "Failed to list repositories" }, 500);
  }
});

// GET /v1/repos/:slug  and  GET /v1/repos/:namespace/:slug
const getRepoHandler = async (c: any) => {
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
  const storage = resolved.storage;

  try {
    const headSha = await storage.resolveHead();
    let isEmpty = !headSha;

    if (headSha) {
      const raw = await storage.getObject(headSha);
      if (raw) {
        const obj = parseGitObject(raw);
        if (obj.type === "commit") {
          const commit = parseCommit(obj.content);
          const treeRaw = await storage.getObject(commit.tree);
          if (treeRaw) {
            const treeObj = parseGitObject(treeRaw);
            isEmpty = treeObj.content.length === 0;
          }
        }
      }
    }

    const orgSlug = await getOrgSlug(db, orgId);

    return c.json({
      id: found.id,
      namespace: found.namespace,
      slug: found.slug,
      description: found.description,
      default_branch: found.defaultBranch,
      visibility: found.visibility,
      is_template: found.isTemplate,
      forked_from: found.forkedFromRepoId
        ? { repo_id: found.forkedFromRepoId, org_id: found.forkedFromOrgId }
        : null,
      is_empty: isEmpty,
      git_url: buildGitUrl(orgSlug, found.slug, found.namespace, c.get("customDomain")),
      api_url: buildApiUrl(found.slug, found.namespace),
      created_at: found.createdAt,
      updated_at: found.updatedAt,
    });
  } catch (error) {
    console.error("Failed to get repo:", error);
    return c.json({ error: "Failed to get repository" }, 500);
  }
};
repos.get("/:slug", apiKeyAuth, getRepoHandler);
repos.get("/:namespace/:slug", apiKeyAuth, getRepoHandler);

// PATCH /v1/repos/:slug  and  PATCH /v1/repos/:namespace/:slug
const patchRepoHandler = async (c: any) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can update repositories" }, 403);
  }
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  let body: { description?: string; visibility?: string; default_branch?: string; is_template?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
    if (!resolved) return c.json({ error: "Repository not found" }, 404);
    const found = resolved.repo;

    const updates: Partial<typeof repo.$inferInsert> = {};
    if (body.description !== undefined) updates.description = body.description;
    if (body.visibility !== undefined) {
      if (body.visibility !== "public" && body.visibility !== "private") {
        return c.json({ error: "visibility must be 'public' or 'private'" }, 400);
      }
      updates.visibility = body.visibility;
    }
    if (body.is_template !== undefined) {
      updates.isTemplate = body.is_template;
    }
    if (body.default_branch !== undefined) {
      const branchSha = await resolved.storage.getRef(`refs/heads/${body.default_branch}`);
      if (!branchSha) {
        return c.json({ error: `Branch '${body.default_branch}' does not exist` }, 400);
      }
      updates.defaultBranch = body.default_branch;
      await resolved.storage.setHead(`refs/heads/${body.default_branch}`);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const [updated] = await db
      .update(repo)
      .set(updates)
      .where(eq(repo.id, found.id))
      .returning();

    // Invalidate repo cache
    c.executionCtx.waitUntil(invalidateRepoCache(c.env.AUTH_CACHE, orgId, slug, namespace));

    recordAudit(c.executionCtx, db, {
      orgId, actorId: c.get("apiKeyId"), actorType: "master_key",
      action: "repo.update", resourceType: "repo", resourceId: found.id,
      metadata: { fields: Object.keys(updates) }, requestId: c.get("requestId"),
    });

    return c.json({
      id: updated.id,
      namespace: updated.namespace,
      slug: updated.slug,
      description: updated.description,
      default_branch: updated.defaultBranch,
      visibility: updated.visibility,
      is_template: updated.isTemplate,
      updated_at: updated.updatedAt,
    });
  } catch (error) {
    console.error("Failed to update repo:", error);
    return c.json({ error: "Failed to update repository" }, 500);
  }
};
repos.patch("/:slug", apiKeyAuth, patchRepoHandler);
repos.patch("/:namespace/:slug", apiKeyAuth, patchRepoHandler);

// DELETE /v1/repos/:slug  and  DELETE /v1/repos/:namespace/:slug
const deleteRepoHandler = async (c: any) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can delete repositories" }, 403);
  }
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  try {
    const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
    if (!resolved) return c.json({ error: "Repository not found" }, 404);
    const found = resolved.repo;

    // Delete R2 storage
    const storageSuffix = found.namespace ? `${found.namespace}/${found.slug}` : found.slug;
    const basePath = `${orgId}/${storageSuffix}/`;
    let cursor: string | undefined;
    const keysToDelete: string[] = [];

    do {
      const listed = await bucket.list({ prefix: basePath, cursor });
      for (const obj of listed.objects) {
        keysToDelete.push(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    for (let i = 0; i < keysToDelete.length; i += 1000) {
      await bucket.delete(keysToDelete.slice(i, i + 1000));
    }

    // Delete Pinecone namespace (one per repo, content-addressed)
    if (c.env.PINECONE_API_KEY && c.env.PINECONE_INDEX_HOST) {
      c.executionCtx.waitUntil(
        deleteNamespace(
          c.env.PINECONE_INDEX_HOST!, c.env.PINECONE_API_KEY!,
          `${orgId}/${found.id}`
        ).catch((err) => console.error("Failed to delete Pinecone namespace:", err))
      );
    }

    // Delete DB record (cascades to snapshots + semantic_index)
    await db.delete(repo).where(eq(repo.id, found.id));

    // Invalidate repo cache
    c.executionCtx.waitUntil(invalidateRepoCache(c.env.AUTH_CACHE, orgId, found.slug, found.namespace));

    recordUsage(c.executionCtx, db, orgId, "repo_deleted", 1, { repo_id: found.id }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));
    recordAudit(c.executionCtx, db, {
      orgId, actorId: c.get("apiKeyId"), actorType: "master_key",
      action: "repo.delete", resourceType: "repo", resourceId: found.id,
      metadata: { slug: found.slug }, requestId: c.get("requestId"),
    });

    return c.json({ deleted: true });
  } catch (error) {
    console.error("Failed to delete repo:", error);
    return c.json({ error: "Failed to delete repository" }, 500);
  }
};
repos.delete("/:slug", apiKeyAuth, deleteRepoHandler);
repos.delete("/:namespace/:slug", apiKeyAuth, deleteRepoHandler);

export { repos };
