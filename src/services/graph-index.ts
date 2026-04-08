/**
 * Code graph indexing service.
 * Content-addressed: nodes keyed by blob SHA (like git itself).
 * Same content = same nodes, no duplication across branches/commits.
 *
 * Mirrors semantic-index.ts architecture:
 * - Delta indexing (per-commit) via processGraphIndexFileMessage
 * - Full reindex (fan-out) via processGraphFullReindex
 * - Batch counter tracking via incrementGraphBatchCounter
 */

import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { flattenTree } from "../git/cherry-pick";
import { parseFile, type ParsedFile, type ParsedEntity, type ImportInfo } from "./code-parser";
import { nodesExistForBlob, deleteByBlobSha, resolveUnresolvedEdges } from "./graph-db";
import { codeNode, codeEdge, codeGraphIndex } from "../db/schema";
import type { NewCodeNode, NewCodeEdge } from "../db/schema";
import type { Database } from "../db";
import type { Env } from "../types";

// ── Queue message types ──

export interface GraphIndexFileMessage {
  type: "graph_index_files";
  orgId: string;
  repoId: string;
  repoStorageSuffix: string;
  branch: string;
  commitSha: string;
  isFullReindex?: boolean;
  files: Array<{
    path: string;
    action: "create" | "edit" | "delete" | "rename";
    blobSha?: string;
    oldBlobSha?: string;
    oldPath?: string;
  }>;
}

export interface GraphFullReindexMessage {
  type: "graph_full_reindex";
  orgId: string;
  repoId: string;
  repoStorageSuffix: string;
  branch: string;
}

export type GraphIndexingMessage = GraphIndexFileMessage | GraphFullReindexMessage;

// Content-addressed node ID
function nodeId(blobSha: string, entityType: string, entityName: string): string {
  return `${blobSha}:${entityType}:${entityName}`;
}

// Content-addressed edge ID
function edgeId(sourceId: string, targetId: string, type: string): string {
  return `${sourceId}->${type}->${targetId}`;
}

// ── Delta indexing (per-commit) ──

