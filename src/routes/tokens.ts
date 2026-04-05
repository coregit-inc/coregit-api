/**
 * Scoped token management endpoints
 *
 * POST   /v1/tokens          — Create scoped token (master key only)
 * GET    /v1/tokens          — List active tokens (master key only)
 * DELETE /v1/tokens/:id      — Revoke token (master key only)
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { isMasterKey, validateScopes, normalizeScopes } from "../auth/scopes";
import { recordUsage } from "../services/usage";
import { recordAudit } from "../services/audit";
import type { Env, Variables } from "../types";

const tokens = new Hono<{ Bindings: Env; Variables: Variables }>();

const encoder = new TextEncoder();

async function sha256(data: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `cgt_${hex}`;
}

const MIN_EXPIRES_IN = 3600;       // 1 hour
const MAX_EXPIRES_IN = 2592000;    // 30 days
const MAX_TOKENS_PER_ORG = 1000;

// POST /v1/tokens — Create scoped token
tokens.post("/tokens", apiKeyAuth, async (c) => {
  const perms = c.get("apiKeyPermissions");
  if (!isMasterKey(perms)) {
    return c.json({ error: "Only master API keys can create scoped tokens" }, 403);
  }

  const orgId = c.get("orgId");
  const db = c.get("db");

  const body = await c.req.json().catch(() => ({})) as {
    name?: string;
    scopes?: unknown;
    expires_in?: number;
  };

  // Validate name
  const name = body.name?.trim();
  if (!name || name.length === 0 || name.length > 100) {
    return c.json({ error: "name is required (1-100 characters)" }, 400);
  }

  // Validate scopes
  const scopeError = validateScopes(body.scopes);
  if (scopeError) {
    return c.json({ error: scopeError }, 400);
  }
  const scopes = normalizeScopes(body.scopes as Record<string, string[]>);

  // Validate expires_in
  const expiresIn = body.expires_in;
  if (!expiresIn || typeof expiresIn !== "number" || expiresIn < MIN_EXPIRES_IN || expiresIn > MAX_EXPIRES_IN) {
    return c.json({ error: `expires_in is required (${MIN_EXPIRES_IN}-${MAX_EXPIRES_IN} seconds)` }, 400);
  }

  // Check org token limit
  const countResult = await db.execute(
    sql`SELECT COUNT(*)::int AS count FROM scoped_token
        WHERE org_id = ${orgId} AND revoked_at IS NULL AND expires_at > NOW()`
  );
  const activeCount = (countResult.rows[0] as any)?.count ?? 0;
  if (activeCount >= MAX_TOKENS_PER_ORG) {
    return c.json({ error: `Maximum ${MAX_TOKENS_PER_ORG} active tokens per organization` }, 400);
  }

  // Generate token
  const tokenValue = generateToken();
  const tokenId = `tok_${nanoid(16)}`;
  const keyHash = await sha256(tokenValue);
  const keyPrefix = tokenValue.slice(0, 12);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const apiKeyId = c.get("apiKeyId");

  await db.execute(
    sql`INSERT INTO scoped_token (id, org_id, created_by, name, key_prefix, key_hash, scopes, expires_at)
        VALUES (${tokenId}, ${orgId}, ${apiKeyId}, ${name}, ${keyPrefix}, ${keyHash}, ${JSON.stringify(scopes)}::jsonb, ${expiresAt.toISOString()}::timestamptz)`
  );

  recordAudit(c.executionCtx, db, {
    orgId, actorId: apiKeyId, actorType: "master_key",
    action: "token.create", resourceType: "token", resourceId: tokenId,
    metadata: { name, scopes }, requestId: c.get("requestId"),
  });

  return c.json({
    id: tokenId,
    token: tokenValue,  // shown ONCE
    name,
    key_prefix: keyPrefix,
    scopes,
    expires_at: expiresAt.toISOString(),
    created_at: new Date().toISOString(),
  }, 201);
});

// GET /v1/tokens — List active tokens
tokens.get("/tokens", apiKeyAuth, async (c) => {
  const perms = c.get("apiKeyPermissions");
  if (!isMasterKey(perms)) {
    return c.json({ error: "Only master API keys can list tokens" }, 403);
  }

  const orgId = c.get("orgId");
  const db = c.get("db");

  const result = await db.execute(
    sql`SELECT id, name, key_prefix, scopes, expires_at, revoked_at, last_used, created_at
        FROM scoped_token
        WHERE org_id = ${orgId}
          AND revoked_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 100`
  );

  return c.json({
    tokens: result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      key_prefix: row.key_prefix,
      scopes: row.scopes,
      expires_at: row.expires_at,
      last_used: row.last_used,
      created_at: row.created_at,
    })),
  });
});

// DELETE /v1/tokens/:id — Revoke token
tokens.delete("/tokens/:id", apiKeyAuth, async (c) => {
  const perms = c.get("apiKeyPermissions");
  if (!isMasterKey(perms)) {
    return c.json({ error: "Only master API keys can revoke tokens" }, 403);
  }

  const orgId = c.get("orgId");
  const db = c.get("db");
  const tokenId = c.req.param("id");

  const result = await db.execute(
    sql`UPDATE scoped_token
        SET revoked_at = NOW()
        WHERE id = ${tokenId}
          AND org_id = ${orgId}
          AND revoked_at IS NULL
        RETURNING id`
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Token not found or already revoked" }, 404);
  }

  recordAudit(c.executionCtx, db, {
    orgId, actorId: c.get("apiKeyId"), actorType: "master_key",
    action: "token.revoke", resourceType: "token", resourceId: tokenId,
    requestId: c.get("requestId"),
  });

  return c.json({ id: tokenId, revoked: true });
});

export { tokens };
