/**
 * Helper that turns a Repo row into the set of search targets a query should
 * cover. For an instant fork that hasn't materialized its semantic / graph
 * indices, queries fan out across the parent's namespace as well.
 */
import type { Repo } from "../db/schema";

export interface SearchTargets {
  /** Pinecone namespace + graph repoId for the fork itself. */
  selfNs: string;
  selfRepoId: string;
  /** Parent's namespace, if this repo is an instant fork. null otherwise. */
  parentNs: string | null;
  parentRepoId: string | null;
  /** Repo IDs to scan for code graph queries. Always at least [self]. */
  graphRepoIds: string[];
}

export function resolveSearchTargets(repo: Repo): SearchTargets {
  const selfNs = `${repo.orgId}/${repo.id}`;
  if (
    repo.forkMode === "instant" &&
    repo.forkedFromRepoId &&
    repo.forkedFromOrgId
  ) {
    return {
      selfNs,
      selfRepoId: repo.id,
      parentNs: `${repo.forkedFromOrgId}/${repo.forkedFromRepoId}`,
      parentRepoId: repo.forkedFromRepoId,
      graphRepoIds: [repo.id, repo.forkedFromRepoId],
    };
  }
  // Non-fork or 'copied'/deep fork → fully self-contained.
  return {
    selfNs,
    selfRepoId: repo.id,
    parentNs: null,
    parentRepoId: null,
    graphRepoIds: [repo.id],
  };
}