export async function processGraphIndexFileMessage(
  msg: GraphIndexFileMessage,
  env: Env,
  db: Database
): Promise<{ nodesCount: number; edgesCount: number }> {
  const { orgId, repoId, repoStorageSuffix, branch, commitSha, files } = msg;

  // Race condition check: skip if a newer commit was already indexed
  if (!msg.isFullReindex) {
    const [existing] = await db
      .select({ lastCommitSha: codeGraphIndex.lastCommitSha })
      .from(codeGraphIndex)
      .where(and(eq(codeGraphIndex.repoId, repoId), eq(codeGraphIndex.branch, branch)))
      .limit(1);

    if (existing?.lastCommitSha && existing.lastCommitSha !== commitSha) {
      const storage = new GitR2Storage(env.REPOS_BUCKET, orgId, repoStorageSuffix);
      const raw = await storage.getObject(commitSha);
      if (raw) {
        const obj = parseGitObject(raw);
        if (obj.type === "commit") {
          const commit = parseCommit(obj.content);
          const parent = commit.parents[0];
          if (parent && parent !== existing.lastCommitSha) {
            console.log(`[graph] Skipping stale message: ${commitSha}`);
            return { nodesCount: 0, edgesCount: 0 };
          }
        }
      }
    }
  }

  // Separate deletes from creates/edits
  const blobsToProcess: Array<{ path: string; blobSha: string }> = [];

  for (const file of files) {
    if (file.action === "delete") continue;
    if (!file.blobSha) continue;
    blobsToProcess.push({ path: file.path, blobSha: file.blobSha });
  }

  // Handle deletes: old blob SHAs passed via oldBlobSha field
  const deletedBlobShas = files
    .filter((f) => f.action === "delete" && (f as any).oldBlobSha)
    .map((f) => (f as any).oldBlobSha as string);

  if (deletedBlobShas.length > 0) {
    await deleteByBlobSha(db, repoId, deletedBlobShas);
  }

  if (blobsToProcess.length === 0 && deletedBlobShas.length === 0) {
    return { nodesCount: 0, edgesCount: 0 };
  }

  if (blobsToProcess.length === 0) {
    if (!msg.isFullReindex) {
      await updateGraphTracking(db, repoId, orgId, branch, commitSha, 0, 0);
    }
    return { nodesCount: 0, edgesCount: 0 };
  }

  // Content-addressed dedup: check which blobs already have nodes
  const blobShas = blobsToProcess.map((b) => b.blobSha);
  const existingBlobs = await nodesExistForBlob(db, repoId, blobShas);
  const newBlobs = blobsToProcess.filter((b) => !existingBlobs.has(b.blobSha));

  if (newBlobs.length === 0) {
    if (!msg.isFullReindex) {
      await updateGraphTracking(db, repoId, orgId, branch, commitSha, 0, 0);
    }
    return { nodesCount: 0, edgesCount: 0 };
  }

  // Read blobs and parse
  const storage = new GitR2Storage(env.REPOS_BUCKET, orgId, repoStorageSuffix);
  const allNodes: NewCodeNode[] = [];
  const allEdges: NewCodeEdge[] = [];

  for (const { path, blobSha } of newBlobs) {
    const blobRaw = await storage.getObject(blobSha);
    if (!blobRaw) {
      console.error(`[graph] Blob not found: ${blobSha} for ${path}`);
      continue;
    }

    const blobObj = parseGitObject(blobRaw);
    if (blobObj.type !== "blob") continue;

    const text = new TextDecoder().decode(blobObj.content);
    const parsed = parseFile(path, text);
    if (!parsed) continue;

    // Build nodes
    for (const entity of parsed.entities) {
      const id = nodeId(blobSha, entity.type, entity.name);
      allNodes.push({
        id,
        type: entity.type,
        name: entity.name,
        filePath: path,
        blobSha,
        repoId,
        orgId,
        startLine: entity.startLine,
        endLine: entity.endLine,
        signature: entity.signature.slice(0, 2000),
        language: parsed.language,
        exported: entity.exported,
        complexity: entity.complexity,
      });

      // CALLS edges (within same file — cross-file resolved by name matching)
      for (const callName of entity.calls) {
        // Try to find target in same file first
        const target = parsed.entities.find((e) => e.name === callName && e.type === "Function");
        if (target) {
          const targetNodeId = nodeId(blobSha, target.type, target.name);
          allEdges.push({
            id: edgeId(id, targetNodeId, "CALLS"),
            sourceId: id,
            targetId: targetNodeId,
            type: "CALLS",
            repoId,
          });
        }
        // Cross-file calls: create edge with deterministic target ID
        // The target node may not exist yet — will be resolved when that file is indexed
      }

      // EXTENDS edge
      if (entity.extends) {
        const targetId = `__unresolved:Class:${entity.extends}`;
        allEdges.push({
          id: edgeId(id, targetId, "EXTENDS"),
          sourceId: id,
          targetId,
          type: "EXTENDS",
          repoId,
        });
      }

      // IMPLEMENTS edges
      if (entity.implements) {
        for (const iface of entity.implements) {
          const targetId = `__unresolved:Interface:${iface}`;
          allEdges.push({
            id: edgeId(id, targetId, "IMPLEMENTS"),
            sourceId: id,
            targetId,
            type: "IMPLEMENTS",
            repoId,
          });
        }
      }
    }

    // IMPORTS edges (file-level)
    const fileNodeId = nodeId(blobSha, "File", path);
    allNodes.push({
      id: fileNodeId,
      type: "File",
      name: path,
      filePath: path,
      blobSha,
      repoId,
      orgId,
      startLine: 1,
      endLine: text.split("\n").length,
      signature: `File: ${path}`,
      language: parsed.language,
      exported: false,
      complexity: 0,
    });

    // CONTAINS edges (file → entity)
    for (const entity of parsed.entities) {
      const entityId = nodeId(blobSha, entity.type, entity.name);
      allEdges.push({
        id: edgeId(fileNodeId, entityId, "CONTAINS"),
        sourceId: fileNodeId,
        targetId: entityId,
        type: "CONTAINS",
        repoId,
      });
    }

    // IMPORTS edges
    for (const imp of parsed.imports) {
      const targetId = `__unresolved:File:${imp.source}`;
      allEdges.push({
        id: edgeId(fileNodeId, targetId, "IMPORTS"),
        sourceId: fileNodeId,
        targetId,
        type: "IMPORTS",
        repoId,
      });
    }
  }

  // Batch upsert nodes (parallel batches)
  if (allNodes.length > 0) {
    const BATCH = 100;
    const nodeBatches: NewCodeNode[][] = [];
    for (let i = 0; i < allNodes.length; i += BATCH) {
      nodeBatches.push(allNodes.slice(i, i + BATCH));
    }
    await Promise.all(nodeBatches.map((batch) =>
      db.insert(codeNode).values(batch).onConflictDoUpdate({
        target: codeNode.id,
        set: {
          name: sql`EXCLUDED.name`,
          filePath: sql`EXCLUDED.file_path`,
          startLine: sql`EXCLUDED.start_line`,
          endLine: sql`EXCLUDED.end_line`,
          signature: sql`EXCLUDED.signature`,
          language: sql`EXCLUDED.language`,
          exported: sql`EXCLUDED.exported`,
          complexity: sql`EXCLUDED.complexity`,
        },
      })
    ));
  }

  // Batch upsert edges (parallel batches)
  if (allEdges.length > 0) {
    const BATCH = 100;
    const edgeBatches: NewCodeEdge[][] = [];
    for (let i = 0; i < allEdges.length; i += BATCH) {
      edgeBatches.push(allEdges.slice(i, i + BATCH));
    }
    await Promise.all(edgeBatches.map((batch) =>
      db.insert(codeEdge).values(batch).onConflictDoNothing()
    ));
  }

  // Update tracking
  if (!msg.isFullReindex) {
    await updateGraphTracking(db, repoId, orgId, branch, commitSha, allNodes.length, allEdges.length);
  }

  return { nodesCount: allNodes.length, edgesCount: allEdges.length };
}

