/**
 * Git LFS Batch API + Verify callback.
 *
 * POST /:org/:repo.git/info/lfs/objects/batch   — Batch upload/download
 * POST /:org/:repo.git/info/lfs/verify          — Confirm upload
 *
 * Also supports namespaced: /:org/:namespace/:repo.git/info/lfs/...
 *
 * Auth: Basic auth (same as git push/pull).
 * Content-Type: application/vnd.git-lfs+json
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { repo, organization, lfsObject } from "../db/schema";
import { parseBasicAuthKey, verifyCredentialForGit } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { presignUpload, presignDownload, buildLfsKey } from "../services/lfs-presign";
import { recordUsage } from "../services/usage";
import { checkFreeLimits } from "../services/limits";
import {
  checkRateLimit,
  rateLimitHeaders,
  checkOrgRateLimit,
  orgRateLimitHeaders,
  checkIpRateLimit,
  ipRateLimitHeaders,
} from "../services/rate-limit";
import type { Env, Variables } from "../types";

const lfs = new Hono<{ Bindings: Env; Variables: Variables }>();

const LFS_JSON = "application/vnd.git-lfs+json";

// Max file sizes per tier
const MAX_FILE_SIZE: Record<string, number> = {
  free: 100 * 1024 * 1024,    // 100 MB
  usage: 2 * 1024 * 1024 * 1024, // 2 GB
};
const MAX_BATCH_OBJECTS: Record<string, number> = {
  free: 20,
  usage: 100,
};

interface LfsBatchObject {
  oid: string;
  size: number;
}

interface LfsAuthResult {
  orgId: string;
  repoId: string;
  repoSlug: string;
  tier: "free" | "usage";
  dodoCustomerId: string | null;
  /** Token ID for rate limiting (null for unauthenticated public download) */
  tokenId: string | null;
}

function extractLfsRepoParams(c: any): { orgParam: string; repoSlug: string; namespace: string | null } {
  const orgParam = c.req.param("org") || "";
  const namespace = c.req.param("namespace") ?? null;
  let repoSlug = c.req.param("repo") || "";
  if (repoSlug.endsWith(".git")) repoSlug = repoSlug.slice(0, -4);
  return { orgParam, repoSlug, namespace };
}

/** Auth for LFS write operations (upload, verify). */
async function authLfsWrite(c: any): Promise<LfsAuthResult | Response> {
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { orgParam, repoSlug, namespace } = extractLfsRepoParams(c);
  if (!orgParam || !repoSlug) return lfsError(c, 400, "Invalid path");

  const credentialValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (!credentialValue) return lfsError(c, 401, "Credentials required");

  const authResult = await verifyCredentialForGit(db, credentialValue);
  if (!authResult) return lfsError(c, 401, "Invalid credentials");

  const resolved = await resolveRepo(db, bucket, { orgId: authResult.orgId, slug: repoSlug, namespace });
  if (!resolved) return lfsError(c, 404, "Repository not found");

  if (!hasRepoAccess(authResult.scopes, resolved.scopeKey, "write")) {
    return lfsError(c, 403, "Insufficient permissions");
  }

  const { getOrgPlan } = await import("../services/limits");
  const plan = await getOrgPlan(db, authResult.orgId);

  return {
    orgId: authResult.orgId,
    repoId: resolved.repo.id,
    repoSlug,
    tier: plan.tier,
    dodoCustomerId: plan.dodoCustomerId,
    tokenId: authResult.tokenId,
  };
}

/** Auth for LFS read operations (download). Allows public repos without auth. */
async function authLfsRead(c: any): Promise<LfsAuthResult | Response> {
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { orgParam, repoSlug, namespace } = extractLfsRepoParams(c);
  if (!orgParam || !repoSlug) return lfsError(c, 400, "Invalid path");

  // Try credential auth
  const credentialValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (credentialValue) {
    const authResult = await verifyCredentialForGit(db, credentialValue);
    if (authResult) {
      const resolved = await resolveRepo(db, bucket, { orgId: authResult.orgId, slug: repoSlug, namespace });
      if (!resolved) return lfsError(c, 404, "Repository not found");

      if (!hasRepoAccess(authResult.scopes, resolved.scopeKey, "read")) {
        return lfsError(c, 403, "Insufficient permissions");
      }

      const { getOrgPlan } = await import("../services/limits");
      const plan = await getOrgPlan(db, authResult.orgId);

      return {
        orgId: authResult.orgId,
        repoId: resolved.repo.id,
        repoSlug,
        tier: plan.tier,
        dodoCustomerId: plan.dodoCustomerId,
        tokenId: authResult.tokenId,
      };
    }
  }

  // No auth — check for public repo
  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, orgParam))
    .limit(1);

  if (!org) return lfsError(c, 401, "Credentials required");

  const resolved = await resolveRepo(db, bucket, { orgId: org.id, slug: repoSlug, namespace });
  if (!resolved || resolved.repo.visibility !== "public") {
    return lfsError(c, 401, "Credentials required");
  }

  const { getOrgPlan } = await import("../services/limits");
  const plan = await getOrgPlan(db, org.id);

  return {
    orgId: org.id,
    repoId: resolved.repo.id,
    repoSlug,
    tier: plan.tier,
    dodoCustomerId: plan.dodoCustomerId,
    tokenId: null,
  };
}

