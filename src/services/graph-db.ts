/**
 * Graph query functions for code intelligence.
 *
 * All queries accept a Set<blobSha> for version-aware filtering.
 * Uses ANY() for blob SHA filtering (same pattern as semantic search).
 * All recursive CTEs have LIMIT on final SELECT (DoS protection).
 *
 * Uses Drizzle ORM + Neon serverless (HTTP).
 */

import { sql } from "drizzle-orm";
import { codeNode, codeEdge } from "../db/schema";
import type { Database } from "../db";
import type { CodeNode } from "../db/schema";

// ── Types ──

export interface GraphQueryResult {
  nodes: CodeNode[];
  edges?: Array<{ source_id: string; target_id: string; type: string }>;
}

const RESULT_LIMIT = 200;

// ── Query Functions ──

export async function queryCallers(
  db: Database, repoId: string, targetName: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT DISTINCT n.*
    FROM code_node n
    JOIN code_edge e ON e.source_id = n.id
    JOIN code_node t ON e.target_id = t.id
    WHERE e.type = 'CALLS' AND e.repo_id = ${repoId}
      AND t.name = ${targetName} AND t.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs}) AND t.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function queryCallees(
  db: Database, repoId: string, sourceName: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT DISTINCT n.*
    FROM code_node n
    JOIN code_edge e ON e.target_id = n.id
    JOIN code_node s ON e.source_id = s.id
    WHERE e.type = 'CALLS' AND e.repo_id = ${repoId}
      AND s.name = ${sourceName} AND s.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs}) AND s.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function queryDependencies(
  db: Database, repoId: string, name: string, blobShas: Set<string>, maxDepth: number = 3
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    WITH RECURSIVE deps AS (
      SELECT e.target_id AS id, 1 AS depth
      FROM code_edge e
      JOIN code_node s ON e.source_id = s.id
      WHERE e.type IN ('CALLS', 'IMPORTS', 'USES_TYPE')
        AND e.repo_id = ${repoId}
        AND s.name = ${name} AND s.repo_id = ${repoId}
        AND s.blob_sha = ANY(${blobs})
      UNION
      SELECT e.target_id, d.depth + 1
      FROM code_edge e JOIN deps d ON e.source_id = d.id
      WHERE e.type IN ('CALLS', 'IMPORTS', 'USES_TYPE')
        AND e.repo_id = ${repoId} AND d.depth < ${maxDepth}
    )
    SELECT DISTINCT n.*
    FROM code_node n JOIN deps d ON n.id = d.id
    WHERE n.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function queryDependents(
  db: Database, repoId: string, name: string, blobShas: Set<string>, maxDepth: number = 3
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    WITH RECURSIVE deps AS (
      SELECT e.source_id AS id, 1 AS depth
      FROM code_edge e
      JOIN code_node t ON e.target_id = t.id
      WHERE e.type IN ('CALLS', 'IMPORTS', 'USES_TYPE')
        AND e.repo_id = ${repoId}
        AND t.name = ${name} AND t.repo_id = ${repoId}
        AND t.blob_sha = ANY(${blobs})
      UNION
      SELECT e.source_id, d.depth + 1
      FROM code_edge e JOIN deps d ON e.target_id = d.id
      WHERE e.type IN ('CALLS', 'IMPORTS', 'USES_TYPE')
        AND e.repo_id = ${repoId} AND d.depth < ${maxDepth}
    )
    SELECT DISTINCT n.*
    FROM code_node n JOIN deps d ON n.id = d.id
    WHERE n.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

/**
 * Type hierarchy with path tracking to prevent infinite loops.
 */
export async function queryTypeHierarchy(
  db: Database, repoId: string, name: string, blobShas: Set<string>, maxDepth: number = 3
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    WITH RECURSIVE hierarchy AS (
      SELECT n.id, 0 AS depth, ARRAY[n.id] AS path
      FROM code_node n
      WHERE n.name = ${name} AND n.repo_id = ${repoId}
        AND n.blob_sha = ANY(${blobs})
      UNION
      SELECT
        CASE WHEN e.source_id = h.id THEN e.target_id ELSE e.source_id END,
        h.depth + 1,
        h.path || CASE WHEN e.source_id = h.id THEN e.target_id ELSE e.source_id END
      FROM code_edge e
      JOIN hierarchy h ON (e.source_id = h.id OR e.target_id = h.id)
      WHERE e.type IN ('EXTENDS', 'IMPLEMENTS')
        AND e.repo_id = ${repoId} AND h.depth < ${maxDepth}
        AND NOT (CASE WHEN e.source_id = h.id THEN e.target_id ELSE e.source_id END) = ANY(h.path)
    )
    SELECT DISTINCT n.*
    FROM code_node n JOIN hierarchy h ON n.id = h.id
    WHERE n.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

/**
 * Impact analysis with edge chain for visualization.
 */
export async function queryImpactAnalysis(
  db: Database, repoId: string, name: string, blobShas: Set<string>, maxDepth: number = 3
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    WITH RECURSIVE impact AS (
      SELECT e.source_id AS id, e.source_id, e.target_id, e.type AS edge_type, 1 AS depth
      FROM code_edge e
      JOIN code_node t ON e.target_id = t.id
      WHERE e.type IN ('CALLS', 'IMPORTS', 'USES_TYPE', 'EXTENDS', 'IMPLEMENTS')
        AND e.repo_id = ${repoId}
        AND t.name = ${name} AND t.repo_id = ${repoId}
        AND t.blob_sha = ANY(${blobs})
      UNION
      SELECT e.source_id, e.source_id, e.target_id, e.type, i.depth + 1
      FROM code_edge e JOIN impact i ON e.target_id = i.id
      WHERE e.type IN ('CALLS', 'IMPORTS', 'USES_TYPE', 'EXTENDS', 'IMPLEMENTS')
        AND e.repo_id = ${repoId} AND i.depth < ${maxDepth}
    )
    SELECT DISTINCT n.*, i.source_id AS edge_source, i.target_id AS edge_target, i.edge_type
    FROM code_node n JOIN impact i ON n.id = i.id
    WHERE n.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);

  const nodes: CodeNode[] = [];
  const edges: Array<{ source_id: string; target_id: string; type: string }> = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();

  for (const row of rows.rows as any[]) {
    if (!seenNodes.has(row.id)) {
      seenNodes.add(row.id);
      const { edge_source, edge_target, edge_type, ...node } = row;
      nodes.push(node as CodeNode);
    }
    const edgeKey = `${row.edge_source}:${row.edge_target}:${row.edge_type}`;
    if (!seenEdges.has(edgeKey)) {
      seenEdges.add(edgeKey);
      edges.push({ source_id: row.edge_source, target_id: row.edge_target, type: row.edge_type });
    }
  }

  return { nodes, edges };
}

export async function queryFileStructure(
  db: Database, repoId: string, filePath: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT n.*
    FROM code_node n
    WHERE n.file_path = ${filePath} AND n.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs})
    ORDER BY n.start_line ASC NULLS LAST
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function querySymbolLookup(
  db: Database, repoId: string, name: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT n.*
    FROM code_node n
    WHERE n.name ILIKE ${name} AND n.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs})
    ORDER BY CASE WHEN n.name = ${name} THEN 0 ELSE 1 END, n.type ASC
    LIMIT 50
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function queryCommunity(
  db: Database, repoId: string, communityId: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT n.*
    FROM code_node n
    WHERE n.community_id = ${communityId} AND n.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs})
    ORDER BY n.type ASC, n.name ASC
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function queryTestsFor(
  db: Database, repoId: string, targetName: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT DISTINCT n.*
    FROM code_node n
    JOIN code_edge e ON e.source_id = n.id
    JOIN code_node t ON e.target_id = t.id
    WHERE e.type = 'TESTS' AND e.repo_id = ${repoId}
      AND t.name = ${targetName} AND t.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs}) AND t.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

