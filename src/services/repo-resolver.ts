/**
 * Centralized repo resolution.
 *
 * Every handler that needs a repo should use resolveRepo() instead of
 * inline DB queries. This centralizes namespace logic, storage path
 * composition, scope key generation, and URL building.
 */

import { eq, and, isNull } from "drizzle-orm";
import { repo, organization, forkSnapshot } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import type { Database } from "../db";
import type { Repo } from "../db/schema";

export interface RepoIdentifier {
  orgId: string;
  slug: string;
  namespace?: string | null;
}

export interface ResolvedRepo {
  repo: Repo;
  storage: GitR2Storage;
  /** "namespace/slug" or "slug" — used for scope checks and URLs */
  scopeKey: string;
  /** R2 storage path suffix — used for queue messages */
  storageSuffix: string;
}

const REPO_CACHE_TTL = 600; // 10 minutes — repos rarely change metadata, invalidated on PATCH/DELETE

// Module-level ref for per-repo hot layer DO
let _repoHotDORef: DurableObjectNamespace | undefined;

export function setRepoHotDORef(ns: DurableObjectNamespace | undefined) {
  _repoHotDORef = ns;
}

// Module-level ref for KV ref caching (set by middleware, used by resolveRepo)
let _refCacheKvRef: KVNamespace | undefined;

export function setRefCacheKvRef(kv: KVNamespace | undefined) {
  _refCacheKvRef = kv;
}

// Module-level ref for KV object caching (immutable SHA-addressed git objects)
let _objCacheKvRef: KVNamespace | undefined;

export function setObjCacheKvRef(kv: KVNamespace | undefined) {
  _objCacheKvRef = kv;
}

// "_" is safe as null-namespace placeholder: NAMESPACE_REGEX only allows [a-z0-9-], never "_"
function repoCacheKey(orgId: string, slug: string, namespace?: string | null): string {
  return `repo:${orgId}:${namespace || "_"}:${slug}`;
}

/**
 * Look up a repo by org + optional namespace + slug.
 * Uses KV cache (60s TTL) when AUTH_CACHE is available.
 * Returns null if not found.
 */
// Module-level cache ref — set by DB middleware, used by resolveRepo.
// Safe with concurrent requests: c.env.AUTH_CACHE is the same KVNamespace binding
// for all requests in an isolate, so the value is always identical.
// This avoids changing 75+ call sites.
let _authCacheRef: KVNamespace | undefined;

export function setRepoCacheRef(kv: KVNamespace | undefined) {
  _authCacheRef = kv;
}

