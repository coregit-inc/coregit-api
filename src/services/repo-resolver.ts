/**
 * Centralized repo resolution.
 *
 * Every handler that needs a repo should use resolveRepo() instead of
 * inline DB queries. This centralizes namespace logic, storage path
 * composition, scope key generation, and URL building.
 */

import { eq, and, isNull } from "drizzle-orm";
import { repo } from "../db/schema";
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

const REPO_CACHE_TTL = 60; // seconds

function repoCacheKey(orgId: string, slug: string, namespace?: string | null): string {
  return `repo:${orgId}:${namespace || "_"}:${slug}`;
}

/**
 * Look up a repo by org + optional namespace + slug.
 * Uses KV cache (60s TTL) when AUTH_CACHE is available.
 * Returns null if not found.
 */
// Module-level cache ref — set once per request by middleware, used by resolveRepo.
// This avoids changing 75+ call sites. The auth middleware sets this via setRepoCacheRef().
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
    authCache.put(cacheKey, JSON.stringify(found), { expirationTtl: REPO_CACHE_TTL }).catch(() => {});
  }

  const storageSuffix = namespace ? `${namespace}/${slug}` : slug;
  const storage = new GitR2Storage(bucket, orgId, storageSuffix);
  const scopeKey = namespace ? `${namespace}/${slug}` : slug;

  return { repo: found, storage, scopeKey, storageSuffix };
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
