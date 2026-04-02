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
}

/**
 * Look up a repo by org + optional namespace + slug.
 * Returns null if not found.
 */
export async function resolveRepo(
  db: Database,
  bucket: R2Bucket,
  id: RepoIdentifier
): Promise<ResolvedRepo | null> {
  const { orgId, slug, namespace } = id;

  const condition = namespace
    ? and(eq(repo.orgId, orgId), eq(repo.namespace, namespace), eq(repo.slug, slug))
    : and(eq(repo.orgId, orgId), isNull(repo.namespace), eq(repo.slug, slug));

  const [found] = await db
    .select()
    .from(repo)
    .where(condition)
    .limit(1);

  if (!found) return null;

  const storageSuffix = namespace ? `${namespace}/${slug}` : slug;
  const storage = new GitR2Storage(bucket, orgId, storageSuffix);
  const scopeKey = namespace ? `${namespace}/${slug}` : slug;

  return { repo: found, storage, scopeKey };
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
