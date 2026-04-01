/**
 * Cherry-pick endpoint — replay commits onto a new base
 *
 * POST /v1/repos/:slug/cherry-pick
 *
 * Core primitive for building stacked changes, rebase workflows,
 * and conflict detection on top of Coregit.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import {
  getCommitRange,
  cherryPickCommits,
  isBaseCommitNotAncestorError,
} from "../git/cherry-pick";
import { recordUsage } from "../services/usage";
import { checkFreeLimits } from "../services/limits";
import { isValidSha } from "../git/validation";
import type { Env, Variables } from "../types";

const cherryPick = new Hono<{ Bindings: Env; Variables: Variables }>();

const MAX_CHERRY_PICK_COMMITS = 100;

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

// POST /v1/repos/:slug/cherry-pick
cherryPick.post("/:slug/cherry-pick", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();

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

  let body: {
    base: string;
    head: string;
    onto: string;
    branch?: string;
    expected_sha?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { base, head, onto, branch, expected_sha } = body;

  if (!base || !head || !onto) {
    return c.json({ error: "base, head, and onto are required" }, 400);
  }

  const storage = new GitR2Storage(bucket, orgId, slug);

  // Resolve all refs in parallel
  const [baseSha, headSha, ontoSha] = await Promise.all([
    resolveRef(storage, base),
    resolveRef(storage, head),
    resolveRef(storage, onto),
  ]);
  if (!baseSha) return c.json({ error: `Base ref '${base}' not found` }, 404);
  if (!headSha) return c.json({ error: `Head ref '${head}' not found` }, 404);
  if (!ontoSha) return c.json({ error: `Onto ref '${onto}' not found` }, 404);

  if (baseSha === headSha) {
    return c.json({ success: true, head_sha: null, onto_sha: ontoSha, commits_created: 0 });
  }

  try {
    // Get commits in range
    const commits = await getCommitRange(storage, baseSha, headSha);

    if (commits.length > MAX_CHERRY_PICK_COMMITS) {
      return c.json({
        error: `Too many commits to cherry-pick: ${commits.length} (max ${MAX_CHERRY_PICK_COMMITS})`,
      }, 400);
    }

    // Cherry-pick
    const result = await cherryPickCommits(storage, commits, ontoSha);

    if (!result.success) {
      return c.json({
        success: false,
        onto_sha: ontoSha,
        conflicts: result.conflicts || [],
        last_clean_sha: result.lastCleanSha || null,
        commits_created: 0,
      });
    }

    // Optionally update branch
    let branchUpdated = false;
    if (branch && result.headSha) {
      if (expected_sha) {
        // CAS update
        const ref = await storage.getRefWithEtag(`refs/heads/${branch}`);
        if (!ref) {
          // Branch doesn't exist yet — create it
          await storage.setRef(`refs/heads/${branch}`, result.headSha);
          branchUpdated = true;
        } else if (ref.sha !== expected_sha) {
          return c.json({
            error: "Branch was updated concurrently (expected_sha mismatch)",
            current_sha: ref.sha,
          }, 409);
        } else {
          const ok = await storage.setRefConditional(`refs/heads/${branch}`, result.headSha, ref.etag);
          if (!ok) {
            return c.json({ error: "Branch was updated concurrently, retry" }, 409);
          }
          branchUpdated = true;
        }
      } else {
        // Plain set (create or overwrite)
        await storage.setRef(`refs/heads/${branch}`, result.headSha);
        branchUpdated = true;
      }
    }

    recordUsage(c.executionCtx, db, orgId, "api_call", 1, {
      operation: "cherry_pick",
      repo_slug: slug,
      commits_count: commits.length,
    }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));

    return c.json({
      success: true,
      head_sha: result.headSha,
      onto_sha: ontoSha,
      commits_created: commits.length,
      ...(branch ? { branch, branch_updated: branchUpdated } : {}),
    });
  } catch (error) {
    if (isBaseCommitNotAncestorError(error)) {
      return c.json({
        error: `Base commit is not an ancestor of head: ${(error as Error).message}`,
      }, 400);
    }
    console.error("Failed to cherry-pick:", error);
    return c.json({ error: "Failed to cherry-pick commits" }, 500);
  }
});

export { cherryPick };
