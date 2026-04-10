/**
 * Fork graph copy service.
 * Copies code graph nodes and edges from a source repo to a fork,
 * remapping IDs to use the target repo's ID prefix.
 */

import { sql } from "drizzle-orm";
import { codeNode, codeEdge } from "../db/schema";
import type { Database } from "../db";

/**
 * Copy all code graph nodes and edges from source repo to target repo.
 * Node IDs are repo-prefixed: {repoId}:{blobSha}:{type}:{name}
 * So we replace the source repoId prefix with the target repoId.
 */
export async function copyGraphForFork(
  db: Database,
  sourceRepoId: string,
  sourceOrgId: string,
  targetRepoId: string,
  targetOrgId: string
): Promise<{ nodesCount: number; edgesCount: number }> {
  // Copy nodes: replace repoId prefix in ID, update repo_id and org_id
  const nodesResult = await db.execute(sql`
    INSERT INTO code_node (id, type, name, file_path, blob_sha, repo_id, org_id,
      start_line, end_line, signature, language, exported, complexity, community_id)
    SELECT
      ${targetRepoId} || substr(id, length(${sourceRepoId}) + 1),
      type, name, file_path, blob_sha,
      ${targetRepoId}, ${targetOrgId},
      start_line, end_line, signature, language, exported, complexity, community_id
    FROM code_node
    WHERE repo_id = ${sourceRepoId}
    ON CONFLICT (id) DO NOTHING
  `);

  const nodesCount = (nodesResult as any).rowCount || 0;

  // Copy edges: remap source_id and target_id prefixes, update repo_id
  const edgesResult = await db.execute(sql`
    INSERT INTO code_edge (id, source_id, target_id, type, repo_id)
    SELECT
      ${targetRepoId} || substr(source_id, length(${sourceRepoId}) + 1)
        || '->' || type || '->'
        || CASE
          WHEN target_id LIKE '__unresolved:%' THEN target_id
          ELSE ${targetRepoId} || substr(target_id, length(${sourceRepoId}) + 1)
        END,
      ${targetRepoId} || substr(source_id, length(${sourceRepoId}) + 1),
      CASE
        WHEN target_id LIKE '__unresolved:%' THEN target_id
        ELSE ${targetRepoId} || substr(target_id, length(${sourceRepoId}) + 1)
      END,
      type,
      ${targetRepoId}
    FROM code_edge
    WHERE repo_id = ${sourceRepoId}
    ON CONFLICT (id) DO NOTHING
  `);

  const edgesCount = (edgesResult as any).rowCount || 0;

  return { nodesCount, edgesCount };
}
