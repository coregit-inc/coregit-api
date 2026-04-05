/**
 * Authentication middleware.
 *
 * Supports two credential types:
 *   1. Master API keys (cgk_live_*) — full org access, stored in api_key table
 *   2. Scoped tokens (cgt_*) — repo-scoped, time-limited, stored in scoped_token table
 *
 * Both use SHA-256 hash lookup. Prefix-based routing avoids double queries.
 */

import { createMiddleware } from "hono/factory";
import { sql } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getOrgPlan } from "../services/limits";
import { recordUsage } from "../services/usage";
import { checkRateLimit, rateLimitHeaders, checkOrgRateLimit, orgRateLimitHeaders } from "../services/rate-limit";
import type { Scopes } from "./scopes";

const encoder = new TextEncoder();
const SCOPED_TOKEN_PREFIX = "cgt_";

async function sha256(data: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

/**
 * Verify a scoped token (cgt_*).
 * Returns org_id + scopes if valid, null otherwise.
 */
async function verifyScopedToken(
  db: any,
  tokenValue: string
): Promise<{ orgId: string; scopes: Scopes; tokenId: string } | null> {
  const keyHash = await sha256(tokenValue);

  const result = await db.execute(
    sql`SELECT id, org_id, scopes FROM scoped_token
        WHERE key_hash = ${keyHash}
          AND expires_at > NOW()
          AND revoked_at IS NULL
        LIMIT 1`
  );

  const row = result.rows[0] as { id: string; org_id: string; scopes: Record<string, string[]> } | undefined;
  if (!row) return null;

  return { orgId: row.org_id, scopes: row.scopes, tokenId: row.id };
}

/**
 * Verify a master API key (non cgt_* prefix).
 * Returns org_id with null scopes (full access).
 */
async function verifyMasterKey(
  db: any,
  keyValue: string
): Promise<{ orgId: string; scopes: null; tokenId: string; keyHash: string } | null> {
  const keyHash = await sha256(keyValue);

  const result = await db.execute(
    sql`SELECT id, org_id, expires_at FROM api_key
        WHERE key_hash = ${keyHash}
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`
  );

  const row = result.rows[0] as { id: string; org_id: string; expires_at: string | null } | undefined;
  if (!row) return null;

  return { orgId: row.org_id, scopes: null, tokenId: row.id, keyHash };
}

/**
 * Middleware for REST API routes.
 * Validates API key or scoped token from x-api-key header.
 */
export const apiKeyAuth = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const db = c.get("db");

  // ── Internal sync token ──
  const internalToken = c.req.header("x-internal-token");
  if (internalToken && c.env.INTERNAL_SYNC_TOKEN && timingSafeEqual(internalToken, c.env.INTERNAL_SYNC_TOKEN)) {
    const orgId = c.req.header("x-org-id");
    if (!orgId) {
      return c.json({ error: "Missing x-org-id header" }, 400);
    }
    c.set("orgId", orgId);
    c.set("apiKeyPermissions", null);
    c.set("apiKeyId", "internal");
    const orgPlan = await getOrgPlan(db, orgId);
    c.set("orgTier", orgPlan.tier);
    c.set("dodoCustomerId", orgPlan.dodoCustomerId);
    await next();
    recordUsage(c.executionCtx, db, orgId, "api_call", 1, {
      method: c.req.method,
      path: c.req.path,
    }, c.env.DODO_PAYMENTS_API_KEY, orgPlan.dodoCustomerId);
    return;
  }

  // ── API key or scoped token ──
  const key = c.req.header("x-api-key");
  if (!key) {
    return c.json({ error: "Missing API key. Set x-api-key header." }, 401);
  }

  const isScopedToken = key.startsWith(SCOPED_TOKEN_PREFIX);
  const authResult = isScopedToken
    ? await verifyScopedToken(db, key)
    : await verifyMasterKey(db, key);

  if (!authResult) {
    if (isScopedToken) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Touch last_used (fire-and-forget)
  if (isScopedToken) {
    c.executionCtx.waitUntil(
      db.execute(sql`UPDATE scoped_token SET last_used = NOW() WHERE id = ${authResult.tokenId}`).catch(() => {})
    );
  } else {
    // Use cached keyHash from verifyMasterKey (avoids double SHA-256)
    const cachedHash = (authResult as any).keyHash;
    c.executionCtx.waitUntil(
      db.execute(sql`UPDATE api_key SET last_used = NOW() WHERE key_hash = ${cachedHash}`).catch(() => {})
    );
  }

  c.set("orgId", authResult.orgId);
  c.set("apiKeyPermissions", authResult.scopes);
  c.set("apiKeyId", authResult.tokenId);

  const orgPlan = await getOrgPlan(db, authResult.orgId);
  c.set("orgTier", orgPlan.tier);
  c.set("dodoCustomerId", orgPlan.dodoCustomerId);

  // ── Per-key rate limiting ──
  const rl = checkRateLimit(authResult.tokenId);
  const rlHeaders = rateLimitHeaders(rl);
  if (!rl.allowed) {
    for (const [k, v] of Object.entries(rlHeaders)) {
      c.header(k, v);
    }
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429);
  }

  // ── Per-org rate limiting ──
  const orgRl = checkOrgRateLimit(authResult.orgId);
  const orgRlHeaders = orgRateLimitHeaders(orgRl);
  if (!orgRl.allowed) {
    for (const [k, v] of Object.entries(orgRlHeaders)) {
      c.header(k, v);
    }
    return c.json({ error: "Organization rate limit exceeded", code: "RATE_LIMITED" }, 429);
  }

  await next();

  // Attach rate limit headers to successful responses
  for (const [k, v] of Object.entries(rlHeaders)) {
    c.header(k, v);
  }

  // Record api_call usage for every authenticated request
  recordUsage(c.executionCtx, db, authResult.orgId, "api_call", 1, {
    method: c.req.method,
    path: c.req.path,
  }, c.env.DODO_PAYMENTS_API_KEY, orgPlan.dodoCustomerId);
});

/**
 * Parse HTTP Basic Auth for Git Smart HTTP.
 * Returns the credential (password field) or null.
 */
export function parseBasicAuthKey(header: string | undefined): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    return decoded.slice(colonIdx + 1);
  } catch {
    return null;
  }
}

/**
 * Verify a credential (API key or scoped token) for Git operations.
 * Returns org ID + scopes, or null if invalid.
 */
export async function verifyCredentialForGit(
  db: any,
  credentialValue: string
): Promise<{ orgId: string; scopes: Scopes; tokenId: string } | null> {
  if (credentialValue.startsWith(SCOPED_TOKEN_PREFIX)) {
    return verifyScopedToken(db, credentialValue);
  }
  return verifyMasterKey(db, credentialValue);
}
