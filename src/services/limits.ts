/**
 * Free tier enforcement for CoreGit API.
 *
 * Checks whether an org on the free plan has exceeded monthly usage limits.
 * Usage-tier orgs are unlimited (metered by Dodo Payments).
 *
 * Uses a short-lived in-memory cache (60s) to avoid re-summing usage_event
 * on every single API call for the same org.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";

export const FREE_LIMITS = {
  api_calls: 10_000,
  git_transfer_bytes: 5 * 1024 * 1024 * 1024, // 5 GB
  repos: 5,
};

export type OrgTier = "free" | "usage";

export interface OrgPlanInfo {
  tier: OrgTier;
  dodoCustomerId: string | null;
}

// ── Usage cache (60s TTL, module-scoped across requests in same isolate) ──

const CACHE_TTL_MS = 60_000;
const usageCache = new Map<string, { value: number; ts: number }>();

function getCached(key: string): number | null {
  const entry = usageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    usageCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key: string, value: number) {
  // Cap cache size to prevent unbounded growth
  if (usageCache.size > 500) {
    const oldest = usageCache.keys().next().value;
    if (oldest) usageCache.delete(oldest);
  }
  usageCache.set(key, { value, ts: Date.now() });
}

/**
 * Get the org's plan tier and Dodo customer ID.
 * Returns free tier defaults if no org_plan row exists.
 */
export async function getOrgPlan(
  db: Database,
  orgId: string
): Promise<OrgPlanInfo> {
  const result = await db.execute(
    sql`SELECT tier, dodo_customer_id FROM org_plan WHERE org_id = ${orgId} LIMIT 1`
  );
  const row = result.rows[0] as
    | { tier: string; dodo_customer_id: string | null }
    | undefined;

  return {
    tier: (row?.tier as OrgTier) ?? "free",
    dodoCustomerId: row?.dodo_customer_id ?? null,
  };
}

/**
 * Check whether an org on the free tier has exceeded limits for the given event type.
 * Returns { allowed: true } for usage-tier orgs (no limits).
 */
export async function checkFreeLimits(
  db: Database,
  orgId: string,
  tier: OrgTier,
  eventType: "api_call" | "git_transfer_bytes" | "repo_created"
): Promise<{ allowed: boolean; used: number; limit: number }> {
  if (tier !== "free") {
    return { allowed: true, used: 0, limit: Infinity };
  }

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`;

  if (eventType === "repo_created") {
    const cacheKey = `${orgId}:repos`;
    let used = getCached(cacheKey);
    if (used === null) {
      const result = await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM repo WHERE org_id = ${orgId}`
      );
      used = (result.rows[0] as any)?.count ?? 0;
      setCache(cacheKey, used);
    }
    return {
      allowed: used < FREE_LIMITS.repos,
      used,
      limit: FREE_LIMITS.repos,
    };
  }

  if (eventType === "api_call") {
    const cacheKey = `${orgId}:api_call:${monthKey}`;
    let used = getCached(cacheKey);
    if (used === null) {
      const result = await db.execute(sql`
        SELECT COALESCE(SUM(quantity), 0)::bigint AS total
        FROM usage_event
        WHERE org_id = ${orgId}
          AND event_type = 'api_call'
          AND recorded_at >= date_trunc('month', NOW())
      `);
      used = Number((result.rows[0] as any)?.total ?? 0);
      setCache(cacheKey, used);
    }
    return {
      allowed: used < FREE_LIMITS.api_calls,
      used,
      limit: FREE_LIMITS.api_calls,
    };
  }

  if (eventType === "git_transfer_bytes") {
    const cacheKey = `${orgId}:git_transfer:${monthKey}`;
    let used = getCached(cacheKey);
    if (used === null) {
      const result = await db.execute(sql`
        SELECT COALESCE(SUM(quantity), 0)::bigint AS total
        FROM usage_event
        WHERE org_id = ${orgId}
          AND event_type = 'git_transfer_bytes'
          AND recorded_at >= date_trunc('month', NOW())
      `);
      used = Number((result.rows[0] as any)?.total ?? 0);
      setCache(cacheKey, used);
    }
    return {
      allowed: used < FREE_LIMITS.git_transfer_bytes,
      used,
      limit: FREE_LIMITS.git_transfer_bytes,
    };
  }

  return { allowed: true, used: 0, limit: Infinity };
}
