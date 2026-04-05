/**
 * External connection CRUD (GitHub / GitLab).
 *
 * POST   /v1/connections       — Create connection
 * GET    /v1/connections       — List connections (tokens redacted)
 * PATCH  /v1/connections/:id   — Update label or rotate token
 * DELETE /v1/connections/:id   — Delete (cascades to repoSync via FK)
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeyAuth } from "../auth/middleware";
import { isMasterKey } from "../auth/scopes";
import { externalConnection } from "../db/schema";
import { encryptSecret, decryptSecret } from "../services/secret-manager";
import type { Env, Variables } from "../types";

const connections = new Hono<{ Bindings: Env; Variables: Variables }>();

const GH_API = "https://api.github.com";
const GL_API = "https://gitlab.com/api/v4";

/** Validate a GitHub token by fetching the authenticated user. */
async function validateGithubToken(token: string): Promise<string> {
  const res = await fetch(`${GH_API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "coregit-sync/0.1",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub token validation failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { login: string };
  return data.login;
}

/** Validate a GitLab token by fetching the authenticated user. */
async function validateGitlabToken(token: string): Promise<string> {
  const res = await fetch(`${GL_API}/user`, {
    headers: { "Private-Token": token },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab token validation failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { username: string };
  return data.username;
}

// POST /v1/connections
connections.post("/connections", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");

  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage connections" }, 403);
  }

  let body: { provider: string; label: string; access_token: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.provider || !body.label || !body.access_token) {
    return c.json({ error: "provider, label, and access_token are required" }, 400);
  }

  if (body.provider !== "github" && body.provider !== "gitlab") {
    return c.json({ error: "provider must be github or gitlab" }, 400);
  }

  // Validate token with provider API
  let externalUsername: string;
  try {
    externalUsername =
      body.provider === "github"
        ? await validateGithubToken(body.access_token)
        : await validateGitlabToken(body.access_token);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Token validation failed" },
      400
    );
  }

  const encrypted = await encryptSecret(c.env.SYNC_ENCRYPTION_KEY, body.access_token);
  const id = nanoid();

  await db.insert(externalConnection).values({
    id,
    orgId,
    provider: body.provider,
    label: body.label,
    externalUsername,
    encryptedAccessToken: encrypted,
  });

  return c.json(
    {
      id,
      provider: body.provider,
      label: body.label,
      external_username: externalUsername,
      created_at: new Date().toISOString(),
    },
    201
  );
});

// GET /v1/connections
connections.get("/connections", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");

  const rows = await db
    .select({
      id: externalConnection.id,
      provider: externalConnection.provider,
      label: externalConnection.label,
      externalUsername: externalConnection.externalUsername,
      lastSyncedAt: externalConnection.lastSyncedAt,
      createdAt: externalConnection.createdAt,
      updatedAt: externalConnection.updatedAt,
    })
    .from(externalConnection)
    .where(eq(externalConnection.orgId, orgId))
    .orderBy(externalConnection.createdAt);

  return c.json({
    connections: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: r.label,
      external_username: r.externalUsername,
      last_synced_at: r.lastSyncedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    })),
  });
});

// PATCH /v1/connections/:id
connections.patch("/connections/:id", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const connId = c.req.param("id");

  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage connections" }, 403);
  }

  let body: { label?: string; access_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const [existing] = await db
    .select()
    .from(externalConnection)
    .where(and(eq(externalConnection.id, connId), eq(externalConnection.orgId, orgId)))
    .limit(1);

  if (!existing) {
    return c.json({ error: "Connection not found" }, 404);
  }

  const updates: Record<string, unknown> = {};

  if (body.label) {
    updates.label = body.label;
  }

  if (body.access_token) {
    // Validate new token
    let externalUsername: string;
    try {
      externalUsername =
        existing.provider === "github"
          ? await validateGithubToken(body.access_token)
          : await validateGitlabToken(body.access_token);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Token validation failed" },
        400
      );
    }
    updates.encryptedAccessToken = await encryptSecret(
      c.env.SYNC_ENCRYPTION_KEY,
      body.access_token
    );
    updates.externalUsername = externalUsername;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  await db
    .update(externalConnection)
    .set(updates)
    .where(eq(externalConnection.id, connId));

  return c.json({ updated: true });
});

// POST /v1/connections/:id/test
connections.post("/connections/:id/test", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const connId = c.req.param("id");

  const [conn] = await db
    .select()
    .from(externalConnection)
    .where(and(eq(externalConnection.id, connId), eq(externalConnection.orgId, orgId)))
    .limit(1);

  if (!conn) {
    return c.json({ error: "Connection not found" }, 404);
  }

  try {
    const token = await decryptSecret(c.env.SYNC_ENCRYPTION_KEY, conn.encryptedAccessToken);
    const username =
      conn.provider === "github"
        ? await validateGithubToken(token)
        : await validateGitlabToken(token);
    return c.json({ valid: true, username });
  } catch (err) {
    return c.json({
      valid: false,
      error: err instanceof Error ? err.message : "Token validation failed",
    });
  }
});

// DELETE /v1/connections/:id
connections.delete("/connections/:id", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const connId = c.req.param("id");

  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage connections" }, 403);
  }

  await db
    .delete(externalConnection)
    .where(and(eq(externalConnection.id, connId), eq(externalConnection.orgId, orgId)));

  return c.json({ deleted: true });
});

export { connections };
