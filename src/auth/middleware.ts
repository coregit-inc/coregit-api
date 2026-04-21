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
import { preloadOrgSlug } from "../services/repo-resolver";
import { recordUsage } from "../services/usage";
import { checkRateLimit, rateLimitHeaders, checkOrgRateLimit, orgRateLimitHeaders, type RateLimitResult } from "../services/rate-limit";
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

const AUTH_CACHE_TTL = 600; // 10 minutes — keys rarely change mid-session, revocation checked in JS

interface CachedAuth {
  orgId: string;
  scopes: Scopes;
  tokenId: string;
  tier: "free" | "paid";
  dodoCustomerId: string | null;
  orgSlug?: string; // populated on cache miss, saves a separate getOrgSlug() lookup
}

/**
 * Verify credentials with KV cache.
 * On cache hit: returns cached auth + org plan (0 DB queries).
 * On cache miss: single joined query for key + org plan (1 DB query), then caches result.
 */
export async function verifyWithCache(
  db: any,
  keyValue: string,
  authCache: KVNamespace | undefined,
): Promise<{ auth: CachedAuth; keyHash: string } | null> {
  const keyHash = await sha256(keyValue);
  const isScopedToken = keyValue.startsWith(SCOPED_TOKEN_PREFIX);

  // Check KV cache first
  if (authCache) {
    const cached = await authCache.get(`auth:${keyHash}`, "json") as CachedAuth | null;
    if (cached) {
      return { auth: cached, keyHash };
    }
  }

  // Cache miss — single joined query (key + org plan)
  let auth: CachedAuth | null = null;

  // NOTE: queries intentionally omit NOW() checks so Hyperdrive can cache them.
  // Expiry and revocation are checked in JS below. This makes auth queries
  // cacheable by Hyperdrive (queries with NOW() are never cached).
  if (isScopedToken) {
    const result = await db.execute(
      sql`SELECT st.id, st.org_id, st.scopes, st.expires_at, st.revoked_at,
                 COALESCE(op.tier, 'free') AS tier,
                 op.dodo_customer_id,
                 org.slug AS org_slug
          FROM scoped_token st
          LEFT JOIN org_plan op ON op.org_id = st.org_id
          LEFT JOIN organization org ON org.id = st.org_id
          WHERE st.key_hash = ${keyHash}
          LIMIT 1`
    );
    const row = result.rows[0] as any;
    if (row) {
      // Check expiry and revocation in JS (not SQL) for Hyperdrive cacheability
      const now = new Date();
      if (row.expires_at && new Date(row.expires_at) <= now) return null;
      if (row.revoked_at) return null;

      // Legacy 'usage' rows get normalized to 'paid' at read time.
      const normalizedTier: "free" | "paid" = row.tier === "paid" || row.tier === "usage" ? "paid" : "free";
      auth = {
        orgId: row.org_id,
        scopes: row.scopes,
        tokenId: row.id,
        tier: normalizedTier,
        dodoCustomerId: row.dodo_customer_id ?? null,
        orgSlug: row.org_slug || undefined,
      };
    }
  } else {
    const result = await db.execute(
      sql`SELECT ak.id, ak.org_id, ak.expires_at,
                 COALESCE(op.tier, 'free') AS tier,
                 op.dodo_customer_id,
                 org.slug AS org_slug
          FROM api_key ak
          LEFT JOIN org_plan op ON op.org_id = ak.org_id
          LEFT JOIN organization org ON org.id = ak.org_id
          WHERE ak.key_hash = ${keyHash}
          LIMIT 1`
    );
    const row = result.rows[0] as any;
    if (row) {
      // Check expiry in JS for Hyperdrive cacheability
      if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;

      const normalizedTier: "free" | "paid" = row.tier === "paid" || row.tier === "usage" ? "paid" : "free";
      auth = {
        orgId: row.org_id,
        scopes: null, // master key = full access
        tokenId: row.id,
        tier: normalizedTier,
        dodoCustomerId: row.dodo_customer_id ?? null,
        orgSlug: row.org_slug || undefined,
      };
    }
  }

  if (!auth) return null;

  // Cache the result (fire-and-forget)
  if (authCache) {
    // Don't await — caching shouldn't block the response
    authCache.put(`auth:${keyHash}`, JSON.stringify(auth), { expirationTtl: AUTH_CACHE_TTL }).catch((e) => console.error("Auth cache write failed:", e));
  }

  return { auth, keyHash };
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

  // ── Session fast-path (Zero-Wait Protocol) ──
  // Auth validated once at session open. Subsequent requests skip DB/KV auth entirely.
  const sessionId = c.req.header("x-session-id");
  if (sessionId) {
    if (!sessionId.startsWith("ses_")) {
      return c.json({ error: "Invalid session ID format" }, 400);
    }
    const doId = c.env.SESSION_DO.idFromName(sessionId);
    const stub = c.env.SESSION_DO.get(doId);
    const res = await stub.fetch("https://session/validate");

    if (!res.ok) {
      return c.json({ error: "Session expired or invalid" }, 401);
    }

    const session = (await res.json()) as {
      orgId: string;
      apiKeyId: string;
      scopes: Record<string, string[]> | null;
      orgTier: "free" | "paid";
      dodoCustomerId: string | null;
    };

    // Plan status lookup (tier + dodo_customer_id come from session meta already).
    const statusRow = await db.execute(
      sql`SELECT status FROM org_plan WHERE org_id = ${session.orgId} LIMIT 1`
    );
    const planStatus = (statusRow.rows[0] as { status: string } | undefined)?.status ?? "active";

    c.set("orgId", session.orgId);
    c.set("apiKeyPermissions", session.scopes);
    c.set("apiKeyId", session.apiKeyId);
    c.set("orgTier", session.orgTier);
    c.set("dodoCustomerId", session.dodoCustomerId);
    c.set("planStatus", planStatus);
    c.set("sessionId", sessionId);
    c.set("sessionStub", stub);

    await next();

    // Usage tracking (fire-and-forget)
    recordUsage(c.executionCtx, c.env, db, session.orgId, c.get("dodoCustomerId"), "api_call", 1, {
      method: c.req.method,
      path: c.req.path,
    });
    return;
  }

  // No session — initialize session variables to null
  c.set("sessionId", null);
  c.set("sessionStub", null);

  // ── Internal sync token (scoped to sync/connections routes only) ──
  const internalToken = c.req.header("x-internal-token");
  if (internalToken && c.env.INTERNAL_SYNC_TOKEN && timingSafeEqual(internalToken, c.env.INTERNAL_SYNC_TOKEN)) {
    const path = c.req.path;
    const isAllowedPath = /^\/v1\/repos\/[^/]+(\/[^/]+)?\/sync(\/|$)/.test(path)
      || /^\/v1\/connections(\/|$)/.test(path)
      || /^\/v1\/domains(\/|$)/.test(path);
    if (!isAllowedPath) {
      return c.json({ error: "Internal token not authorized for this endpoint" }, 403);
    }
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
    c.set("planStatus", orgPlan.status);
    await next();
    recordUsage(c.executionCtx, c.env, db, orgId, c.get("dodoCustomerId"), "api_call", 1, {
      method: c.req.method,
      path: c.req.path,
    });
    return;
  }

  // ── API key or scoped token ──
  const key = c.req.header("x-api-key");
  if (!key) {
    return c.json({ error: "Missing API key. Set x-api-key header." }, 401);
  }

  const isScopedToken = key.startsWith(SCOPED_TOKEN_PREFIX);
  const authCache = c.env.AUTH_CACHE as KVNamespace | undefined;
  const verified = await verifyWithCache(db, key, authCache);

  if (!verified) {
    if (isScopedToken) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    return c.json({ error: "Invalid API key" }, 401);
  }

  const { auth, keyHash } = verified;

  // Touch last_used (fire-and-forget)
  if (isScopedToken) {
    c.executionCtx.waitUntil(
      db.execute(sql`UPDATE scoped_token SET last_used = NOW() WHERE id = ${auth.tokenId}`).catch(() => {})
    );
  } else {
    c.executionCtx.waitUntil(
      db.execute(sql`UPDATE api_key SET last_used = NOW() WHERE key_hash = ${keyHash}`).catch(() => {})
    );
  }

  // Fresh plan status lookup (cheap — single-row query, Hyperdrive-cached).
  const statusRow = await db.execute(
    sql`SELECT status FROM org_plan WHERE org_id = ${auth.orgId} LIMIT 1`
  );
  const planStatus = (statusRow.rows[0] as { status: string } | undefined)?.status ?? "active";

  c.set("orgId", auth.orgId);
  c.set("apiKeyPermissions", auth.scopes);
  c.set("apiKeyId", auth.tokenId);
  c.set("orgTier", auth.tier);
  c.set("dodoCustomerId", auth.dodoCustomerId);
  c.set("planStatus", planStatus);

  // Preload org slug so getOrgSlug() skips KV + DB lookups
  if (auth.orgSlug) preloadOrgSlug(auth.orgId, auth.orgSlug);

  // ── Rate limiting: per-key + per-org in parallel (via Durable Objects) ──
  const [rl, orgRl] = await Promise.all([
    checkRateLimit(c.env.RATE_LIMITER, auth.tokenId),
    checkOrgRateLimit(c.env.RATE_LIMITER, auth.orgId),
  ]);

  const rlHeaders = rateLimitHeaders(rl);
  if (!rl.allowed) {
    for (const [k, v] of Object.entries(rlHeaders)) {
      c.header(k, v);
    }
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429);
  }

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
  recordUsage(c.executionCtx, c.env, db, auth.orgId, c.get("dodoCustomerId"), "api_call", 1, {
    method: c.req.method,
    path: c.req.path,
  });
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
 * Uses verifyWithCache without KV (git requests don't benefit from short-lived cache).
 * Returns org ID + scopes, or null if invalid.
 */
export async function verifyCredentialForGit(
  db: any,
  credentialValue: string,
  authCache?: KVNamespace,
): Promise<{ orgId: string; scopes: Scopes; tokenId: string } | null> {
  const result = await verifyWithCache(db, credentialValue, authCache);
  if (!result) return null;
  return { orgId: result.auth.orgId, scopes: result.auth.scopes, tokenId: result.auth.tokenId };
}
