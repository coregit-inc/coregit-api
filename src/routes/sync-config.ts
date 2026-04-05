/**
 * Sync configuration CRUD and history.
 *
 * POST   /:slug/sync/config        — Create sync config
 * GET    /:slug/sync/config        — Get current sync config (JOIN with connection)
 * PATCH  /:slug/sync/config        — Update direction, auto_sync, branch
 * DELETE /:slug/sync/config        — Delete sync config
 * GET    /:slug/sync/history       — Sync run history with cursor pagination
 *
 * Also supports namespaced variants: /:namespace/:slug/sync/config etc.
 */

import { Hono } from "hono";
import { eq, and, desc, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeyAuth } from "../auth/middleware";
import { isMasterKey } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { repoSync, repoSyncRun, externalConnection } from "../db/schema";
import { decryptSecret } from "../services/secret-manager";
import type { Env, Variables } from "../types";

const syncConfig = new Hono<{ Bindings: Env; Variables: Variables }>();

const GH_API = "https://api.github.com";
const GL_API = "https://gitlab.com/api/v4";

/** Register a webhook on GitHub for push events. Returns webhook ID. */
async function registerGithubWebhook(
  token: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string
): Promise<number> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/hooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "coregit-sync/0.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url: webhookUrl,
        content_type: "json",
        secret,
        insecure_ssl: "0",
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub webhook registration failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}

/** Delete a webhook on GitHub. */
async function deleteGithubWebhook(
  token: string,
  owner: string,
  repo: string,
  hookId: number
): Promise<void> {
  await fetch(`${GH_API}/repos/${owner}/${repo}/hooks/${hookId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "coregit-sync/0.1",
    },
  });
}

/** Register a webhook on GitLab for push events. Returns webhook ID. */
async function registerGitlabWebhook(
  token: string,
  projectPath: string,
  webhookUrl: string,
  secret: string
): Promise<number> {
  const res = await fetch(
    `${GL_API}/projects/${encodeURIComponent(projectPath)}/hooks`,
    {
      method: "POST",
      headers: {
        "Private-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: webhookUrl,
        push_events: true,
        token: secret,
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab webhook registration failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id: number };
  return data.id;
}

/** Delete a webhook on GitLab. */
async function deleteGitlabWebhook(
  token: string,
  projectPath: string,
  hookId: number
): Promise<void> {
  await fetch(
    `${GL_API}/projects/${encodeURIComponent(projectPath)}/hooks/${hookId}`,
    {
      method: "DELETE",
      headers: { "Private-Token": token },
    }
  );
}

/** Compute deterministic webhook secret from encryption key + sync ID. */
async function computeWebhookSecret(encryptionKey: string, syncId: string): Promise<string> {
  const encoder = new TextEncoder();
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

function parseRemote(remote: string, provider: string): { owner: string; repo: string } | null {
  if (provider === "github") {
    const [owner, name] = remote.split("/");
    if (owner && name) return { owner, repo: name };
  }
  return null;
}

// ── Config CRUD ──

const createConfigHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage sync config" }, 403);
  }

  let body: {
    connection_id: string;
    remote: string;
    direction?: string;
    branch?: string;
    auto_sync?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.connection_id || !body.remote) {
    return c.json({ error: "connection_id and remote are required" }, 400);
  }

  const direction = body.direction || "import";
  if (direction !== "import" && direction !== "export") {
    return c.json({ error: "direction must be import or export" }, 400);
  }

  // Resolve repo
  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  // Verify connection exists and belongs to org
  const [conn] = await db
    .select()
    .from(externalConnection)
    .where(and(eq(externalConnection.id, body.connection_id), eq(externalConnection.orgId, orgId)))
    .limit(1);

  if (!conn) return c.json({ error: "Connection not found" }, 404);

  // Check no existing sync config for this repo
  const [existing] = await db
    .select({ id: repoSync.id })
    .from(repoSync)
    .where(eq(repoSync.repoId, resolved.repo.id))
    .limit(1);

  if (existing) {
    return c.json({ error: "Sync config already exists for this repo. Use PATCH to update." }, 409);
  }

  const syncId = nanoid();
  const branch = body.branch || resolved.repo.defaultBranch;

  await db.insert(repoSync).values({
    id: syncId,
    orgId,
    repoId: resolved.repo.id,
    connectionId: body.connection_id,
    provider: conn.provider,
    remote: body.remote,
    defaultBranch: branch,
    direction,
    autoSync: body.auto_sync ?? false,
  });

  // Register webhook if auto_sync + import
  let webhookId: number | null = null;
  if (body.auto_sync && direction === "import") {
    try {
      const token = await decryptSecret(c.env.SYNC_ENCRYPTION_KEY, conn.encryptedAccessToken);
      const secret = await computeWebhookSecret(c.env.SYNC_ENCRYPTION_KEY, syncId);

      if (conn.provider === "github") {
        const parsed = parseRemote(body.remote, "github");
        if (parsed) {
          const webhookUrl = `https://api.coregit.dev/v1/sync-webhooks/github`;
          webhookId = await registerGithubWebhook(token, parsed.owner, parsed.repo, webhookUrl, secret);
        }
      } else if (conn.provider === "gitlab") {
        const webhookUrl = `https://api.coregit.dev/v1/sync-webhooks/gitlab`;
        webhookId = await registerGitlabWebhook(token, body.remote, webhookUrl, secret);
      }
    } catch (err) {
      console.error("Webhook registration failed:", err);
      // Non-fatal — sync config is still created
    }
  }

  if (webhookId) {
    await db.update(repoSync).set({ externalWebhookId: String(webhookId) }).where(eq(repoSync.id, syncId));
  }

  return c.json(
    {
      id: syncId,
      repo_id: resolved.repo.id,
      connection_id: body.connection_id,
      provider: conn.provider,
      remote: body.remote,
      branch,
      direction,
      auto_sync: body.auto_sync ?? false,
      webhook_id: webhookId,
    },
    201
  );
};
syncConfig.post("/:slug/sync/config", apiKeyAuth, createConfigHandler);
syncConfig.post("/:namespace/:slug/sync/config", apiKeyAuth, createConfigHandler);

const getConfigHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  const rows = await db
    .select({
      syncId: repoSync.id,
      connectionId: repoSync.connectionId,
      provider: repoSync.provider,
      remote: repoSync.remote,
      defaultBranch: repoSync.defaultBranch,
      direction: repoSync.direction,
      autoSync: repoSync.autoSync,
      lastSyncedSha: repoSync.lastSyncedSha,
      lastSyncedAt: repoSync.lastSyncedAt,
      lastError: repoSync.lastError,
      connLabel: externalConnection.label,
      connUsername: externalConnection.externalUsername,
    })
    .from(repoSync)
    .innerJoin(externalConnection, eq(repoSync.connectionId, externalConnection.id))
    .where(eq(repoSync.repoId, resolved.repo.id))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ config: null });
  }

  const r = rows[0];
  return c.json({
    config: {
      id: r.syncId,
      connection_id: r.connectionId,
      provider: r.provider,
      remote: r.remote,
      branch: r.defaultBranch,
      direction: r.direction,
      auto_sync: r.autoSync,
      last_synced_sha: r.lastSyncedSha,
      last_synced_at: r.lastSyncedAt?.toISOString() ?? null,
      last_error: r.lastError,
      connection: {
        label: r.connLabel,
        external_username: r.connUsername,
      },
    },
  });
};
syncConfig.get("/:slug/sync/config", apiKeyAuth, getConfigHandler);
syncConfig.get("/:namespace/:slug/sync/config", apiKeyAuth, getConfigHandler);

const patchConfigHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage sync config" }, 403);
  }

  let body: {
    direction?: string;
    auto_sync?: boolean;
    branch?: string;
    remote?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.direction && body.direction !== "import" && body.direction !== "export") {
    return c.json({ error: "direction must be import or export" }, 400);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  const [existing] = await db
    .select()
    .from(repoSync)
    .where(and(eq(repoSync.repoId, resolved.repo.id), eq(repoSync.orgId, orgId)))
    .limit(1);

  if (!existing) return c.json({ error: "Sync config not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.direction !== undefined) updates.direction = body.direction;
  if (body.auto_sync !== undefined) updates.autoSync = body.auto_sync;
  if (body.branch !== undefined) updates.defaultBranch = body.branch;
  if (body.remote !== undefined) updates.remote = body.remote;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  await db
    .update(repoSync)
    .set(updates)
    .where(eq(repoSync.id, existing.id));

  // Handle webhook lifecycle on direction/autoSync change
  const newDirection = body.direction ?? existing.direction;
  const newAutoSync = body.auto_sync ?? existing.autoSync;
  const remote = body.remote ?? existing.remote;
  const needsWebhook = newAutoSync && newDirection === "import";
  const remoteChanged = body.remote !== undefined && body.remote !== existing.remote;

  try {
    const [conn] = await db
      .select()
      .from(externalConnection)
      .where(eq(externalConnection.id, existing.connectionId))
      .limit(1);

    if (conn) {
      const token = await decryptSecret(c.env.SYNC_ENCRYPTION_KEY, conn.encryptedAccessToken);

      // Delete old webhook if no longer needed or remote changed
      if (existing.externalWebhookId && (!needsWebhook || remoteChanged)) {
        const hookId = parseInt(existing.externalWebhookId, 10);
        if (conn.provider === "github") {
          const parsed = parseRemote(existing.remote, "github");
          if (parsed) await deleteGithubWebhook(token, parsed.owner, parsed.repo, hookId);
        } else if (conn.provider === "gitlab") {
          await deleteGitlabWebhook(token, existing.remote, hookId);
        }
        await db.update(repoSync).set({ externalWebhookId: null }).where(eq(repoSync.id, existing.id));
      }

      // Register new webhook if needed and doesn't already exist (or remote changed)
      if (needsWebhook && (!existing.externalWebhookId || remoteChanged)) {
        const secret = await computeWebhookSecret(c.env.SYNC_ENCRYPTION_KEY, existing.id);
        let newWebhookId: number | null = null;

        if (conn.provider === "github") {
          const parsed = parseRemote(remote, "github");
          if (parsed) {
            const webhookUrl = `https://api.coregit.dev/v1/sync-webhooks/github`;
            newWebhookId = await registerGithubWebhook(token, parsed.owner, parsed.repo, webhookUrl, secret);
          }
        } else if (conn.provider === "gitlab") {
          const webhookUrl = `https://api.coregit.dev/v1/sync-webhooks/gitlab`;
          newWebhookId = await registerGitlabWebhook(token, remote, webhookUrl, secret);
        }

        if (newWebhookId) {
          await db.update(repoSync).set({ externalWebhookId: String(newWebhookId) }).where(eq(repoSync.id, existing.id));
        }
      }
    }
  } catch (err) {
    console.error("Webhook lifecycle update failed:", err);
  }

  return c.json({ updated: true });
};
syncConfig.patch("/:slug/sync/config", apiKeyAuth, patchConfigHandler);
syncConfig.patch("/:namespace/:slug/sync/config", apiKeyAuth, patchConfigHandler);

const deleteConfigHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage sync config" }, 403);
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  // Try to clean up webhooks before deleting
  const [existing] = await db
    .select()
    .from(repoSync)
    .where(and(eq(repoSync.repoId, resolved.repo.id), eq(repoSync.orgId, orgId)))
    .limit(1);

  if (!existing) return c.json({ error: "Sync config not found" }, 404);

  // Clean up external webhook before deleting
  if (existing.externalWebhookId) {
    try {
      const [conn] = await db
        .select()
        .from(externalConnection)
        .where(eq(externalConnection.id, existing.connectionId))
        .limit(1);
      if (conn) {
        const token = await decryptSecret(c.env.SYNC_ENCRYPTION_KEY, conn.encryptedAccessToken);
        const hookId = parseInt(existing.externalWebhookId, 10);
        if (conn.provider === "github") {
          const parsed = parseRemote(existing.remote, "github");
          if (parsed) {
            await deleteGithubWebhook(token, parsed.owner, parsed.repo, hookId);
          }
        } else if (conn.provider === "gitlab") {
          await deleteGitlabWebhook(token, existing.remote, hookId);
        }
      }
    } catch (err) {
      console.error("Webhook cleanup failed:", err);
      // Non-fatal — still delete the config
    }
  }

  // Delete cascade will handle repoSyncRun records
  await db.delete(repoSync).where(eq(repoSync.id, existing.id));

  return c.json({ deleted: true });
};
syncConfig.delete("/:slug/sync/config", apiKeyAuth, deleteConfigHandler);
syncConfig.delete("/:namespace/:slug/sync/config", apiKeyAuth, deleteConfigHandler);

// ── Sync History ──

const historyHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  const [syncCfg] = await db
    .select({ id: repoSync.id })
    .from(repoSync)
    .where(eq(repoSync.repoId, resolved.repo.id))
    .limit(1);

  if (!syncCfg) return c.json({ runs: [] });

  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const cursor = c.req.query("cursor") || null;

  const whereClause = cursor
    ? and(eq(repoSyncRun.syncId, syncCfg.id), lt(repoSyncRun.startedAt, new Date(cursor)))
    : eq(repoSyncRun.syncId, syncCfg.id);

  const rows = await db
    .select()
    .from(repoSyncRun)
    .where(whereClause)
    .orderBy(desc(repoSyncRun.startedAt))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items: typeof rows = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    runs: items.map((r: typeof rows[number]) => ({
      id: r.id,
      status: r.status,
      message: r.message,
      remote_sha: r.remoteSha,
      commit_sha: r.commitSha,
      started_at: r.startedAt.toISOString(),
      completed_at: r.completedAt?.toISOString() ?? null,
    })),
    next_cursor: hasMore ? items[items.length - 1].startedAt.toISOString() : null,
  });
};
syncConfig.get("/:slug/sync/history", apiKeyAuth, historyHandler);
syncConfig.get("/:namespace/:slug/sync/history", apiKeyAuth, historyHandler);

export { syncConfig };
