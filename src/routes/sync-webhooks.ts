/**
 * Incoming webhook handlers for GitHub and GitLab push events.
 *
 * Public endpoints — no API key auth. Verification via:
 *   - GitHub: X-Hub-Signature-256 (HMAC-SHA256)
 *   - GitLab: X-Gitlab-Token (secret comparison)
 *
 * POST /v1/sync-webhooks/github
 * POST /v1/sync-webhooks/gitlab
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createDb } from "../db";
import { repoSync, repoSyncRun, externalConnection, repo } from "../db/schema";
import { decryptSecret } from "../services/secret-manager";
import { syncFromGithub } from "../services/github-sync";
import { syncFromGitlab } from "../services/gitlab-sync";
import { GitR2Storage } from "../git/storage";
import type { CommitAuthor } from "../services/commit-builder";
import { checkIpRateLimit, ipRateLimitHeaders } from "../services/rate-limit";
import type { Env, Variables } from "../types";

const syncWebhooks = new Hono<{ Bindings: Env; Variables: Variables }>();

const encoder = new TextEncoder();

/** Compute deterministic webhook secret from encryption key + sync ID. */
async function computeWebhookSecret(encryptionKey: string, syncId: string): Promise<string> {
  const keyData = encoder.encode(encryptionKey);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(syncId));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify GitHub HMAC-SHA256 signature (timing-safe). */
async function verifyGithubSignature(
  secret: string,
  body: string,
  signature: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(expected, signature);
}

