/**
 * CoreGit API — Serverless Git for AI-native products.
 *
 * Cloudflare Worker entry point. Hono app construction lives in ./app.ts so it
 * can be reused by the CoregitCoreBinding WorkerEntrypoint (internal RPC from
 * adjacent Workers on the same Cloudflare account).
 *
 * Auth: API key only (hash lookup in Neon DB). Better Auth lives in coregit-app.
 */

import { sql, gt } from "drizzle-orm";
import { createDb, dbConnectionString } from "./db";
import { repo as repoTable } from "./db/schema";
import { GitR2Storage, PACK_THRESHOLD } from "./git/storage";
import {
  processIndexFileMessage,
  processFullReindex,
  incrementBatchCounter,
  type IndexingMessage,
} from "./services/semantic-index";
import {
  processGraphIndexFileMessage,
  processGraphFullReindex,
  incrementGraphBatchCounter,
  type GraphIndexingMessage,
} from "./services/graph-index";
import {
  processBlobMaterializationMessage,
  type BlobMaterializationMessage,
} from "./services/blob-materialization";
import { app } from "./app";
import type { Env } from "./types";

// Durable Objects must be exported from the entry point
export { RateLimiterDO } from "./durable-objects/rate-limiter";
export { SessionDO } from "./durable-objects/session";
export { RepoHotDO } from "./durable-objects/repo-hot";

