/**
 * Admin-only one-shot repair endpoints.
 *
 * Gated by `Authorization: Bearer $CRON_SECRET`. Intended to be invoked
 * manually (via curl or a scheduled trigger) for emergency repair tasks.
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createCommit, hashGitObject, parseCommit, parseGitObject, createTree } from "../git/objects";
import { GitR2Storage } from "../git/storage";
import { attachRepoHotDO } from "../services/repo-resolver";
import type { Env, Variables } from "../types";

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// Historical bug: before fe173e6, init commits referenced this (wrong)
// empty tree SHA. The actual Git well-known empty tree SHA is the second.
const BAD_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf899d15006ef8a2f";
const CORRECT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_BYTES = createTree([]);

function requireAdmin(c: { req: { header(name: string): string | undefined }; json: (body: unknown, status?: number) => Response }, secret: string | undefined): Response | null {
  if (!secret) return c.json({ error: "Admin endpoint not configured" }, 503);
  const auth = c.req.header("authorization");
  if (auth !== `Bearer ${secret}`) return c.json({ error: "Unauthorized" }, 401);
  return null;
}

/**
 * POST /v1/admin/repair-empty-trees
 *
 * Scans every repo; for each whose default-branch HEAD is an init commit
 * (no parents) referencing the wrong empty tree SHA, replaces it with a
 * new init commit that references the correct SHA, and advances the ref.
 *
 * Safe to rerun — only repos matching the exact broken signature are touched.
 * Skips repos with pushed content on top.
 */
admin.post("/repair-empty-trees", async (c) => {
  const forbidden = requireAdmin(c, c.env.CRON_SECRET);
  if (forbidden) return forbidden;

  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const dryRun = c.req.query("dry_run") === "1";
  const limit = Math.min(Math.max(1, Number(c.req.query("limit") ?? 500)), 2000);

  const repos = (await db.execute(sql`
    SELECT id, org_id, namespace, slug, default_branch
    FROM repo
    WHERE is_template = false
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)).rows as Array<{
    id: string;
    org_id: string;
    namespace: string | null;
    slug: string;
    default_branch: string;
  }>;

  const scanned: string[] = [];
  const repaired: Array<{ repo: string; old_head: string; new_head: string }> = [];
  const skipped: Array<{ repo: string; reason: string }> = [];
  const errors: Array<{ repo: string; error: string }> = [];

  for (const repo of repos) {
    const label = repo.namespace ? `${repo.namespace}/${repo.slug}` : repo.slug;
    scanned.push(label);
    try {
      const storageSuffix = repo.namespace ? `${repo.namespace}/${repo.slug}` : repo.slug;
      const storage = new GitR2Storage(bucket, repo.org_id, storageSuffix);
      storage.setRefCacheKv(c.env.AUTH_CACHE as KVNamespace | undefined);
      storage.setObjCacheKv(c.env.GIT_OBJ_CACHE as KVNamespace | undefined);
      attachRepoHotDO(storage, repo.org_id, storageSuffix, repo.id);

      const refName = `refs/heads/${repo.default_branch}`;
      const headSha = await storage.getRef(refName);
      if (!headSha) {
        skipped.push({ repo: label, reason: "no_head" });
        continue;
      }
      const commitRaw = await storage.getObject(headSha);
      if (!commitRaw) {
        skipped.push({ repo: label, reason: "head_commit_missing" });
        continue;
      }
      const parsed = parseGitObject(commitRaw);
      if (parsed.type !== "commit") {
        skipped.push({ repo: label, reason: `head_not_commit:${parsed.type}` });
        continue;
      }
      const commit = parseCommit(parsed.content);
      if (commit.tree !== BAD_EMPTY_TREE_SHA) {
        skipped.push({ repo: label, reason: "tree_ok" });
        continue;
      }
      if (commit.parents.length !== 0) {
        // Has pushed content on top — do not touch (would rewrite history).
        skipped.push({ repo: label, reason: "has_parents" });
        continue;
      }

      if (dryRun) {
        repaired.push({ repo: label, old_head: headSha, new_head: "(dry-run)" });
        continue;
      }

      // Build the replacement init commit with the correct tree SHA, same author/timestamp/message.
      const newCommitBytes = createCommit({
        tree: CORRECT_EMPTY_TREE_SHA,
        parents: [],
        author: commit.author,
        committer: commit.committer,
        message: commit.message,
      });
      const newCommitSha = await hashGitObject("commit", newCommitBytes);

      await storage.putObject(CORRECT_EMPTY_TREE_SHA, "tree", EMPTY_TREE_BYTES);
      await storage.putObject(newCommitSha, "commit", newCommitBytes);
      await storage.setRef(refName, newCommitSha);

      repaired.push({ repo: label, old_head: headSha, new_head: newCommitSha });
    } catch (err) {
      errors.push({ repo: label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({
    dry_run: dryRun,
    scanned: scanned.length,
    repaired: repaired.length,
    skipped: skipped.length,
    errors: errors.length,
    details: {
      repaired,
      skipped_by_reason: Object.fromEntries(
        Array.from(
          skipped.reduce((m, s) => {
            m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
            return m;
          }, new Map<string, number>())
        )
      ),
      errors,
    },
  });
});

export { admin };
