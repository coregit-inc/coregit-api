/**
 * Materialize `blob_repo` rows for all objects reachable from a fork's parent
 * HEAD. Called at fork-creation time. The point of materialization is twofold:
 *
 *   1. DELETE parent stays safe — fork keeps its own refcount edges, so blobs
 *      survive the parent's removal until the fork itself is deleted.
 *   2. Read paths stay simple — `getObject` just looks up by SHA in the global
 *      `_blobs/` keyspace, with no chain traversal needed.
 *
 * Two paths:
 *   - sync: small reachable sets (<= SYNC_THRESHOLD). Done inside the fork
 *     request, blocks the response.
 *   - queued: enqueues a job into the existing `coregit-indexing` queue; the
 *     consumer in src/index.ts runs the walk + INSERT batches.
 *
 * Either way, INSERTs go through `unnest($1::text[])` so a 1M-blob walk is
 * a few SQL round-trips, not a million.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { GitR2Storage } from "../git/storage";
import { walkReachable } from "./blob-walker";

/** Reachable-object count above which we punt the work to the queue. */
export const SYNC_THRESHOLD = 5000;

/** Per-INSERT batch size — keeps Postgres params under the 65535 cap. */
const INSERT_BATCH = 5000;

export interface MaterializationContext {
  db: Database;
  storage: GitR2Storage;
  repoId: string;
  orgId: string;
  headSha: string;
}

export interface BlobMaterializationMessage {
  type: "blob_materialization";
  repoId: string;
  orgId: string;
  storageSuffix: string;
  headSha: string;
}

/**
 * Synchronously walk all reachable objects and INSERT blob/blob_repo rows.
 * Returns the number of objects materialized.
 */
export async function materializeSync(
  ctx: MaterializationContext,
  options: { maxObjects?: number } = {},
): Promise<{ count: number }> {
  let buf: { sha: string; type: string; size: number }[] = [];
  let total = 0;

  const flush = async () => {
    if (buf.length === 0) return;
    const shas = buf.map((b) => b.sha);
    const sizes = buf.map((b) => b.size);
    const types = buf.map((b) => b.type);
    await ctx.db.execute(sql`
      WITH inserted AS (
        INSERT INTO blob (sha, size_bytes, type)
        SELECT s, sz::bigint, t
        FROM unnest(
          ${shas}::text[],
          ${sizes}::bigint[],
          ${types}::text[]
        ) AS x(s, sz, t)
        ON CONFLICT (sha) DO NOTHING
      )
      INSERT INTO blob_repo (sha, repo_id, org_id)
      SELECT s, ${ctx.repoId}, ${ctx.orgId}
      FROM unnest(${shas}::text[]) AS x(s)
      ON CONFLICT (sha, repo_id) DO NOTHING
    `);
    buf = [];
  };

  for await (const obj of walkReachable(ctx.storage, ctx.headSha, options)) {
    buf.push(obj);
    total++;
    if (buf.length >= INSERT_BATCH) await flush();
  }
  await flush();
  return { count: total };
}

/**
 * Decide between sync and queued materialization based on a quick cardinality
 * probe. We probe by walking up to SYNC_THRESHOLD + 1 objects: if we exhaust
 * before the cap, run inline; otherwise enqueue.
 *
 * Returns "sync" if completed inline, "queued" if a queue message was sent.
 */
export async function materialize(
  ctx: MaterializationContext,
  queue: Queue<BlobMaterializationMessage> | undefined,
  storageSuffix: string,
): Promise<{ mode: "sync" | "queued"; count: number }> {
  if (!queue) {
    const r = await materializeSync(ctx);
    return { mode: "sync", count: r.count };
  }

  // Probe: walk up to threshold+1 to decide which path to take. The probe
  // result IS the materialized set when it fits — no double-walk needed.
  const probe = await materializeSync(ctx, { maxObjects: SYNC_THRESHOLD + 1 });
  if (probe.count <= SYNC_THRESHOLD) {
    return { mode: "sync", count: probe.count };
  }
  // Probe materialized the first SYNC_THRESHOLD+1 rows; queue catches the rest.
  await queue.send({
    type: "blob_materialization",
    repoId: ctx.repoId,
    orgId: ctx.orgId,
    storageSuffix,
    headSha: ctx.headSha,
  });
  return { mode: "queued", count: probe.count };
}

/**
 * Queue consumer entry point. Called from src/index.ts queue handler. Walks
 * the full reachable set; relies on ON CONFLICT to no-op rows already
 * materialized by the sync probe.
 */
export async function processBlobMaterializationMessage(
  msg: BlobMaterializationMessage,
  env: { REPOS_BUCKET: R2Bucket; AUTH_CACHE?: KVNamespace; GIT_OBJ_CACHE?: KVNamespace },
  db: Database,
): Promise<{ count: number }> {
  const storage = new GitR2Storage(env.REPOS_BUCKET, msg.orgId, msg.storageSuffix);
  if (env.AUTH_CACHE) storage.setRefCacheKv(env.AUTH_CACHE);
  if (env.GIT_OBJ_CACHE) storage.setObjCacheKv(env.GIT_OBJ_CACHE);
  storage.setBlobRepoContext(db, msg.repoId, msg.orgId);

  return materializeSync({
    db,
    storage,
    repoId: msg.repoId,
    orgId: msg.orgId,
    headSha: msg.headSha,
  });
}