// Service Binding entrypoint for adjacent private Workers (internal RPC)
export { CoregitCoreBinding } from "./service-binding";

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const db = createDb(dbConnectionString(env));
    const bucket = env.REPOS_BUCKET;
    const repoHotNs = env.REPO_HOT_DO;
    const since = new Date(Date.now() - 7 * 60 * 60 * 1000);

    // Step 1: pack loose objects on recently-touched repos.
    const recent = await db
      .select({
        id: repoTable.id,
        orgId: repoTable.orgId,
        namespace: repoTable.namespace,
        slug: repoTable.slug,
      })
      .from(repoTable)
      .where(gt(repoTable.updatedAt, since));

    const OUTER_CONCURRENCY = 3;
    for (let i = 0; i < recent.length; i += OUTER_CONCURRENCY) {
      const slice = recent.slice(i, i + OUTER_CONCURRENCY);
      await Promise.all(
        slice.map((r) =>
          packOneRepoIfNeeded(bucket, repoHotNs, r).catch((err) => {
            console.error(
              `[cron/pack] repo=${r.orgId}/${r.namespace ?? ""}${r.slug}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }),
        ),
      );
    }

    // Step 2: blob garbage collection. Selects blobs with no remaining
    // blob_repo edges, older than the 7-day grace window. Limited per run
    // so a long sweep doesn't starve the pack loop above.
    await sweepOrphanBlobs(db, bucket).catch((err) => {
      console.error(`[cron/gc] orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  },

  async queue(batch: MessageBatch<IndexingMessage | GraphIndexingMessage | BlobMaterializationMessage>, env: Env, ctx: ExecutionContext) {
    const db = createDb(dbConnectionString(env));
    for (const message of batch.messages) {
      try {
        const { type } = message.body;

        if (type === "index_files") {
          const body = message.body as IndexingMessage & { type: "index_files" };
          const chunksIndexed = await processIndexFileMessage(body, env, db);
          if (body.isFullReindex) {
            await incrementBatchCounter(db, body.repoId, body.branch, chunksIndexed);
          }
        } else if (type === "full_reindex") {
          await processFullReindex(message.body as IndexingMessage & { type: "full_reindex" }, env, db);
        } else if (type === "graph_index_files") {
          const body = message.body as GraphIndexingMessage & { type: "graph_index_files" };
          const result = await processGraphIndexFileMessage(body, env, db);
          if (body.isFullReindex) {
            await incrementGraphBatchCounter(db, body.repoId, body.branch, result.nodesCount, result.edgesCount);
          }
        } else if (type === "graph_full_reindex") {
          await processGraphFullReindex(message.body as GraphIndexingMessage & { type: "graph_full_reindex" }, env, db);
        } else if (type === "blob_materialization") {
          await processBlobMaterializationMessage(message.body as BlobMaterializationMessage, env, db);
        }

        message.ack();
      } catch (err) {
        console.error(`Queue task failed (attempt ${message.attempts}):`, err);
        if (message.attempts >= 3) {
          const body = message.body as { type: string; repoId?: string; branch?: string };
          // Best-effort: only semantic/graph index messages have a status row to mark.
          if (body.type === "index_files" || body.type === "full_reindex" || body.type === "graph_index_files" || body.type === "graph_full_reindex") {
            const table = body.type.startsWith("graph_") ? "code_graph_index" : "semantic_index";
            ctx.waitUntil(
              db.execute(
                sql`UPDATE ${sql.raw(table)} SET status = 'failed', error = ${String(err)} WHERE repo_id = ${body.repoId} AND branch = ${body.branch}`
              ).catch(() => {})
            );
          }
          message.ack();
        } else {
          message.retry();
        }
      }
    }
  },
};

/**
 * GC sweep: drop blobs that no repo references anymore. The 7-day grace
 * window protects against the fork-then-immediately-delete-parent pattern
 * and gives ops a recovery window if a delete was a mistake.
 *
 * Per-run cap so a 1M-blob sweep doesn't run for hours; cron fires every
 * 6 hours so the queue drains without intervention.
 */
const GC_SWEEP_PER_RUN = 1000;
const GC_DELETE_BATCH = 100;

async function sweepOrphanBlobs(
  db: ReturnType<typeof createDb>,
  bucket: R2Bucket,
): Promise<void> {
  const orphans = (await db.execute(sql`
    SELECT b.sha
    FROM blob b
    LEFT JOIN blob_repo br ON br.sha = b.sha
    WHERE br.sha IS NULL AND b.first_seen_at < now() - interval '7 days'
    LIMIT ${GC_SWEEP_PER_RUN}
  `)) as unknown as { sha: string }[];

  if (orphans.length === 0) return;

  let deleted = 0;
  for (let i = 0; i < orphans.length; i += GC_DELETE_BATCH) {
    const batch = orphans.slice(i, i + GC_DELETE_BATCH);
    const r2Keys = batch.map((o) => `_blobs/${o.sha.slice(0, 2)}/${o.sha.slice(2)}`);
    await bucket.delete(r2Keys);
    const shas = batch.map((o) => o.sha);
    await db.execute(sql`DELETE FROM blob WHERE sha = ANY(${shas}::text[])`);
    deleted += batch.length;
  }
  console.log(`[cron/gc] swept ${deleted} orphan blobs`);
}

async function packOneRepoIfNeeded(
  bucket: R2Bucket,
  repoHotNs: DurableObjectNamespace,
  r: { id: string; orgId: string; namespace: string | null; slug: string },
): Promise<void> {
  const storageSuffix = r.namespace ? `${r.namespace}/${r.slug}` : r.slug;
  const basePath = `${r.orgId}/${storageSuffix}`;

  const probe = await bucket.list({
    prefix: `${basePath}/objects/`,
    limit: PACK_THRESHOLD + 1,
  });
  const looseCount = probe.objects.filter((o) => !o.key.endsWith(".gitkeep")).length;
  if (looseCount <= PACK_THRESHOLD) return;

  const stub = repoHotNs.get(repoHotNs.idFromName(r.id));
  const lockRes = await stub.fetch("https://do/pack-lock", { method: "POST" });
  const lock = (await lockRes.json()) as { acquired: boolean };
  if (!lock.acquired) return;

  try {
    const storage = new GitR2Storage(bucket, r.orgId, storageSuffix);
    const result = await storage.packLooseObjects();
    if (result) {
      console.log(
        `[cron/pack] repo=${r.id} packed=${result.packed} packSha=${result.packSha}`,
      );
    }
  } finally {
    await stub.fetch("https://do/pack-unlock", { method: "POST" }).catch(() => {});
  }
}
