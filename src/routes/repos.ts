/**
 * Repository CRUD endpoints
 *
 * POST   /v1/repos          — Create repository
 * GET    /v1/repos          — List repositories
 * GET    /v1/repos/:slug    — Get repository
 * PATCH  /v1/repos/:slug    — Update repository
 * DELETE /v1/repos/:slug    — Delete repository
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { repo, organization } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { createTree, createCommit, hashGitObject, parseGitObject, parseCommit } from "../git/objects";
import { recordUsage } from "../services/usage";
import { checkFreeLimits } from "../services/limits";
import type { Env, Variables } from "../types";

const repos = new Hono<{ Bindings: Env; Variables: Variables }>();

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;

function validateSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !slug.includes("--");
}

// POST /v1/repos
repos.post("/", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;

  let body: {
    slug: string;
    description?: string;
    default_branch?: string;
    visibility?: string;
    init?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { slug, description, default_branch = "main", visibility = "private", init = true } = body;

  if (!slug || typeof slug !== "string") {
    return c.json({ error: "slug is required" }, 400);
  }
  if (!validateSlug(slug)) {
    return c.json({ error: "Invalid slug. Use lowercase letters, numbers, hyphens. 1-100 chars." }, 400);
  }
  if (visibility !== "public" && visibility !== "private") {
    return c.json({ error: "visibility must be 'public' or 'private'" }, 400);
  }
  if (description && description.length > 500) {
    return c.json({ error: "Description must be at most 500 characters" }, 400);
  }

  try {
    // Free tier: check repo limit
    const repoLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "repo_created");
    if (!repoLimit.allowed) {
      return c.json({
        error: "Free tier limit exceeded: repositories",
        used: repoLimit.used,
        limit: repoLimit.limit,
        upgrade_url: "https://app.coregit.dev/dashboard/billing",
      }, 429);
    }

    // Check uniqueness
    const existing = await db
      .select({ id: repo.id })
      .from(repo)
      .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
      .limit(1);

    if (existing.length > 0) {
      return c.json({ error: "A repository with this slug already exists" }, 409);
    }

    const repoId = nanoid();

    // Create DB record
    const [newRepo] = await db
      .insert(repo)
      .values({
        id: repoId,
        orgId,
        slug,
        description: description || null,
        defaultBranch: default_branch,
        visibility,
      })
      .returning();

    // Initialize R2 storage
    const storage = new GitR2Storage(bucket, orgId, slug);
    await storage.setHead(`refs/heads/${default_branch}`);

    if (init) {
      // Create empty tree + initial commit
      const emptyTree = createTree([]);
      const treeSha = await hashGitObject("tree", emptyTree);
      await storage.putObject(treeSha, "tree", emptyTree);

      const timestamp = Math.floor(Date.now() / 1000);
      const identity = `CoreGit <noreply@coregit.dev> ${timestamp} +0000`;
      const commitContent = createCommit({
        tree: treeSha,
        parents: [],
        author: identity,
        committer: identity,
        message: "Initial commit",
      });
      const commitSha = await hashGitObject("commit", commitContent);
      await storage.putObject(commitSha, "commit", commitContent);
      await storage.setRef(`refs/heads/${default_branch}`, commitSha);
    }

    // Track usage
    recordUsage(c.executionCtx, db, orgId, "repo_created", 1, { repo_id: repoId }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));

    // Look up org slug for git_url
    const [org] = await db
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    const orgSlug = org?.slug || orgId;

    return c.json(
      {
        id: newRepo.id,
        slug: newRepo.slug,
        description: newRepo.description,
        default_branch: newRepo.defaultBranch,
        visibility: newRepo.visibility,
        git_url: `https://api.coregit.dev/${orgSlug}/${slug}.git`,
        api_url: `https://api.coregit.dev/v1/repos/${slug}`,
        created_at: newRepo.createdAt,
      },
      201
    );
  } catch (error) {
    console.error("Failed to create repo:", error);
    return c.json({ error: "Failed to create repository" }, 500);
  }
});

// GET /v1/repos
repos.get("/", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);

  try {
    const repoList = await db
      .select()
      .from(repo)
      .where(eq(repo.orgId, orgId))
      .orderBy(repo.updatedAt)
      .limit(limit)
      .offset(offset);

    return c.json({
      repos: repoList.map((r) => ({
        id: r.id,
        slug: r.slug,
        description: r.description,
        default_branch: r.defaultBranch,
        visibility: r.visibility,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
      limit,
      offset,
    });
  } catch (error) {
    console.error("Failed to list repos:", error);
    return c.json({ error: "Failed to list repositories" }, 500);
  }
});

// GET /v1/repos/:slug
repos.get("/:slug", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();

  try {
    const [found] = await db
      .select()
      .from(repo)
      .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
      .limit(1);

    if (!found) {
      return c.json({ error: "Repository not found" }, 404);
    }

    // Check if repo is empty
    const storage = new GitR2Storage(bucket, orgId, slug);
    const headSha = await storage.resolveHead();
    let isEmpty = !headSha;

    if (headSha) {
      const raw = await storage.getObject(headSha);
      if (raw) {
        const obj = parseGitObject(raw);
        if (obj.type === "commit") {
          const commit = parseCommit(obj.content);
          const treeRaw = await storage.getObject(commit.tree);
          if (treeRaw) {
            const treeObj = parseGitObject(treeRaw);
            isEmpty = treeObj.content.length === 0;
          }
        }
      }
    }

    // Look up org slug for git_url
    const [org] = await db
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);
    const orgSlug = org?.slug || orgId;

    return c.json({
      id: found.id,
      slug: found.slug,
      description: found.description,
      default_branch: found.defaultBranch,
      visibility: found.visibility,
      is_empty: isEmpty,
      git_url: `https://api.coregit.dev/${orgSlug}/${slug}.git`,
      api_url: `https://api.coregit.dev/v1/repos/${slug}`,
      created_at: found.createdAt,
      updated_at: found.updatedAt,
    });
  } catch (error) {
    console.error("Failed to get repo:", error);
    return c.json({ error: "Failed to get repository" }, 500);
  }
});

// PATCH /v1/repos/:slug
repos.patch("/:slug", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const { slug } = c.req.param();

  let body: { description?: string; visibility?: string; default_branch?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const [found] = await db
      .select()
      .from(repo)
      .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
      .limit(1);

    if (!found) {
      return c.json({ error: "Repository not found" }, 404);
    }

    const updates: Partial<typeof repo.$inferInsert> = {};
    if (body.description !== undefined) updates.description = body.description;
    if (body.visibility !== undefined) {
      if (body.visibility !== "public" && body.visibility !== "private") {
        return c.json({ error: "visibility must be 'public' or 'private'" }, 400);
      }
      updates.visibility = body.visibility;
    }
    if (body.default_branch !== undefined) {
      // Verify the branch actually exists before setting it as default
      const storage = new GitR2Storage(c.env.REPOS_BUCKET, orgId, slug);
      const branchSha = await storage.getRef(`refs/heads/${body.default_branch}`);
      if (!branchSha) {
        return c.json({ error: `Branch '${body.default_branch}' does not exist` }, 400);
      }
      updates.defaultBranch = body.default_branch;
      await storage.setHead(`refs/heads/${body.default_branch}`);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const [updated] = await db
      .update(repo)
      .set(updates)
      .where(eq(repo.id, found.id))
      .returning();

    return c.json({
      id: updated.id,
      slug: updated.slug,
      description: updated.description,
      default_branch: updated.defaultBranch,
      visibility: updated.visibility,
      updated_at: updated.updatedAt,
    });
  } catch (error) {
    console.error("Failed to update repo:", error);
    return c.json({ error: "Failed to update repository" }, 500);
  }
});

// DELETE /v1/repos/:slug
repos.delete("/:slug", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug } = c.req.param();

  try {
    const [found] = await db
      .select()
      .from(repo)
      .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
      .limit(1);

    if (!found) {
      return c.json({ error: "Repository not found" }, 404);
    }

    // Delete R2 storage
    const basePath = `${orgId}/${slug}/`;
    let cursor: string | undefined;
    const keysToDelete: string[] = [];

    do {
      const listed = await bucket.list({ prefix: basePath, cursor });
      for (const obj of listed.objects) {
        keysToDelete.push(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    for (let i = 0; i < keysToDelete.length; i += 1000) {
      await bucket.delete(keysToDelete.slice(i, i + 1000));
    }

    // Delete DB record (cascades to snapshots)
    await db.delete(repo).where(eq(repo.id, found.id));

    recordUsage(c.executionCtx, db, orgId, "repo_deleted", 1, { repo_id: found.id }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));

    return c.json({ deleted: true });
  } catch (error) {
    console.error("Failed to delete repo:", error);
    return c.json({ error: "Failed to delete repository" }, 500);
  }
});

export { repos };
