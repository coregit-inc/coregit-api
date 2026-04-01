/**
 * Workspace API — serverless Unix on CF Workers.
 *
 * POST /:slug/exec — Execute shell commands against a git repo.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { execInWorkspace } from "../workspace/exec";
import { recordUsage } from "../services/usage";
import { checkFreeLimits } from "../services/limits";
import type { Env, Variables } from "../types";

const workspace = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /v1/repos/:slug/exec
 *
 * Execute a shell command in the context of a git repository.
 * Filesystem backed by git objects in R2 — lazy reads, in-memory writes.
 * Optionally commits changes back to git.
 */
workspace.post("/:slug/exec", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const { slug } = c.req.param();

  // Free tier: check API call limit
  const apiLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "api_call");
  if (!apiLimit.allowed) {
    return c.json({
      error: "Free tier limit exceeded: API calls",
      used: apiLimit.used,
      limit: apiLimit.limit,
      upgrade_url: "https://app.coregit.dev/dashboard/billing",
    }, 429);
  }

  // Find repo
  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);

  if (!found) {
    return c.json({ error: "Repository not found" }, 404);
  }

  // Parse body
  let body: {
    command?: string;
    branch?: string;
    cwd?: string;
    env?: Record<string, string>;
    commit?: boolean;
    commit_message?: string;
    author?: { name: string; email: string };
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate
  if (!body.command || typeof body.command !== "string") {
    return c.json({ error: "command is required and must be a string" }, 400);
  }
  if (body.command.length > 10_000) {
    return c.json({ error: "command too long (max 10000 chars)" }, 400);
  }
  if (body.commit && !body.commit_message) {
    return c.json({ error: "commit_message is required when commit=true" }, 400);
  }

  // Create storage
  const storage = new GitR2Storage(c.env.REPOS_BUCKET, found.orgId, found.slug);

  try {
    const result = await execInWorkspace(storage, body.command, {
      branch: body.branch,
      cwd: body.cwd,
      env: body.env,
      commit: body.commit,
      commitMessage: body.commit_message,
      author: body.author,
    });

    // Track usage (fire-and-forget)
    recordUsage(
      c.executionCtx,
      db,
      orgId,
      "api_call",
      1,
      { endpoint: "workspace_exec", repo: slug },
      c.env.DODO_PAYMENTS_API_KEY,
      c.get("dodoCustomerId")
    );

    return c.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      changed_files: result.changedFiles,
      commit_sha: result.commitSha || null,
      execution_time_ms: result.executionTimeMs,
    });
  } catch (error) {
    console.error("[workspace/exec] error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export { workspace };