/**
 * Dead code: exported symbols with no incoming references. Uses LEFT JOIN.
 */
export async function queryUnusedExports(
  db: Database, repoId: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT n.*
    FROM code_node n
    LEFT JOIN code_edge e ON e.target_id = n.id
      AND e.type IN ('IMPORTS', 'CALLS', 'USES_TYPE')
      AND e.repo_id = ${repoId}
    WHERE n.exported = true AND n.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs})
      AND e.id IS NULL
    ORDER BY n.file_path ASC, n.name ASC
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

/**
 * Circular deps on IMPORTS. Depth capped at 5, result capped at 50.
 */
export async function queryCircularDeps(
  db: Database, repoId: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    WITH RECURSIVE cycle_detect AS (
      SELECT e.source_id, e.target_id, ARRAY[e.source_id] AS path, false AS is_cycle
      FROM code_edge e
      WHERE e.type = 'IMPORTS' AND e.repo_id = ${repoId}
        AND EXISTS (SELECT 1 FROM code_node cn WHERE cn.id = e.source_id AND cn.blob_sha = ANY(${blobs}))
      UNION ALL
      SELECT cd.source_id, e.target_id, cd.path || e.source_id,
             e.target_id = ANY(cd.path)
      FROM code_edge e
      JOIN cycle_detect cd ON e.source_id = cd.target_id
      WHERE e.type = 'IMPORTS' AND e.repo_id = ${repoId}
        AND NOT e.target_id = ANY(cd.path)
        AND array_length(cd.path, 1) < 5
    )
    SELECT DISTINCT n.*
    FROM code_node n
    JOIN cycle_detect cd ON n.id = ANY(cd.path || cd.target_id)
    WHERE cd.is_cycle = true AND n.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs})
    LIMIT 50
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function queryApiRoutes(
  db: Database, repoId: string, blobShas: Set<string>
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    SELECT n.*
    FROM code_node n
    WHERE n.type = 'Route' AND n.repo_id = ${repoId}
      AND n.blob_sha = ANY(${blobs})
    ORDER BY n.file_path ASC, n.start_line ASC
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

export async function queryDataFlow(
  db: Database, repoId: string, name: string, blobShas: Set<string>, maxDepth: number = 3
): Promise<GraphQueryResult> {
  const blobs = [...blobShas];
  const rows = await db.execute(sql`
    WITH RECURSIVE flow AS (
      SELECT e.source_id AS id, 1 AS depth
      FROM code_edge e
      JOIN code_node t ON e.target_id = t.id
      WHERE e.type IN ('READS', 'WRITES')
        AND e.repo_id = ${repoId}
        AND t.name = ${name} AND t.repo_id = ${repoId}
        AND t.blob_sha = ANY(${blobs})
      UNION
      SELECT CASE WHEN e.type IN ('READS', 'WRITES') THEN e.source_id ELSE e.target_id END,
             f.depth + 1
      FROM code_edge e JOIN flow f ON (e.source_id = f.id OR e.target_id = f.id)
      WHERE e.type IN ('READS', 'WRITES', 'CALLS')
        AND e.repo_id = ${repoId} AND f.depth < ${maxDepth}
    )
    SELECT DISTINCT n.*
    FROM code_node n JOIN flow f ON n.id = f.id
    WHERE n.blob_sha = ANY(${blobs})
    LIMIT ${RESULT_LIMIT}
  `);
  return { nodes: rows.rows as unknown as CodeNode[] };
}

// ── Indexing helpers ──

export async function nodesExistForBlob(
  db: Database, repoId: string, blobShas: string[]
): Promise<Set<string>> {
  if (blobShas.length === 0) return new Set();
  const rows = await db.execute(sql`
    SELECT DISTINCT blob_sha FROM code_node
    WHERE repo_id = ${repoId} AND blob_sha = ANY(${blobShas})
  `);
  return new Set((rows.rows as any[]).map((r) => r.blob_sha));
}

export async function deleteByBlobSha(
  db: Database, repoId: string, blobShas: string[]
): Promise<void> {
  if (blobShas.length === 0) return;
  const nodeRows = await db.execute(sql`
    SELECT id FROM code_node WHERE repo_id = ${repoId} AND blob_sha = ANY(${blobShas})
  `);
  const nodeIds = (nodeRows.rows as any[]).map((r) => r.id);
  if (nodeIds.length > 0) {
    await db.execute(sql`
      DELETE FROM code_edge WHERE repo_id = ${repoId}
        AND (source_id = ANY(${nodeIds}) OR target_id = ANY(${nodeIds}))
    `);
    await db.execute(sql`
      DELETE FROM code_node WHERE repo_id = ${repoId} AND blob_sha = ANY(${blobShas})
    `);
  }
}

export async function deleteAllForRepo(db: Database, repoId: string): Promise<void> {
  await db.execute(sql`DELETE FROM code_edge WHERE repo_id = ${repoId}`);
  await db.execute(sql`DELETE FROM code_node WHERE repo_id = ${repoId}`);
}

/**
 * Resolve __unresolved edges by matching target names to actual node IDs.
 */
export async function resolveUnresolvedEdges(db: Database, repoId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE code_edge e
    SET target_id = n.id
    FROM code_node n
    WHERE e.repo_id = ${repoId}
      AND e.target_id LIKE '__unresolved:%'
      AND n.repo_id = ${repoId}
      AND n.name = split_part(e.target_id, ':', 3)
      AND n.type = split_part(e.target_id, ':', 2)
  `);
  return (result as any).rowCount || 0;
}
