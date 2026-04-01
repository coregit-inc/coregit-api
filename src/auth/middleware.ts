/**
 * API Key authentication middleware.
 *
 * Simple SHA-256 hash lookup against api_key table in Neon.
 * No Better Auth — just raw SQL.
 */

import { createMiddleware } from "hono/factory";
import { sql } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getOrgPlan } from "../services/limits";

const encoder = new TextEncoder();

async function sha256(data: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Middleware for REST API routes.
 * Validates API key from x-api-key header.
 */
export const apiKeyAuth = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const db = c.get("db");
  const internalToken = c.req.header("x-internal-token");
  if (internalToken && c.env.INTERNAL_SYNC_TOKEN && internalToken === c.env.INTERNAL_SYNC_TOKEN) {
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
    return next();
  }

  const key = c.req.header("x-api-key");
  if (!key) {
    return c.json({ error: "Missing API key. Set x-api-key header." }, 401);
  }

  const keyHash = await sha256(key);

  const result = await db.execute(
    sql`SELECT org_id FROM api_key WHERE key_hash = ${keyHash} LIMIT 1`
  );

  const row = result.rows[0] as { org_id: string } | undefined;
  if (!row) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // Touch last_used (fire-and-forget)
  c.executionCtx.waitUntil(
    db.execute(sql`UPDATE api_key SET last_used = NOW() WHERE key_hash = ${keyHash}`).catch(() => {})
  );

  c.set("orgId", row.org_id);
  c.set("apiKeyPermissions", null);
  c.set("apiKeyId", "");

  // Look up org plan for billing context
  const orgPlan = await getOrgPlan(db, row.org_id);
  c.set("orgTier", orgPlan.tier);
  c.set("dodoCustomerId", orgPlan.dodoCustomerId);

  await next();
});

/**
 * Parse HTTP Basic Auth for Git Smart HTTP.
 * Returns the API key (password field) or null.
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
 * Verify an API key and return the org ID, or null if invalid.
 */
export async function verifyApiKeyForGit(
  db: any,
  apiKeyValue: string
): Promise<{ orgId: string } | null> {
  const keyHash = await sha256(apiKeyValue);

  const result = await db.execute(
    sql`SELECT org_id FROM api_key WHERE key_hash = ${keyHash} LIMIT 1`
  );

  const row = result.rows[0] as { org_id: string } | undefined;
  if (!row) return null;

  return { orgId: row.org_id };
}