function lfsError(c: any, status: number, message: string) {
  return c.json({ message }, status, {
    "Content-Type": LFS_JSON,
  });
}

// ── Batch API ──

async function batchHandler(c: any) {
  const db = c.get("db");

  let body: {
    operation: "upload" | "download";
    transfers?: string[];
    objects: LfsBatchObject[];
    ref?: { name: string };
  };
  try {
    body = await c.req.json();
  } catch {
    return lfsError(c, 400, "Invalid JSON body");
  }

  if (!body.operation || !body.objects || !Array.isArray(body.objects)) {
    return lfsError(c, 400, "operation and objects are required");
  }

  const isUpload = body.operation === "upload";

  // Auth: write for upload, read for download
  const auth = isUpload ? await authLfsWrite(c) : await authLfsRead(c);
  if (auth instanceof Response) return auth;

  // Rate limiting (via Durable Object)
  const rateLimiter = c.env.RATE_LIMITER as DurableObjectNamespace;
  if (auth.tokenId) {
    const rl = await checkRateLimit(rateLimiter, auth.tokenId);
    if (!rl.allowed) return lfsError(c, 429, "Rate limit exceeded");
    const orgRl = await checkOrgRateLimit(rateLimiter, auth.orgId);
    if (!orgRl.allowed) return lfsError(c, 429, "Organization rate limit exceeded");
  } else {
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const ipRl = await checkIpRateLimit(rateLimiter, ip);
    if (!ipRl.allowed) return lfsError(c, 429, "Rate limit exceeded");
  }

  const tier = auth.tier;
  const maxFileSize = MAX_FILE_SIZE[tier] ?? MAX_FILE_SIZE.free;
  const maxBatch = MAX_BATCH_OBJECTS[tier] ?? MAX_BATCH_OBJECTS.free;

  if (body.objects.length > maxBatch) {
    return lfsError(c, 422, `Too many objects. Max ${maxBatch} per batch request.`);
  }

  // Validate presign credentials exist
  if (!c.env.R2_ACCESS_KEY_ID || !c.env.R2_SECRET_ACCESS_KEY || !c.env.R2_ACCOUNT_ID) {
    return lfsError(c, 500, "LFS storage not configured");
  }

  const lfsBucket: R2Bucket = c.env.LFS_BUCKET;
  const responseObjects: any[] = [];

  for (const obj of body.objects) {
    if (!obj.oid || typeof obj.oid !== "string" || !/^[0-9a-f]{64}$/.test(obj.oid)) {
      responseObjects.push({
        oid: obj.oid,
        size: obj.size,
        error: { code: 422, message: "Invalid oid. Must be 64-char lowercase hex (SHA-256)." },
      });
      continue;
    }

    if (typeof obj.size !== "number" || obj.size < 0) {
      responseObjects.push({
        oid: obj.oid,
        size: obj.size,
        error: { code: 422, message: "Invalid size" },
      });
      continue;
    }

    if (isUpload && obj.size > maxFileSize) {
      responseObjects.push({
        oid: obj.oid,
        size: obj.size,
        error: { code: 422, message: `File too large. Max ${maxFileSize / (1024 * 1024)} MB for ${tier} tier.` },
      });
      continue;
    }

    const key = buildLfsKey(auth.orgId, auth.repoId, obj.oid);

    if (isUpload) {
      // Check if already exists
      const head = await lfsBucket.head(key);
      if (head) {
        // Already uploaded — no actions needed
        responseObjects.push({ oid: obj.oid, size: obj.size });
        continue;
      }

      // Check storage quota for free tier
      if (tier === "free") {
        const storageLimit = await checkFreeLimits(db, auth.orgId, tier, "storage_bytes" as any);
        if (storageLimit && !storageLimit.allowed) {
          responseObjects.push({
            oid: obj.oid,
            size: obj.size,
            error: { code: 507, message: "Storage quota exceeded. Upgrade to Usage plan." },
          });
          continue;
        }
      }

      const upload = await presignUpload(c.env as any, auth.orgId, auth.repoId, obj.oid);

      // Build verify URL
      const { orgParam } = extractLfsRepoParams(c);
      const namespacePart = c.req.param("namespace") ? `/${c.req.param("namespace")}` : "";
      const repoParam = c.req.param("repo") || "";
      const verifyHref = `https://api.coregit.dev/${orgParam}${namespacePart}/${repoParam}/info/lfs/verify`;

      responseObjects.push({
        oid: obj.oid,
        size: obj.size,
        actions: {
          upload: {
            href: upload.href,
            header: { "Content-Type": "application/octet-stream" },
            expires_in: upload.expires_in,
          },
          verify: {
            href: verifyHref,
            header: { Authorization: c.req.header("Authorization") || "" },
            expires_in: upload.expires_in,
          },
        },
      });
    } else {
      // Download
      const head = await lfsBucket.head(key);
      if (!head) {
        responseObjects.push({
          oid: obj.oid,
          size: obj.size,
          error: { code: 404, message: "Object not found" },
        });
        continue;
      }

      const download = await presignDownload(c.env as any, auth.orgId, auth.repoId, obj.oid);

      responseObjects.push({
        oid: obj.oid,
        size: obj.size,
        actions: {
          download: {
            href: download.href,
            expires_in: download.expires_in,
          },
        },
      });
    }
  }

  // Track usage (non-blocking)
  if (body.operation === "download") {
    const totalSize = body.objects.reduce((sum, o) => sum + (o.size || 0), 0);
    if (totalSize > 0) {
      recordUsage(c.executionCtx, db, auth.orgId, "git_transfer_bytes", totalSize, {
        type: "lfs_download",
        repo: auth.repoSlug,
        objects: body.objects.length,
      }, c.env.DODO_PAYMENTS_API_KEY, auth.dodoCustomerId);
    }
  }

  return c.json(
    { transfer: "basic", objects: responseObjects, hash_algo: "sha256" },
    200,
    { "Content-Type": LFS_JSON }
  );
}