async function updateGraphTracking(
  db: Database, repoId: string, orgId: string, branch: string,
  commitSha: string, newNodes: number, newEdges: number
): Promise<void> {
  await db
    .insert(codeGraphIndex)
    .values({
      id: nanoid(),
      repoId,
      orgId,
      branch,
      lastCommitSha: commitSha,
      nodesCount: newNodes,
      edgesCount: newEdges,
      status: "ready",
      indexedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [codeGraphIndex.repoId, codeGraphIndex.branch],
      set: {
        lastCommitSha: commitSha,
        nodesCount: sql`${codeGraphIndex.nodesCount} + ${newNodes}`,
        edgesCount: sql`${codeGraphIndex.edgesCount} + ${newEdges}`,
        status: "ready",
        indexedAt: new Date(),
        error: null,
      },
    });
}

// ── Full reindex (fan-out via queue) ──

export async function processGraphFullReindex(
  msg: GraphFullReindexMessage,
  env: Env,
  db: Database
): Promise<void> {
  const { orgId, repoId, repoStorageSuffix, branch } = msg;

  const storage = new GitR2Storage(env.REPOS_BUCKET, orgId, repoStorageSuffix);
  const commitSha = await storage.getRef(`refs/heads/${branch}`);
  if (!commitSha) {
    console.error(`[graph] Branch not found: ${branch}`);
    return;
  }

  const raw = await storage.getObject(commitSha);
  if (!raw) return;
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return;
  const commit = parseCommit(obj.content);
  const tree = await flattenTree(storage, commit.tree);

  const allFiles: Array<{ path: string; blobSha: string }> = [];
  for (const [path, entry] of tree) {
    if (entry.mode === "40000") continue;
    allFiles.push({ path, blobSha: entry.sha });
  }

  if (allFiles.length === 0) {
    await updateGraphTracking(db, repoId, orgId, branch, commitSha, 0, 0);
    return;
  }

  const BATCH_SIZE = 200;
  const batches: typeof allFiles[] = [];
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    batches.push(allFiles.slice(i, i + BATCH_SIZE));
  }

  // Set status to indexing
  await db
    .insert(codeGraphIndex)
    .values({
      id: nanoid(),
      repoId,
      orgId,
      branch,
      lastCommitSha: commitSha,
      nodesCount: 0,
      edgesCount: 0,
      totalBatches: batches.length,
      processedBatches: 0,
      status: "indexing",
    })
    .onConflictDoUpdate({
      target: [codeGraphIndex.repoId, codeGraphIndex.branch],
      set: {
        lastCommitSha: commitSha,
        nodesCount: 0,
        edgesCount: 0,
        totalBatches: batches.length,
        processedBatches: 0,
        status: "indexing",
        error: null,
      },
    });

  const queue = env.INDEXING_QUEUE;
  if (!queue) {
    console.error("[graph] INDEXING_QUEUE not configured");
    return;
  }

  for (const batch of batches) {
    const batchMsg: GraphIndexFileMessage = {
      type: "graph_index_files",
      orgId,
      repoId,
      repoStorageSuffix,
      branch,
      commitSha,
      isFullReindex: true,
      files: batch.map((f) => ({
        path: f.path,
        action: "create" as const,
        blobSha: f.blobSha,
      })),
    };
    await queue.send(batchMsg);
  }
}

/**
 * Increment processedBatches and check if all batches are done.
 */
export async function incrementGraphBatchCounter(
  db: Database,
  repoId: string,
  branch: string,
  nodesInBatch: number,
  edgesInBatch: number
): Promise<void> {
  const result = await db
    .update(codeGraphIndex)
    .set({
      processedBatches: sql`${codeGraphIndex.processedBatches} + 1`,
      nodesCount: sql`${codeGraphIndex.nodesCount} + ${nodesInBatch}`,
      edgesCount: sql`${codeGraphIndex.edgesCount} + ${edgesInBatch}`,
    })
    .where(
      and(eq(codeGraphIndex.repoId, repoId), eq(codeGraphIndex.branch, branch))
    )
    .returning({
      processedBatches: codeGraphIndex.processedBatches,
      totalBatches: codeGraphIndex.totalBatches,
    });

  if (result.length > 0) {
    const { processedBatches, totalBatches } = result[0];
    if (processedBatches !== null && totalBatches !== null && processedBatches >= totalBatches && totalBatches > 0) {
      // Resolve __unresolved edges now that all nodes exist
      await resolveUnresolvedEdges(db, repoId);

      await db
        .update(codeGraphIndex)
        .set({ status: "ready", indexedAt: new Date() })
        .where(
          and(eq(codeGraphIndex.repoId, repoId), eq(codeGraphIndex.branch, branch))
        );
    }
  }
}
