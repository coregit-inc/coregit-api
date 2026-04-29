/**
 * Fork (template) endpoints — Instant Fork
 *
 * POST /v1/repos/:slug/fork              — Fork a repo
 * POST /v1/repos/:namespace/:slug/fork   — Fork a namespaced repo
 *
 * Default mode is "instant": creates a new repo row + fork_snapshot of parent
 * refs + materializes blob_repo edges for every reachable object. Zero R2 blob
 * copies, refs read through fork_snapshot until the fork rewrites them.
 *
 * Use {mode:"deep"} to opt back into the legacy copy-everything behavior. Auto-
 * flatten kicks in when fork_depth would exceed 16: mode is forced to "deep".
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess, isMasterKey } from "../auth/scopes";
import { repo, forkSnapshot } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { resolveRepo, buildGitUrl, buildApiUrl, getOrgSlug } from "../services/repo-resolver";
import { recordUsage } from "../services/usage";
import { recordAudit } from "../services/audit";
import { deliverWebhooks } from "../services/webhook-delivery";
import { checkFreeLimits } from "../services/limits";
import { materialize } from "../services/blob-materialization";
import { extractRepoParams, validateNamespace } from "./helpers";
import type { Env, Variables } from "../types";

const forks = new Hono<{ Bindings: Env; Variables: Variables }>();

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;
const MAX_FORK_DEPTH = 16;

function validateSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !slug.includes("--");
}

interface ForkRequest {
  slug: string;
  namespace?: string;
  description?: string;
  default_branch?: string;
  /** "instant" (default) — point-in-time snapshot, zero blob copy.
   *  "deep" — copy everything, fully self-contained fork (slower). */
  mode?: "instant" | "deep";
}

const forkHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug: sourceSlug, namespace: sourceNamespace } = extractRepoParams(c);

  // Auth: need read access on source
  const resolved = await resolveRepo(db, bucket, { orgId, slug: sourceSlug, namespace: sourceNamespace });
  if (!resolved) return c.json({ error: "Source repository not found" }, 404);

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
  const requestedMode: "instant" | "deep" = body.mode === "deep" ? "deep" : "instant";

  try {
    const repoLimit = await checkFreeLimits(db, orgId, c.get("orgTier"), "repo_created");
    if (!repoLimit.allowed) {
      return c.json({
        error: "Free tier limit exceeded: repositories",
        used: repoLimit.used,
        limit: repoLimit.limit,
        upgrade_url: "https://app.coregit.dev/dashboard/billing",
      }, 429);
    }

    const existing = await resolveRepo(db, bucket, { orgId, slug: targetSlug, namespace: ns });
    if (existing) {
      return c.json({ error: "A repository with this slug already exists" }, 409);
    }

    const source = resolved.repo;
    const defaultBranch = body.default_branch || source.defaultBranch;
    const repoId = nanoid();

    // Chain bookkeeping. Auto-flatten when depth would exceed the cap.
    const sourceForkRoot = source.forkRoot ?? source.id;
    const sourceForkDepth = source.forkDepth ?? 0;
    const sourceForkChain = source.forkChain ?? [];
    let forkMode = requestedMode;
    let forkDepth = sourceForkDepth + 1;
    let forkChain = [...sourceForkChain, source.id];
    if (forkDepth > MAX_FORK_DEPTH) {
      forkMode = "deep";
      forkDepth = 0;
      forkChain = [];
    }
    // Cycle detection: refuse if source's chain somehow contains the new id
    // (cannot happen with nanoid, but cheap to check).
    if (sourceForkChain.includes(repoId)) {
      return c.json({ error: "Fork would create a cycle" }, 400);
    }

    // Resolve parent's HEAD ref + all branch/tag refs into a snapshot.
    // listRefs reads R2 directly under source.basePath; cheap on small ref counts.
    const parentRefs = Object.fromEntries(await resolved.storage.listRefs());
    const parentHead = await resolved.storage.getHead();
    const headSha = await resolved.storage.resolveHead();

    // 1. Create the repo row.
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
        forkRoot: forkMode === "deep" ? repoId : sourceForkRoot,
        forkDepth,
        forkChain,
        forkMode,
      })
      .returning();

    let materializationMode: "sync" | "queued" | "skipped" = "skipped";
    let materializedCount = 0;

    try {
      // 2. Snapshot parent refs into fork_snapshot — read-fallback for getRef.
      //    A push to the fork rewrites the ref in R2 (CoW); the snapshot is the
      //    durable point-in-time anchor that survives parent mutations.
      // Snapshot the literal HEAD content so getHead's fallback parser sees
      // exactly what R2 would have served. Symbolic HEAD is "ref: <name>";
      // detached HEAD is a bare 40-char SHA.
      const parentHeadLiteral = parentHead
        ? (parentHead.type === "ref" ? `ref: ${parentHead.value}` : parentHead.value)
        : `ref: refs/heads/${defaultBranch}`;
      await db.insert(forkSnapshot).values({
        repoId,
        parentRepoId: source.id,
        parentRefs: parentRefs,
        parentHead: parentHeadLiteral,
      });

      // 3. Materialize blob_repo edges. Probes inline up to SYNC_THRESHOLD,
      //    queues the rest. For 'deep' fork mode, we still skip R2 copy — the
      //    blobs already live in `_blobs/` (or legacy paths read-fallback) and
      //    blob_repo gives the fork its own refcount edges.
      if (headSha) {
        const targetStorageSuffix = ns ? `${ns}/${targetSlug}` : targetSlug;
        const targetStorage = new GitR2Storage(bucket, orgId, targetStorageSuffix);
        // Use the source storage to walk — cheaper R2 hits, parent's objects
        // are already in the global blob keyspace.
        const result = await materialize(
          { db, storage: resolved.storage, repoId, orgId, headSha },
          c.env.INDEXING_QUEUE as Queue<any> | undefined,
          targetStorageSuffix,
        );
        materializationMode = result.mode;
        materializedCount = result.count;
        // Suppress unused-var warning for targetStorage; reserved for future
        // pack-rebuild step on the new repo.
        void targetStorage;
      }

      // 4. Write HEAD pointer to R2 so `git clone` finds the default branch.
      //    Refs themselves resolve through fork_snapshot until the fork pushes.
      const targetStorageSuffix = ns ? `${ns}/${targetSlug}` : targetSlug;
      const targetStorage = new GitR2Storage(bucket, orgId, targetStorageSuffix);
      await targetStorage.setHead(`refs/heads/${defaultBranch}`);
    } catch (forkError) {
      // Rollback: drop the repo row (cascades downstream FKs) + snapshot.
      await db.delete(forkSnapshot).where(eq(forkSnapshot.repoId, repoId)).catch(() => {});
      await db.delete(repo).where(eq(repo.id, repoId)).catch(() => {});
      throw forkError;
    }

    // 5. Audit + usage. Storage_bytes events deliberately NOT emitted on fork —
    //    that's the dedup-billing win. Storage is counted only for blobs the
    //    fork itself writes after creation.
    recordUsage(c.executionCtx, c.env, db, orgId, c.get("dodoCustomerId"), "repo_created", 1, {
      repo_id: repoId, forked_from: source.id, fork_mode: forkMode,
    });

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
        fork_mode: forkMode,
        fork_depth: forkDepth,
        blob_materialization: materializationMode,
        materialized_count: materializedCount,
      },
      requestId: c.get("requestId"),
    });

    // Webhook deliveries (waitUntil-backed). Emit BOTH repo.created (back-compat
    // for subscribers that don't know about the fork event) AND repo.forked
    // (richer payload for clients tracking parallel agent swarms).
    const webhookData = {
      repo_id: repoId,
      slug: targetSlug,
      namespace: ns,
      fork_mode: forkMode,
      fork_depth: forkDepth,
      forked_from: { repo_id: source.id, org_id: source.orgId, slug: source.slug },
    };
    deliverWebhooks(c.executionCtx, db, orgId, "repo.created", webhookData, c.env.WEBHOOK_ENCRYPTION_KEY);
    deliverWebhooks(c.executionCtx, db, orgId, "repo.forked", webhookData, c.env.WEBHOOK_ENCRYPTION_KEY);

    const orgSlug = await getOrgSlug(db, orgId);

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
        fork_mode: forkMode,
        fork_depth: forkDepth,
        fork_root: newRepo.forkRoot,
        blob_materialization: materializationMode,
        shared_blobs: materializedCount,
        owned_blobs: 0,
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