export async function resolveRepo(
  db: Database,
  bucket: R2Bucket,
  id: RepoIdentifier,
): Promise<ResolvedRepo | null> {
  const { orgId, slug, namespace } = id;
  const cacheKey = repoCacheKey(orgId, slug, namespace);
  const authCache = _authCacheRef;

  // Check KV cache
  if (authCache) {
    const cached = await authCache.get(cacheKey, "json") as Repo | null;
    if (cached) {
      const storageSuffix = cached.namespace ? `${cached.namespace}/${cached.slug}` : cached.slug;
      const storage = new GitR2Storage(bucket, orgId, storageSuffix);
      storage.setRefCacheKv(_refCacheKvRef);
      storage.setObjCacheKv(_objCacheKvRef);
      storage.setBlobRepoContext(db, cached.id, orgId);
      // Instant fork: load fork_snapshot lazily — it's cheap (one PK lookup)
      // and populates ref/HEAD fallback for forks that haven't pushed yet.
      // Also attach parent's storage as object read-fallback so blob/tree
      // reads can resolve through the chain when objects aren't in the
      // global `_blobs/` keyspace (parent's legacy paths, packfiles, DO).
      if (cached.forkMode === "instant" && cached.forkedFromRepoId) {
        await loadForkSnapshot(db, storage, cached.id);
        if (cached.forkedFromOrgId) {
          const parentStorage = await loadParentStorageChain(
            db, bucket, cached.forkedFromRepoId, cached.forkedFromOrgId, 0,
          );
          if (parentStorage) storage.setForkParentStorage(parentStorage);
        }
      }
      attachRepoHotDO(storage, orgId, storageSuffix, cached.id);
      const scopeKey = cached.namespace ? `${cached.namespace}/${cached.slug}` : cached.slug;
      return { repo: cached, storage, scopeKey, storageSuffix };
    }
  }

  const condition = namespace
    ? and(eq(repo.orgId, orgId), eq(repo.namespace, namespace), eq(repo.slug, slug))
    : and(eq(repo.orgId, orgId), isNull(repo.namespace), eq(repo.slug, slug));

  const [found] = await db
    .select()
    .from(repo)
    .where(condition)
    .limit(1);

  if (!found) return null;

  // Cache the result (fire-and-forget)
  if (authCache) {
    authCache.put(cacheKey, JSON.stringify(found), { expirationTtl: REPO_CACHE_TTL }).catch((e) => console.error("Repo cache write failed:", e));
  }

  const storageSuffix = namespace ? `${namespace}/${slug}` : slug;
  const storage = new GitR2Storage(bucket, orgId, storageSuffix);
  storage.setRefCacheKv(_refCacheKvRef);
  storage.setObjCacheKv(_objCacheKvRef);
  storage.setBlobRepoContext(db, found.id, orgId);
  if (found.forkMode === "instant" && found.forkedFromRepoId) {
    await loadForkSnapshot(db, storage, found.id);
    if (found.forkedFromOrgId) {
      const parentStorage = await loadParentStorageChain(
        db, bucket, found.forkedFromRepoId, found.forkedFromOrgId, 0,
      );
      if (parentStorage) storage.setForkParentStorage(parentStorage);
    }
  }
  attachRepoHotDO(storage, orgId, storageSuffix, found.id);
  const scopeKey = namespace ? `${namespace}/${slug}` : slug;

  return { repo: found, storage, scopeKey, storageSuffix };
}

/** Safety cap matching MAX_FORK_DEPTH in routes/forks.ts. Auto-flatten on
 * fork creation already prevents chains longer than this; the cap here is
 * belt-and-suspenders against malformed rows. */
const MAX_PARENT_CHAIN = 16;

/**
 * Build the read-only parent storage for an instant fork. Recurses up the
 * fork chain so a depth-N fork can resolve objects that live anywhere along
 * its ancestor line (legacy `{base}/objects/`, packfiles, hot DO).
 *
 * Returns null if the chain is missing/broken — getObject still works against
 * the global `_blobs/` keyspace, only legacy-path/DO fallback is lost.
 */
async function loadParentStorageChain(
  db: Database,
  bucket: R2Bucket,
  parentRepoId: string,
  parentOrgId: string,
  depth: number,
): Promise<GitR2Storage | null> {
  if (depth >= MAX_PARENT_CHAIN) return null;
  try {
    const [parentRepo] = await db
      .select()
      .from(repo)
      .where(eq(repo.id, parentRepoId))
      .limit(1);
    if (!parentRepo) return null;

    const parentSuffix = parentRepo.namespace
      ? `${parentRepo.namespace}/${parentRepo.slug}`
      : parentRepo.slug;
    const parentStorage = new GitR2Storage(bucket, parentOrgId, parentSuffix);
    parentStorage.setRefCacheKv(_refCacheKvRef);
    parentStorage.setObjCacheKv(_objCacheKvRef);
    // Intentionally NO setBlobRepoContext on the parent — reads don't write
    // blob_repo edges, and we don't want the fork's read path to record
    // refcount rows on the parent's behalf.

    if (parentRepo.forkMode === "instant" && parentRepo.forkedFromRepoId) {
      await loadForkSnapshot(db, parentStorage, parentRepo.id);
      if (parentRepo.forkedFromOrgId) {
        const grandparent = await loadParentStorageChain(
          db,
          bucket,
          parentRepo.forkedFromRepoId,
          parentRepo.forkedFromOrgId,
          depth + 1,
        );
        if (grandparent) parentStorage.setForkParentStorage(grandparent);
      }
    }

    // Attach parent's hot DO so the fork can read very-recent commits that
    // the parent hasn't flushed to R2 yet.
    attachRepoHotDO(parentStorage, parentOrgId, parentSuffix, parentRepo.id);

    return parentStorage;
  } catch (e) {
    console.error("loadParentStorageChain failed:", e);
    return null;
  }
}

