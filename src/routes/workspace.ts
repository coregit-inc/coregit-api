/**
 * Workspace API — serverless Unix on CF Workers.
 *
 * POST /:slug/exec           — Execute shell commands against a single repo.
 * POST /v1/workspace/exec    — Execute shell commands across multiple repos.
 */

import { Hono } from "hono";
import { eq, and, isNull, or } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess, getAccessibleRepoKeys } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repo } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { GitR2FileSystem } from "../workspace/filesystem";
import { execInWorkspace } from "../workspace/exec";
import { execInMultiRepoWorkspace, type RepoMount } from "../workspace/multi-repo-exec";
import { parseGitObject, parseCommit } from "../git/objects";

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

// ── Multi-repo workspace ──

const MAX_MULTI_REPOS = 10;

const multiWorkspace = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /v1/workspace/exec
 *
 * Execute a shell command across multiple repos mounted at /{slug}/.
 * Changes are committed per-repo independently.
 */
multiWorkspace.post("/workspace/exec", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;

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

  let body: {
    repos?: { slug: string; branch?: string; namespace?: string | null }[];
    command?: string;
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
  if (!body.repos || !Array.isArray(body.repos) || body.repos.length === 0) {
    return c.json({ error: "repos is required and must be a non-empty array" }, 400);
  }
  if (body.repos.length > MAX_MULTI_REPOS) {
    return c.json({ error: `Too many repos (max ${MAX_MULTI_REPOS})` }, 400);
  }
  if (body.commit && !body.commit_message) {
    return c.json({ error: "commit_message is required when commit=true" }, 400);
  }

  // Check for duplicate slugs
  const slugSet = new Set<string>();
  for (const r of body.repos) {
    if (!r.slug || typeof r.slug !== "string") {
      return c.json({ error: "Each repo must have a slug" }, 400);
    }
    const key = r.namespace ? `${r.namespace}/${r.slug}` : r.slug;
    if (slugSet.has(key)) {
      return c.json({ error: `Duplicate repo: ${key}` }, 400);
    }
    slugSet.add(key);
  }

  try {
    // Resolve all repos in parallel
    const mountResults = await Promise.all(
      body.repos.map(async (repoReq) => {
        const resolved = await resolveRepo(db, bucket, {
          orgId,
          slug: repoReq.slug,
          namespace: repoReq.namespace || null,
        });
        if (!resolved) return { error: `Repository not found: ${repoReq.slug}` };

        // Check access
        if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, body.commit ? "write" : "read")) {
          return { error: `Insufficient permissions for repo: ${repoReq.slug}` };
        }

        const found = resolved.repo;
        const storage = resolved.storage;
        const branchName = repoReq.branch || found.defaultBranch;
        const branchRef = `refs/heads/${branchName}`;

        // Resolve branch → commit → tree
        const commitSha = await storage.getRef(branchRef);
        if (!commitSha) return { error: `Branch '${branchName}' not found in repo ${repoReq.slug}` };

        const commitRaw = await storage.getObject(commitSha);
        if (!commitRaw) return { error: `Commit object not found in repo ${repoReq.slug}` };

        const commitObj = parseGitObject(commitRaw);
        if (commitObj.type !== "commit") return { error: `Invalid commit in repo ${repoReq.slug}` };

        const commit = parseCommit(commitObj.content);
        const treeSha = commit.tree;

        const fs = new GitR2FileSystem(storage, treeSha);

        return {
          mount: {
            slug: repoReq.slug,
            storage,
            branch: branchName,
            commitSha,
            branchRef,
            treeSha,
            fs,
          } satisfies RepoMount,
        };
      })
    );

    // Check for errors
    for (const result of mountResults) {
      if ("error" in result) {
        return c.json({ error: result.error }, 400);
      }
    }

    const mounts = mountResults.map((r) => (r as { mount: RepoMount }).mount);

    const result = await execInMultiRepoWorkspace(mounts, body.command, {
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
      commits: result.commits,
      repos_mounted: mounts.map((m) => m.slug),
      execution_time_ms: result.executionTimeMs,
    });
  } catch (error) {
    console.error("[workspace/multi-exec] error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export { workspace, multiWorkspace };
