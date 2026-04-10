/**
 * Fork (template) endpoints
 *
 * POST /v1/repos/:slug/fork              — Fork a repo
 * POST /v1/repos/:namespace/:slug/fork   — Fork a namespaced repo
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess, isMasterKey } from "../auth/scopes";
import { repo, organization, semanticIndex, codeGraphIndex } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { resolveRepo, buildGitUrl, buildApiUrl } from "../services/repo-resolver";
import { copyGraphForFork } from "../services/fork-graph";
import { recordUsage } from "../services/usage";
import { recordAudit } from "../services/audit";
import { checkFreeLimits } from "../services/limits";
import { extractRepoParams, validateNamespace } from "./helpers";
import type { Env, Variables } from "../types";

const forks = new Hono<{ Bindings: Env; Variables: Variables }>();

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;

function validateSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !slug.includes("--");
}

interface ForkRequest {
  slug: string;
  namespace?: string;
  description?: string;
  default_branch?: string;
}

const forkHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug: sourceSlug, namespace: sourceNamespace } = extractRepoParams(c);

  // Auth: need read access on source
  const resolved = await resolveRepo(db, bucket, { orgId, slug: sourceSlug, namespace: sourceNamespace });
  if (!resolved) return c.json({ error: "Source repository not found" }, 404);

  // Access control:
  // - Same org: need read access on source repo
  // - Cross-org: source must be a public template (is_template + visibility=public)
  const isSameOrg = resolved.repo.orgId === orgId;
  if (isSameOrg) {
    if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
  } else {
    if (!resolved.repo.isTemplate || resolved.repo.visibility !== "public") {
      return c.json({ error: "Cross-org fork requires a public template" }, 403);
    }
  }

  let body: ForkRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { slug: targetSlug, namespace: targetNamespace, description } = body;

  // Validate target slug
  if (!targetSlug || typeof targetSlug !== "string") {
    return c.json({ error: "slug is required" }, 400);
  }
  if (!validateSlug(targetSlug)) {
    return c.json({ error: "Invalid slug. Use lowercase letters, numbers, hyphens. 1-100 chars." }, 400);
  }
  if (targetNamespace !== undefined && targetNamespace !== null) {
    if (typeof targetNamespace !== "string" || !validateNamespace(targetNamespace)) {
      return c.json({ error: "Invalid namespace. Use lowercase letters, numbers, hyphens. 1-100 chars." }, 400);
    }
  }

  const ns = targetNamespace || null;

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

    // Check target uniqueness
    const existing = await resolveRepo(db, bucket, { orgId, slug: targetSlug, namespace: ns });
    if (existing) {
      return c.json({ error: "A repository with this slug already exists" }, 409);
    }

    const source = resolved.repo;
    const defaultBranch = body.default_branch || source.defaultBranch;
    const repoId = nanoid();

    // 1. Create DB record
    const [newRepo] = await db
      .insert(repo)
      .values({
        id: repoId,
        orgId,
        namespace: ns,
        slug: targetSlug,
        description: description || source.description,
        defaultBranch,
        visibility: "private",
        autoIndex: source.autoIndex,
        isTemplate: false,
        forkedFromRepoId: source.id,
        forkedFromOrgId: source.orgId,
        forkedAt: new Date(),
      })
      .returning();

    // Steps 2-5 wrapped in try/catch for rollback on partial failure
    let graphResult = { nodesCount: 0, edgesCount: 0 };
    let semanticInherited = false;
    let graphCopied = false;

    try {
      // 2. Copy R2 objects
      const sourceStorageSuffix = source.namespace ? `${source.namespace}/${source.slug}` : source.slug;
      const targetStorageSuffix = ns ? `${ns}/${targetSlug}` : targetSlug;
      const sourceBasePath = `${source.orgId}/${sourceStorageSuffix}`;
      const targetBasePath = `${orgId}/${targetStorageSuffix}`;

      await GitR2Storage.copyRepo(bucket, sourceBasePath, targetBasePath);

      // 3. Copy code graph (SQL bulk copy)
      graphResult = await copyGraphForFork(db, source.id, source.orgId, repoId, orgId);
      graphCopied = graphResult.nodesCount > 0;

      // 4. Create semantic index tracking record (inherits via parent namespace fallback)
      const [sourceSemanticIdx] = await db
        .select()
        .from(semanticIndex)
        .where(and(eq(semanticIndex.repoId, source.id), eq(semanticIndex.branch, defaultBranch)))
        .limit(1);

      if (sourceSemanticIdx) {
        await db.insert(semanticIndex).values({
          id: nanoid(),
          repoId,
          orgId,
          branch: defaultBranch,
          lastCommitSha: sourceSemanticIdx.lastCommitSha,
          chunksCount: sourceSemanticIdx.chunksCount,
          status: "ready",
          indexedAt: new Date(),
        });
        semanticInherited = true;
      }

      // 5. Create code graph index tracking record
      const [sourceGraphIdx] = await db
        .select()
        .from(codeGraphIndex)
        .where(and(eq(codeGraphIndex.repoId, source.id), eq(codeGraphIndex.branch, defaultBranch)))
        .limit(1);

      if (sourceGraphIdx) {
        await db.insert(codeGraphIndex).values({
          id: nanoid(),
          repoId,
          orgId,
          branch: defaultBranch,
          lastCommitSha: sourceGraphIdx.lastCommitSha,
          nodesCount: graphResult.nodesCount,
          edgesCount: graphResult.edgesCount,
          status: "ready",
          indexedAt: new Date(),
        });
      }
    } catch (forkError) {
      // Rollback: delete the repo record (cascades to semantic_index, code_graph_index, code_node, code_edge)
      await db.delete(repo).where(eq(repo.id, repoId)).catch(() => {});
      throw forkError;
    }

    // 6. Track usage + audit
    recordUsage(c.executionCtx, db, orgId, "repo_created", 1, {
      repo_id: repoId, forked_from: source.id,
    }, c.env.DODO_PAYMENTS_API_KEY, c.get("dodoCustomerId"));

    recordAudit(c.executionCtx, db, {
      orgId,
      actorId: c.get("apiKeyId"),
      actorType: isMasterKey(c.get("apiKeyPermissions")) ? "master_key" : "scoped_token",
      action: "repo.fork",
      resourceType: "repo",
      resourceId: repoId,
      metadata: {
        slug: targetSlug,
        namespace: ns,
        forked_from_repo_id: source.id,
        forked_from_slug: source.slug,
      },
      requestId: c.get("requestId"),
    });

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
        namespace: newRepo.namespace,
        slug: newRepo.slug,
        description: newRepo.description,
        default_branch: newRepo.defaultBranch,
        visibility: newRepo.visibility,
        is_template: newRepo.isTemplate,
        forked_from: {
          repo_id: source.id,
          org_id: source.orgId,
          slug: source.slug,
          namespace: source.namespace,
        },
        semantic_inherited: semanticInherited,
        graph_copied: graphCopied,
        graph_nodes_count: graphResult.nodesCount,
        git_url: buildGitUrl(orgSlug, targetSlug, ns, c.get("customDomain")),
        api_url: buildApiUrl(targetSlug, ns),
        created_at: newRepo.createdAt,
      },
      201
    );
  } catch (error) {
    console.error("Failed to fork repo:", error);
    return c.json({ error: "Failed to fork repository" }, 500);
  }
};

forks.post("/:slug/fork", apiKeyAuth, forkHandler);
forks.post("/:namespace/:slug/fork", apiKeyAuth, forkHandler);

export { forks };