/**
 * Load fork_snapshot row (if any) and attach to storage. Failure to load is
 * non-fatal — the fork still serves blobs by SHA, only ref-fallback is missing.
 */
async function loadForkSnapshot(db: Database, storage: GitR2Storage, repoId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ parentRefs: forkSnapshot.parentRefs, parentHead: forkSnapshot.parentHead })
      .from(forkSnapshot)
      .where(eq(forkSnapshot.repoId, repoId))
      .limit(1);
    if (row) {
      storage.setForkSnapshot({
        parentRefs: row.parentRefs as Record<string, string>,
        parentHead: row.parentHead,
      });
    }
  } catch (e) {
    console.error("loadForkSnapshot failed:", e);
  }
}

/**
 * Attach per-repo hot layer DO to storage instance.
 * Called automatically by resolveRepo — every request gets hot layer for free.
 */
export function attachRepoHotDO(storage: GitR2Storage, orgId: string, storageSuffix: string, repoId: string) {
  if (!_repoHotDORef) return;
  const doId = _repoHotDORef.idFromName(repoId);
  const stub = _repoHotDORef.get(doId);
  storage.setRepoDOStub(stub, `${orgId}/${storageSuffix}`);
}

/**
 * Invalidate cached repo data. Call after PATCH, DELETE, or creation.
 */
export async function invalidateRepoCache(
  authCache: KVNamespace | undefined,
  orgId: string,
  slug: string,
  namespace?: string | null,
): Promise<void> {
  if (!authCache) return;
  await authCache.delete(repoCacheKey(orgId, slug, namespace)).catch(() => {});
}

const ORG_SLUG_CACHE_TTL = 1800; // 30 minutes — org slugs never change

/**
 * In-memory org slug preload — populated by auth middleware from CachedAuth.orgSlug.
 * Saves a KV lookup (~5ms) on every request that calls getOrgSlug().
 * Safe with concurrent requests: org slugs are immutable, so stale entries are fine.
 */
const _orgSlugPreload = new Map<string, string>();
const ORG_SLUG_PRELOAD_MAX = 500;

export function preloadOrgSlug(orgId: string, slug: string): void {
  if (_orgSlugPreload.size >= ORG_SLUG_PRELOAD_MAX && !_orgSlugPreload.has(orgId)) {
    // Evict oldest entry
    const first = _orgSlugPreload.keys().next().value;
    if (first) _orgSlugPreload.delete(first);
  }
  _orgSlugPreload.set(orgId, slug);
}

/**
 * Look up an organization's slug by ID.
 * Check order: in-memory preload → AUTH_CACHE KV → DB.
 * Falls back to orgId if the org record is missing.
 */
export async function getOrgSlug(db: Database, orgId: string): Promise<string> {
  // In-memory preload (populated by auth middleware, ~0ms)
  const preloaded = _orgSlugPreload.get(orgId);
  if (preloaded) return preloaded;

  const authCache = _authCacheRef;
  const cacheKey = `orgslug:${orgId}`;

  if (authCache) {
    const cached = await authCache.get(cacheKey, "text");
    if (cached) return cached;
  }

  const [org] = await db
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);

  const slug = org?.slug || orgId;

  if (authCache) {
    authCache.put(cacheKey, slug, { expirationTtl: ORG_SLUG_CACHE_TTL })
      .catch((e) => console.error("Org slug cache write failed:", e));
  }

  return slug;
}

/**
 * Build a git clone URL for a repo.
 */
export function buildGitUrl(
  orgSlug: string,
  slug: string,
  namespace: string | null | undefined,
  customDomain: string | null | undefined
): string {
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  return customDomain
    ? `https://${customDomain}/${repoPath}.git`
    : `https://api.coregit.dev/${orgSlug}/${repoPath}.git`;
}

/**
 * Build a REST API URL for a repo.
 */
export function buildApiUrl(
  slug: string,
  namespace: string | null | undefined
): string {
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  return `https://api.coregit.dev/v1/repos/${repoPath}`;
}