/** Timing-safe string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < aa.length; i++) {
    result |= aa[i] ^ bb[i];
  }
  return result === 0;
}

/** Run import sync for a given sync config. */
async function runImportSync(
  db: ReturnType<typeof createDb>,
  bucket: R2Bucket,
  syncRecord: typeof repoSync.$inferSelect,
  connection: typeof externalConnection.$inferSelect,
  encryptionKey: string
): Promise<void> {
  const [repoRecord] = await db
    .select()
    .from(repo)
    .where(eq(repo.id, syncRecord.repoId))
    .limit(1);

  if (!repoRecord) return;

  const storageSuffix = repoRecord.namespace
    ? `${repoRecord.namespace}/${repoRecord.slug}`
    : repoRecord.slug;
  const storage = new GitR2Storage(bucket, repoRecord.orgId, storageSuffix);
  const token = await decryptSecret(encryptionKey, connection.encryptedAccessToken);
  const branch = syncRecord.defaultBranch || repoRecord.defaultBranch;
  const author: CommitAuthor = { name: "CoreGit Sync", email: "sync@coregit.dev" };

  const runId = nanoid();
  await db.insert(repoSyncRun).values({
    id: runId,
    syncId: syncRecord.id,
    status: "running",
    startedAt: new Date(),
    message: `Webhook-triggered sync from ${syncRecord.provider}`,
  });

  try {
    let result;
    if (syncRecord.provider === "github") {
      const [owner, ghRepo] = syncRecord.remote.split("/");
      if (!owner || !ghRepo) throw new Error("Invalid remote format");
      result = await syncFromGithub({
        token,
        owner,
        repo: ghRepo,
        branch,
        storage,
        author,
        lastSyncedSha: syncRecord.lastSyncedSha ?? null,
      });
    } else if (syncRecord.provider === "gitlab") {
      result = await syncFromGitlab({
        token,
        projectPath: syncRecord.remote,
        branch,
        storage,
        author,
        lastSyncedSha: syncRecord.lastSyncedSha ?? null,
      });
    } else {
      throw new Error(`Unsupported provider: ${syncRecord.provider}`);
    }

    await db
      .update(repoSync)
      .set({
        lastSyncedSha: result.remoteSha,
        lastSyncedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(repoSync.id, syncRecord.id));

    await db
      .update(repoSyncRun)
      .set({
        status: result.skipped ? "skipped" : "success",
        commitSha: result.commitSha || null,
        remoteSha: result.remoteSha,
        completedAt: new Date(),
        message: result.skipped ? "Already up to date" : `Applied ${result.filesChanged} files`,
      })
      .where(eq(repoSyncRun.id, runId));
  } catch (error) {
    console.error("Webhook sync failed:", error);
    await db
      .update(repoSyncRun)
      .set({
        status: "error",
        completedAt: new Date(),
        message: error instanceof Error ? error.message : "Sync failed",
      })
      .where(eq(repoSyncRun.id, runId));

    await db
      .update(repoSync)
      .set({ lastError: error instanceof Error ? error.message : "Sync failed" })
      .where(eq(repoSync.id, syncRecord.id));
  }
}


// POST /v1/sync-webhooks/github
syncWebhooks.post("/sync-webhooks/github", async (c) => {
  try {
    // IP rate limiting
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const ipRl = await checkIpRateLimit(c.env.RATE_LIMITER, ip);
    if (!ipRl.allowed) {
      const headers = ipRateLimitHeaders(ipRl);
      return c.json({ error: "Rate limit exceeded" }, 429, headers);
    }

    const event = c.req.header("X-GitHub-Event");
    if (event !== "push") {
      return c.json({ ignored: true, reason: "not a push event" });
    }

    const signature = c.req.header("X-Hub-Signature-256");
    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const rawBody = await c.req.text();
    let payload: { repository?: { full_name?: string }; ref?: string };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const fullName = payload.repository?.full_name;
    if (!fullName) {
      return c.json({ error: "Missing repository.full_name" }, 400);
    }

    // Find matching sync configs — DB already set by /v1/* middleware
    const db = c.get("db") || createDb(c.env.HYPERDRIVE?.connectionString || c.env.DATABASE_URL);

    const syncConfigs = await db
      .select()
      .from(repoSync)
      .where(
        and(
          eq(repoSync.remote, fullName),
          eq(repoSync.provider, "github"),
          eq(repoSync.direction, "import"),
          eq(repoSync.autoSync, true)
        )
      );

  if (syncConfigs.length === 0) {
    return c.json({ ignored: true, reason: "no matching sync config" });
  }

  // Verify signature against each matching sync config
  let matched = false;
  for (const cfg of syncConfigs) {
    const expectedSecret = await computeWebhookSecret(c.env.SYNC_ENCRYPTION_KEY, cfg.id);
    const valid = await verifyGithubSignature(expectedSecret, rawBody, signature);
    if (valid) {
      matched = true;

      // Fetch connection
      const [conn] = await db
        .select()
        .from(externalConnection)
        .where(eq(externalConnection.id, cfg.connectionId))
        .limit(1);

      if (conn) {
        c.executionCtx.waitUntil(
          runImportSync(db, c.env.REPOS_BUCKET, cfg, conn, c.env.SYNC_ENCRYPTION_KEY)
        );
      }
      break;
    }
  }

  if (!matched) {
    return c.json({ error: "Signature verification failed" }, 401);
  }

  return c.json({ accepted: true });
  } catch (err) {
    console.error("GitHub webhook handler error:", err);
    return c.json({ error: err instanceof Error ? err.message : "Webhook processing failed" }, 500);
  }
});

// POST /v1/sync-webhooks/gitlab
syncWebhooks.post("/sync-webhooks/gitlab", async (c) => {
  try {
    // IP rate limiting
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const ipRl = await checkIpRateLimit(c.env.RATE_LIMITER, ip);
    if (!ipRl.allowed) {
      const headers = ipRateLimitHeaders(ipRl);
      return c.json({ error: "Rate limit exceeded" }, 429, headers);
    }

    const gitlabEvent = c.req.header("X-Gitlab-Event");
    if (gitlabEvent !== "Push Hook") {
      return c.json({ ignored: true, reason: "not a push event" });
    }

    const gitlabToken = c.req.header("X-Gitlab-Token");
    if (!gitlabToken) {
      return c.json({ error: "Missing X-Gitlab-Token" }, 401);
    }

    let payload: { project?: { path_with_namespace?: string }; ref?: string };
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const projectPath = payload.project?.path_with_namespace;
    if (!projectPath) {
      return c.json({ error: "Missing project.path_with_namespace" }, 400);
    }

    const db = c.get("db") || createDb(c.env.HYPERDRIVE?.connectionString || c.env.DATABASE_URL);

    const syncConfigs = await db
      .select()
      .from(repoSync)
      .where(
        and(
          eq(repoSync.remote, projectPath),
          eq(repoSync.provider, "gitlab"),
          eq(repoSync.direction, "import"),
          eq(repoSync.autoSync, true)
        )
      );

    if (syncConfigs.length === 0) {
      return c.json({ ignored: true, reason: "no matching sync config" });
    }

    // Verify token against each matching sync config
    let matched = false;
    for (const cfg of syncConfigs) {
      const expectedSecret = await computeWebhookSecret(c.env.SYNC_ENCRYPTION_KEY, cfg.id);
      if (timingSafeEqual(gitlabToken, expectedSecret)) {
        matched = true;

        const [conn] = await db
          .select()
          .from(externalConnection)
          .where(eq(externalConnection.id, cfg.connectionId))
          .limit(1);

        if (conn) {
          c.executionCtx.waitUntil(
            runImportSync(db, c.env.REPOS_BUCKET, cfg, conn, c.env.SYNC_ENCRYPTION_KEY)
          );
        }
        break;
      }
    }

    if (!matched) {
      return c.json({ error: "Token verification failed" }, 401);
    }

    return c.json({ accepted: true });
  } catch (err) {
    console.error("GitLab webhook handler error:", err);
    return c.json({ error: err instanceof Error ? err.message : "Webhook processing failed" }, 500);
  }
});

export { syncWebhooks };
