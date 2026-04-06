/**
 * Semantic search indexing service.
 * Handles delta indexing (per-commit) and full reindexing (fan-out via queue).
 */

import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { flattenTree } from "../git/cherry-pick";
import { chunkFile } from "./chunker";
import { embedCode } from "./voyage";
import {
  upsertVectors,
  deleteByPrefix,
  deleteNamespace,
  type VectorRecord,
} from "./pinecone";
import { semanticIndex } from "../db/schema";
import type { Database } from "../db";
import type { Env } from "../types";

// ── Queue message types ──

export interface IndexFileMessage {
  type: "index_files";
  orgId: string;
  repoId: string;
  repoStorageSuffix: string;
  branch: string;
  commitSha: string;
  /** True when this message is part of a full-reindex fan-out (namespace already wiped). */
  isFullReindex?: boolean;
  files: Array<{
    path: string;
    action: "create" | "edit" | "delete" | "rename";
    blobSha?: string;
    oldPath?: string;
  }>;
}

export interface FullReindexMessage {
  type: "full_reindex";
  orgId: string;
  repoId: string;
  repoStorageSuffix: string;
  branch: string;
}

export type IndexingMessage = IndexFileMessage | FullReindexMessage;

function pineconeNamespace(orgId: string, repoId: string, branch: string): string {
  return `${orgId}/${repoId}/${branch}`;
}

// ── Delta indexing (per-commit) ──

export async function processIndexFileMessage(
  msg: IndexFileMessage,
  env: Env,
  db: Database
): Promise<number> {
  const { orgId, repoId, repoStorageSuffix, branch, commitSha, files } = msg;
  const host = env.PINECONE_INDEX_HOST!;
  const pineconeKey = env.PINECONE_API_KEY!;
  const voyageKey = env.VOYAGE_API_KEY!;
  const namespace = pineconeNamespace(orgId, repoId, branch);

  // Race condition check: skip if a newer commit was already indexed
  const [existing] = await db
    .select({ lastCommitSha: semanticIndex.lastCommitSha })
    .from(semanticIndex)
    .where(and(eq(semanticIndex.repoId, repoId), eq(semanticIndex.branch, branch)))
    .limit(1);

  // If index exists with a different commit and it's not our parent, skip
  // (simplified: just check if lastCommitSha matches our expected parent)
  if (existing?.lastCommitSha && existing.lastCommitSha !== commitSha) {
    // Another commit was already indexed — this message may be stale
    // Read the commit to check if our commit's parent matches lastCommitSha
    const storage = new GitR2Storage(env.REPOS_BUCKET, orgId, repoStorageSuffix);
    const raw = await storage.getObject(commitSha);
    if (raw) {
      const obj = parseGitObject(raw);
      if (obj.type === "commit") {
        const commit = parseCommit(obj.content);
        const parent = commit.parents[0];
        if (parent && parent !== existing.lastCommitSha) {
          // Our parent is not the last indexed commit — skip (stale message)
          console.log(`Skipping stale index message: ${commitSha} (last indexed: ${existing.lastCommitSha})`);
          return 0;
        }
      }
    }
  }

  const storage = new GitR2Storage(env.REPOS_BUCKET, orgId, repoStorageSuffix);
  const allChunks: { text: string; filePath: string; startLine: number; endLine: number; language: string; chunkIndex: number; blobSha: string }[] = [];

  // Delete old vectors for changed/deleted/renamed files
  // Skip during full reindex — processFullReindex already wiped the namespace
  if (!msg.isFullReindex) {
    const pathsToDelete: string[] = [];
    for (const file of files) {
      pathsToDelete.push(file.path);
      if (file.oldPath) pathsToDelete.push(file.oldPath);
    }

    for (const path of pathsToDelete) {
      await deleteByPrefix(host, pineconeKey, namespace, `${path}#`).catch((err) => {
        console.error(`deleteByPrefix failed for ${path}:`, err);
      });
    }
  }

  // Read blobs and chunk non-deleted files
  for (const file of files) {
    if (file.action === "delete" || !file.blobSha) continue;

    const blobRaw = await storage.getObject(file.blobSha);
    if (!blobRaw) {
      console.error(`Blob not found: ${file.blobSha} for ${file.path}`);
      continue;
    }

    const blobObj = parseGitObject(blobRaw);
    if (blobObj.type !== "blob") continue;

    const text = new TextDecoder().decode(blobObj.content);
    const chunks = chunkFile(file.path, text);

    for (const chunk of chunks) {
      allChunks.push({
        text: chunk.text,
        filePath: chunk.file_path,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        language: chunk.language,
        chunkIndex: chunk.chunk_index,
        blobSha: file.blobSha,
      });
    }
  }

  if (allChunks.length > 0) {
    // Embed all chunks
    const embeddings = await embedCode(
      allChunks.map((c) => c.text),
      "document",
      voyageKey
    );

    // Build vectors (no text stored in Pinecone)
    const vectors: VectorRecord[] = allChunks.map((chunk, i) => ({
      id: `${chunk.filePath}#${chunk.chunkIndex}`,
      values: embeddings[i],
      metadata: {
        file_path: chunk.filePath,
        blob_sha: chunk.blobSha,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        language: chunk.language,
        chunk_index: chunk.chunkIndex,
      },
    }));

    await upsertVectors(host, pineconeKey, namespace, vectors);
  }

  // Update DB — only for delta indexing.
  // Full-reindex batches are tracked via incrementBatchCounter instead.
  if (!msg.isFullReindex) {
    await db
      .insert(semanticIndex)
      .values({
        id: nanoid(),
        repoId,
        orgId,
        branch,
        lastCommitSha: commitSha,
        chunksCount: allChunks.length,
        status: "ready",
        indexedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [semanticIndex.repoId, semanticIndex.branch],
        set: {
          lastCommitSha: commitSha,
          chunksCount: sql`${semanticIndex.chunksCount} + ${allChunks.length}`,
          status: "ready",
          indexedAt: new Date(),
          error: null,
        },
      });
  }

  return allChunks.length;
}