// Register batch routes
lfs.post("/:org/:repo/info/lfs/objects/batch", batchHandler);
lfs.post("/:org/:namespace/:repo/info/lfs/objects/batch", batchHandler);

// ��─ Verify Callback ──

async function verifyHandler(c: any) {
  const db = c.get("db");
  const auth = await authLfsWrite(c);
  if (auth instanceof Response) return auth;

  // Rate limiting (verify is always authenticated, via Durable Object)
  const rateLimiterVerify = c.env.RATE_LIMITER as DurableObjectNamespace;
  if (auth.tokenId) {
    const rl = await checkRateLimit(rateLimiterVerify, auth.tokenId);
    if (!rl.allowed) return lfsError(c, 429, "Rate limit exceeded");
    const orgRl = await checkOrgRateLimit(rateLimiterVerify, auth.orgId);
    if (!orgRl.allowed) return lfsError(c, 429, "Organization rate limit exceeded");
  }

  let body: { oid: string; size: number };
  try {
    body = await c.req.json();
  } catch {
    return lfsError(c, 400, "Invalid JSON body");
  }

  if (!body.oid || !/^[0-9a-f]{64}$/.test(body.oid)) {
    return lfsError(c, 422, "Invalid oid");
  }

  const lfsBucket: R2Bucket = c.env.LFS_BUCKET;
  const key = buildLfsKey(auth.orgId, auth.repoId, body.oid);

  // Verify object exists in R2
  const head = await lfsBucket.head(key);
  if (!head) {
    return lfsError(c, 404, "Object not uploaded");
  }

  // Verify size matches
  if (head.size !== body.size) {
    return lfsError(c, 422, `Size mismatch. Expected ${body.size}, got ${head.size}`);
  }

  // Record in database (upsert — idempotent)
  await db
    .insert(lfsObject)
    .values({
      id: nanoid(),
      orgId: auth.orgId,
      repoId: auth.repoId,
      oid: body.oid,
      size: body.size,
    })
    .onConflictDoNothing();

  // Track storage + transfer usage (non-blocking)
  recordUsage(c.executionCtx, db, auth.orgId, "storage_bytes", body.size, {
    type: "lfs_upload",
    repo: auth.repoSlug,
    oid: body.oid,
  }, c.env.DODO_PAYMENTS_API_KEY, auth.dodoCustomerId);

  recordUsage(c.executionCtx, db, auth.orgId, "git_transfer_bytes", body.size, {
    type: "lfs_upload",
    repo: auth.repoSlug,
    oid: body.oid,
  }, c.env.DODO_PAYMENTS_API_KEY, auth.dodoCustomerId);

  return c.body(null, 200, { "Content-Type": LFS_JSON });
}

lfs.post("/:org/:repo/info/lfs/verify", verifyHandler);
lfs.post("/:org/:namespace/:repo/info/lfs/verify", verifyHandler);

export { lfs };
