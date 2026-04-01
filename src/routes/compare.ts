/**
 * Compare endpoint — compare two refs
 *
 * GET /v1/repos/:slug/compare?base=main&head=feature
 *
 * Returns merge base, ahead/behind counts, file diffs, and mergeable status.
 * This is the key primitive for building PR/review UIs on top of Coregit.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import {
  findMergeBase,
  getCommitRange,
  flattenTree,
  diffFlattenedTrees,
  computeDiffStatsFromDiffs,
  cherryPickCommits,
  type FlatTree,
} from "../git/cherry-pick";
import { recordUsage } from "../services/usage";
import { checkFreeLimits } from "../services/limits";
import type { Env, Variables } from "../types";

const compare = new Hono<{ Bindings: Env; Variables: Variables }>();

async function resolveRef(storage: GitR2Storage, ref: string): Promise<string | null> {
  const [branchSha, tagSha] = await Promise.all([
    storage.getRef(`refs/heads/${ref}`),
    storage.getRef(`refs/tags/${ref}`),
  ]);
  if (branchSha) return branchSha;
  if (tagSha) return tagSha;
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  return null;
}

async function getTreeSha(storage: GitR2Storage, commitSha: string): Promise<string | null> {
  const raw = await storage.getObject(commitSha);
  if (!raw) return null;
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return null;
  return parseCommit(obj.content).tree;
}

function parseAuthorString(author: string): { name: string; email: string; date: string } {
  const match = author.match(/^(.+?)\s+<([^>]+)>\s+(\d+)/);
  if (match) {
    return {
      name: match[1],
      email: match[2],
      date: new Date(parseInt(match[3], 10) * 1000).toISOString(),
    };
  }
  return { name: author, email: "", date: "" };
}

// GET /v1/repos/:slug/compare
compare.get("/:slug/compare", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();
  const baseRef = c.req.query("base");
  const headRef = c.req.query("head");

  if (!baseRef || !headRef) {
    return c.json({ error: "base and head query parameters are required" }, 400);
  }

  // Free tier check
  const apiLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "api_call");
  if (!apiLimit.allowed) {
    return c.json({
      error: "Free tier limit exceeded: API calls",
      used: apiLimit.used,
      limit: apiLimit.limit,
      upgrade_url: "https://app.coregit.dev/dashboard/billing",
    }, 429);
  }

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);
  if (!found) return c.json({ error: "Repository not found" }, 404);

  const storage = new GitR2Storage(bucket, orgId, slug);

  const [baseSha, headSha] = await Promise.all([
    resolveRef(storage, baseRef),
    resolveRef(storage, headRef),
  ]);
  if (!baseSha) return c.json({ error: `Base ref '${baseRef}' not found` }, 404);
  if (!headSha) return c.json({ error: `Head ref '${headRef}' not found` }, 404);

  if (baseSha === headSha) {
    return c.json({
      base: baseSha,
      head: headSha,
      merge_base: baseSha,
      ahead_by: 0,
      behind_by: 0,
      commits: [],
      files: [],
      total_files_changed: 0,
      total_additions: 0,
      total_deletions: 0,
      mergeable: true,
      conflicts: [],
    });
  }

  try {
    const mergeBase = await findMergeBase(storage, baseSha, headSha);
    if (!mergeBase) {
      return c.json({ error: "No common ancestor found between base and head" }, 422);
    }

    // Get ahead commits (merge_base..head) and behind count (merge_base..base) in parallel
    const [aheadCommits, behindCommits] = await Promise.all([
      mergeBase === headSha ? Promise.resolve([]) : getCommitRange(storage, mergeBase, headSha),
      mergeBase === baseSha ? Promise.resolve([]) : getCommitRange(storage, mergeBase, baseSha),
    ]);

    // File diffs: compare merge_base tree vs head tree
    const [mergeBaseTreeSha, headTreeSha] = await Promise.all([
      getTreeSha(storage, mergeBase),
      getTreeSha(storage, headSha),
    ]);

    if (!mergeBaseTreeSha || !headTreeSha) {
      return c.json({ error: "Failed to resolve commit trees" }, 500);
    }

    const treeCache = new Map<string, FlatTree>();
    const [mergeBaseFlat, headFlat] = await Promise.all([
      flattenTree(storage, mergeBaseTreeSha, "", treeCache),
      flattenTree(storage, headTreeSha, "", treeCache),
    ]);

    const diffs = diffFlattenedTrees(mergeBaseFlat, headFlat);
    const stats = await computeDiffStatsFromDiffs(storage, diffs);

    const fileList = diffs.map((d) => ({
      path: d.path,
      status: d.type === "add" ? "added" : d.type === "delete" ? "removed" : "modified",
      old_sha: d.oldSha || null,
      new_sha: d.newSha || null,
    }));

    const commitList = aheadCommits.map((ci) => {
      const author = parseAuthorString(ci.commit.author);
      return {
        sha: ci.sha,
        message: ci.commit.message,
        author: author.name,
        email: author.email,
        date: author.date,
      };
    });

    // Mergeable check: dry-run cherry-pick if reasonable size
    let mergeable: boolean | null = null;
    let conflicts: string[] = [];

    if (aheadCommits.length > 0 && aheadCommits.length <= 50) {
      const dryRun = await cherryPickCommits(storage, aheadCommits, baseSha);
      mergeable = dryRun.success;
      conflicts = dryRun.conflicts || [];
    }

    recordUsage(c.executionCtx, db, orgId, "api_call", 1, {
      operation: "compare",
      repo_slug: slug,
    }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));

    return c.json({
      base: baseSha,
      head: headSha,
      merge_base: mergeBase,
      ahead_by: aheadCommits.length,
      behind_by: behindCommits.length,
      commits: commitList,
      files: fileList,
      total_files_changed: stats.filesChanged,
      total_additions: stats.additions,
      total_deletions: stats.deletions,
      mergeable,
      conflicts,
    });
  } catch (error) {
    console.error("Failed to compare:", error);
    return c.json({ error: "Failed to compare refs" }, 500);
  }
});

export { compare };
