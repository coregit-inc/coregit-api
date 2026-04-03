/**
 * Workspace API — serverless Unix on CF Workers.
 *
 * POST /:slug/exec — Execute shell commands against a git repo.
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { execInWorkspace } from "../workspace/exec";

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
const execHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

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
  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "write")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  // Parse body
  let body: {
    command?: string;
    branch?: string;
    ref?: string;
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
  if (body.commit && body.ref && !body.branch) {
    return c.json({ error: "branch is required when using commit=true with ref" }, 400);
  }

  try {
    const result = await execInWorkspace(storage, body.command, {
      branch: body.branch,
      ref: body.ref,
      cwd: body.cwd,
      env: body.env,
      commit: body.commit,
      commitMessage: body.commit_message,
      author: body.author,
    });

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
};
workspace.post("/:slug/exec", apiKeyAuth, execHandler);
workspace.post("/:namespace/:slug/exec", apiKeyAuth, execHandler);

export { workspace };
