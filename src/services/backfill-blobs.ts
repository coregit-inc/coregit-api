/**
 * Backfill: migrate a repo's legacy `{orgId}/{slug}/objects/{sha[:2]}/{sha[2:]}`
 * R2 keys into the global `_blobs/{sha[:2]}/{sha[2:]}` keyspace, registering
 * each blob in `blob` + `blob_repo`. Idempotent — safe to re-run on a repo.
 *
 * NOT auto-invoked. Wire into an admin endpoint or one-off cron when you're
 * ready to migrate existing data. Each invocation handles a single repo's
 * loose-object set; pack/ files stay untouched (they remain valid as long as
 * the read-fallback chain stays in storage.ts).
 */
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { unzlibSync } from "fflate";
import { parseGitObject, type GitObjectType } from "../git/objects";

interface BackfillResult {
  repoId: string;
  copied: number;
  skipped: number;
  failed: number;
  /** First N error messages, capped to keep logs manageable. */
  errors: string[];
}

const BATCH = 25;
const MAX_REPORTED_ERRORS = 5;

export async function backfillRepoBlobs(
  bucket: R2Bucket,
  db: Database,
  repo: { id: string; orgId: string; namespace: string | null; slug: string },
): Promise<BackfillResult> {
  const storageSuffix = repo.namespace ? `${repo.namespace}/${repo.slug}` : repo.slug;
  const legacyPrefix = `${repo.orgId}/${storageSuffix}/objects/`;
  const result: BackfillResult = { repoId: repo.id, copied: 0, skipped: 0, failed: 0, errors: [] };

  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: legacyPrefix, cursor });
    cursor = listed.truncated ? listed.cursor : undefined;

    const targets = listed.objects.filter((o) => !o.key.endsWith(".gitkeep"));

    for (let i = 0; i < targets.length; i += BATCH) {
      const slice = targets.slice(i, i + BATCH);
      await Promise.all(slice.map(async (obj) => {
        try {
          const parts = obj.key.slice(legacyPrefix.length).split("/");
          if (parts.length !== 2 || parts[0].length !== 2 || parts[1].length !== 38) {
            result.skipped++;
            return;
          }
          const sha = parts[0] + parts[1];
          const targetKey = `_blobs/${parts[0]}/${parts[1]}`;

          // Skip if already present in the global blob store — safe under concurrent backfill.
          const exists = await bucket.head(targetKey);
          if (exists) {
            // Still ensure the refcount edge — blob may have been written by
            // another repo before we ran here.
            await ensureBlobRow(db, sha, exists.size, "blob"); // type assumed; refined below if we read
            await db.execute(sql`
              INSERT INTO blob_repo (sha, repo_id, org_id) VALUES (${sha}, ${repo.id}, ${repo.orgId})
              ON CONFLICT (sha, repo_id) DO NOTHING
            `);
            result.skipped++;
            return;
          }

          // Read source bytes, write to global key, parse type+size for `blob` row.
          const sourceObj = await bucket.get(obj.key);
          if (!sourceObj) {
            result.skipped++;
            return;
          }
          const compressed = new Uint8Array(await sourceObj.arrayBuffer());
          await bucket.put(targetKey, compressed, {
            httpMetadata: { contentType: "application/x-git-object" },
          });

          let type: GitObjectType = "blob";
          let size = compressed.byteLength;
          try {
            const parsed = parseGitObject(unzlibSync(compressed));
            type = parsed.type;
            size = parsed.size;
          } catch {
            // Unparseable — keep defaults; row still gets recorded for refcount.
          }

          await ensureBlobRow(db, sha, size, type);
          await db.execute(sql`
            INSERT INTO blob_repo (sha, repo_id, org_id) VALUES (${sha}, ${repo.id}, ${repo.orgId})
            ON CONFLICT (sha, repo_id) DO NOTHING
          `);
          result.copied++;
        } catch (err) {
          result.failed++;
          if (result.errors.length < MAX_REPORTED_ERRORS) {
            result.errors.push(`${obj.key}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }));
    }
  } while (cursor);

  return result;
}

async function ensureBlobRow(db: Database, sha: string, size: number, type: GitObjectType): Promise<void> {
  await db.execute(sql`
    INSERT INTO blob (sha, size_bytes, type) VALUES (${sha}, ${size}, ${type})
    ON CONFLICT (sha) DO NOTHING
  `);
}

/**
 * Drop the legacy R2 prefix for a repo after a successful backfill.
 * Verifies the repo is fully migrated (every legacy object also has a
 * blob_repo row) before deleting.
 */
export async function deleteLegacyPrefixIfMigrated(
  bucket: R2Bucket,
  db: Database,
  repo: { id: string; orgId: string; namespace: string | null; slug: string },
): Promise<{ deleted: number; aborted: boolean }> {
  const storageSuffix = repo.namespace ? `${repo.namespace}/${repo.slug}` : repo.slug;
  const legacyPrefix = `${repo.orgId}/${storageSuffix}/objects/`;

  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: legacyPrefix, cursor });
    for (const o of listed.objects) {
      if (!o.key.endsWith(".gitkeep")) keys.push(o.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Verify each blob has a blob_repo row before deleting the legacy bytes.
  // If any are missing, abort and let the next backfill pass fix it.
  const shas = keys
    .map((k) => {
      const parts = k.slice(legacyPrefix.length).split("/");
      if (parts.length !== 2 || parts[0].length !== 2 || parts[1].length !== 38) return null;
      return parts[0] + parts[1];
    })
    .filter((s): s is string => s !== null);

  if (shas.length > 0) {
    const result = (await db.execute(sql`
      SELECT sha FROM blob_repo WHERE repo_id = ${repo.id} AND sha = ANY(${shas}::text[])
    `)) as unknown as { sha: string }[];
    const present = new Set(result.map((r) => r.sha));
    const missing = shas.filter((s) => !present.has(s));
    if (missing.length > 0) return { deleted: 0, aborted: true };
  }

  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
    deleted += Math.min(1000, keys.length - i);
  }
  return { deleted, aborted: false };
}
