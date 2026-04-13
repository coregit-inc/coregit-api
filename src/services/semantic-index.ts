/**
 * Semantic search indexing service.
 * Content-addressed: vectors keyed by blob SHA (like git itself).
 * Same content = same vector, no duplication across branches/commits.
 *
 * P0.4: Uses embedding cache (KV) to avoid redundant Voyage API calls.
 * P1.1: Chunk ID format v2 — `{blobSha}:v2:{chunkIndex}` (contextual prefix).
 *
 * TODO: Replace Pinecone with Turbopuffer at scale (100K+ repos).
 * See pinecone.ts header comment for rationale.
 */

import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { flattenTree } from "../git/cherry-pick";
import { chunkFile } from "./chunker";
import { embedCodeCached } from "./voyage";
import {
  upsertVectors,
  vectorsExist,
  type VectorRecord,
} from "./pinecone";
import { semanticIndex } from "../db/schema";
import type { Database } from "../db";
import type { Env } from "../types";

// Chunk ID version — bump when chunk format changes to avoid dedup collisions
const CHUNK_VERSION = "v2";

// ── Queue message types ──

export interface IndexFileMessage {
  type: "index_files";
  orgId: string;
  repoId: string;
  repoStorageSuffix: string;
  branch: string;
  commitSha: string;
  /** True when this message is part of a full-reindex fan-out. */
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

/** One namespace per repo — all versions live together. */
function pineconeNamespace(orgId: string, repoId: string): string {
  return `${orgId}/${repoId}`;
}

/** Content-addressed vector ID with version tag. */
function vectorId(blobSha: string, chunkIndex: number): string {
  return `${blobSha}:${CHUNK_VERSION}:${chunkIndex}`;
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
  const namespace = pineconeNamespace(orgId, repoId);

  // Race condition check: skip if a newer commit was already indexed for this branch
  if (!msg.isFullReindex) {
    const [existing] = await db
      .select({ lastCommitSha: semanticIndex.lastCommitSha })
      .from(semanticIndex)
      .where(and(eq(semanticIndex.repoId, repoId), eq(semanticIndex.branch, branch)))
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
            console.log(`Skipping stale index message: ${commitSha} (last indexed: ${existing.lastCommitSha})`);
            return 0;
          }
        }
      }
    }
  }

  // Collect blob SHAs that need embedding
  const blobsToProcess: Array<{ path: string; blobSha: string }> = [];
  for (const file of files) {
    if (file.action === "delete" || !file.blobSha) continue;
    blobsToProcess.push({ path: file.path, blobSha: file.blobSha });
  }

  if (blobsToProcess.length === 0) return 0;

  // Check which blob SHAs already have vectors (content-addressed dedup)
  // Use versioned ID format for dedup check
  const checkIds = blobsToProcess.map((b) => vectorId(b.blobSha, 0));
  const existingIds = await vectorsExist(host, pineconeKey, namespace, checkIds);

  // Filter to only new blobs
  const newBlobs = blobsToProcess.filter((b) => !existingIds.has(vectorId(b.blobSha, 0)));

  if (newBlobs.length === 0) {
    // All blobs already embedded — just update DB tracking
    if (!msg.isFullReindex) {
      await updateIndexTracking(db, repoId, orgId, branch, commitSha, 0);
    }
    return 0;
  }

  // Read blobs and chunk
  const storage = new GitR2Storage(env.REPOS_BUCKET, orgId, repoStorageSuffix);
  const allChunks: Array<{
    text: string; filePath: string; startLine: number; endLine: number;
    language: string; chunkIndex: number; blobSha: string;
  }> = [];

  for (const { path, blobSha } of newBlobs) {
    const blobRaw = await storage.getObject(blobSha);
    if (!blobRaw) {
      console.error(`Blob not found: ${blobSha} for ${path}`);
      continue;
    }

    const blobObj = parseGitObject(blobRaw);
    if (blobObj.type !== "blob") continue;

    const text = new TextDecoder().decode(blobObj.content);
    const chunks = chunkFile(path, text);

    for (const chunk of chunks) {
      allChunks.push({
        text: chunk.text,
        filePath: chunk.file_path,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        language: chunk.language,
        chunkIndex: chunk.chunk_index,
        blobSha,
      });
    }
  }

  if (allChunks.length > 0) {
    // P0.4: Use cached embeddings
    const embeddings = await embedCodeCached(
      allChunks.map((c) => c.text),
      "document",
      voyageKey,
      env.EMBEDDING_CACHE
    );

    // Content-addressed vector IDs with version: {blob_sha}:v2:{chunk_index}
    const vectors: VectorRecord[] = allChunks.map((chunk, i) => ({
      id: vectorId(chunk.blobSha, chunk.chunkIndex),
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

  // Update DB — only for delta indexing (full-reindex uses incrementBatchCounter)
  if (!msg.isFullReindex) {
    await updateIndexTracking(db, repoId, orgId, branch, commitSha, allChunks.length);
  }

  return allChunks.length;
}

async function updateIndexTracking(
  db: Database, repoId: string, orgId: string, branch: string,
  commitSha: string, newChunks: number
): Promise<void> {
  await db
    .insert(semanticIndex)
    .values({
      id: nanoid(),
      repoId,
      orgId,
      branch,
      lastCommitSha: commitSha,
      chunksCount: newChunks,
      status: "ready",
      indexedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [semanticIndex.repoId, semanticIndex.branch],
      set: {
        lastCommitSha: commitSha,
        chunksCount: sql`${semanticIndex.chunksCount} + ${newChunks}`,
        status: "ready",
        indexedAt: new Date(),
        error: null,
      },
    });
}

// ── Full reindex (fan-out via queue) ──

export async function processFullReindex(
  msg: FullReindexMessage,
  env: Env,
  db: Database
): Promise<void> {
  const { orgId, repoId, repoStorageSuffix, branch } = msg;

  // Flatten tree from branch HEAD
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

  // Collect all files
  const allFiles: Array<{ path: string; blobSha: string }> = [];
  for (const [path, entry] of tree) {
    if (entry.mode === "40000") continue;
    allFiles.push({ path, blobSha: entry.sha });
  }

  if (allFiles.length === 0) {
    await updateIndexTracking(db, repoId, orgId, branch, commitSha, 0);
    return;
  }

  // Split into batches and fan-out via queue
  const BATCH_SIZE = 200;
  const batches: typeof allFiles[] = [];
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    batches.push(allFiles.slice(i, i + BATCH_SIZE));
  }

  // Set status to indexing with batch tracking
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
          and(eq(semanticIndex.repoId, repoId), eq(semanticIndex.branch, branch))
        );
    }
  }
}