// ── Full reindex (fan-out via queue) ──

export async function processFullReindex(
  msg: FullReindexMessage,
  env: Env,
  db: Database
): Promise<void> {
  const { orgId, repoId, repoStorageSuffix, branch } = msg;
  const host = env.PINECONE_INDEX_HOST!;
  const pineconeKey = env.PINECONE_API_KEY!;
  const namespace = pineconeNamespace(orgId, repoId, branch);

  // 1. Delete entire namespace
  await deleteNamespace(host, pineconeKey, namespace).catch((err) => {
    console.error(`deleteNamespace failed for ${namespace}:`, err);
  });

  // 2. Flatten tree from branch HEAD
  const storage = new GitR2Storage(env.REPOS_BUCKET, orgId, repoStorageSuffix);
  const commitSha = await storage.getRef(`refs/heads/${branch}`);
  if (!commitSha) {
    console.error(`Branch not found: ${branch}`);
    return;
  }

  const raw = await storage.getObject(commitSha);
  if (!raw) return;
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return;
  const commit = parseCommit(obj.content);
  const tree = await flattenTree(storage, commit.tree);

  // 3. Collect all files
  const allFiles: Array<{ path: string; blobSha: string }> = [];
  for (const [path, entry] of tree) {
    if (entry.mode === "40000") continue; // skip dirs
    allFiles.push({ path, blobSha: entry.sha });
  }

  if (allFiles.length === 0) {
    await db
      .insert(semanticIndex)
      .values({
        id: nanoid(),
        repoId,
        orgId,
        branch,
        lastCommitSha: commitSha,
        chunksCount: 0,
        status: "ready",
        indexedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [semanticIndex.repoId, semanticIndex.branch],
        set: {
          lastCommitSha: commitSha,
          chunksCount: 0,
          totalBatches: 0,
          processedBatches: 0,
          status: "ready",
          indexedAt: new Date(),
          error: null,
        },
      });
    return;
  }

  // 4. Split into batches and fan-out via queue
  const BATCH_SIZE = 200;
  const batches: typeof allFiles[] = [];
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    batches.push(allFiles.slice(i, i + BATCH_SIZE));
  }

  // Update DB: set status to indexing with batch tracking
  await db
    .insert(semanticIndex)
    .values({
      id: nanoid(),
      repoId,
      orgId,
      branch,
      lastCommitSha: commitSha,
      chunksCount: 0,
      totalBatches: batches.length,
      processedBatches: 0,
      status: "indexing",
    })
    .onConflictDoUpdate({
      target: [semanticIndex.repoId, semanticIndex.branch],
      set: {
        lastCommitSha: commitSha,
        chunksCount: 0,
        totalBatches: batches.length,
        processedBatches: 0,
        status: "indexing",
        error: null,
      },
    });

  // 5. Send each batch as IndexFileMessage
  const queue = env.INDEXING_QUEUE;
  if (!queue) {
    console.error("INDEXING_QUEUE not configured");
    return;
  }

  for (const batch of batches) {
    const batchMsg: IndexFileMessage = {
      type: "index_files",
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
 * Called after each batch is processed during full reindex.
 */
export async function incrementBatchCounter(
  db: Database,
  repoId: string,
  branch: string,
  chunksInBatch: number
): Promise<void> {
  const result = await db
    .update(semanticIndex)
    .set({
      processedBatches: sql`${semanticIndex.processedBatches} + 1`,
      chunksCount: sql`${semanticIndex.chunksCount} + ${chunksInBatch}`,
    })
    .where(
      and(eq(semanticIndex.repoId, repoId), eq(semanticIndex.branch, branch))
    )
    .returning({
      processedBatches: semanticIndex.processedBatches,
      totalBatches: semanticIndex.totalBatches,
    });

  if (result.length > 0) {
    const { processedBatches, totalBatches } = result[0];
    if (processedBatches !== null && totalBatches !== null && processedBatches >= totalBatches && totalBatches > 0) {
      await db
        .update(semanticIndex)
        .set({ status: "ready", indexedAt: new Date() })
        .where(
          and(
            eq(semanticIndex.repoId, repoId),
            eq(semanticIndex.branch, branch)
          )
        );
    }
  }
}
