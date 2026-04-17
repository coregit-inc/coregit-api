/**
 * Free-tier enforcement — no wallet balance checks.
 *
 * Balance lives in Dodo. Here we only gate on:
 *   - status: 'frozen' → block all billable ops
 *   - tier 'free' → max 3 repos, 100 API calls/day
 *   - tier 'paid' → unlimited (balance enforced by Dodo)
 *
 * Short-lived in-memory cache (60s) on counts to avoid re-summing usage_event
 * on every request for the same org.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";

export const FREE_TIER_LIMITS = {
  maxRepos: 3,
  maxApiCallsPerDay: 100,
} as const;

export type OrgTier = "free" | "paid";

export interface OrgPlanInfo {
  tier: OrgTier;
  status: string;
  dodoCustomerId: string | null;
}

// ── in-memory cache (per-isolate) ──
const CACHE_TTL_MS = 60_000;
const counterCache = new Map<string, { value: number; ts: number }>();

function getCached(key: string): number | null {
  const entry = counterCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    counterCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key: string, value: number) {
  if (counterCache.size > 500) {
    const oldest = counterCache.keys().next().value;
    if (oldest) counterCache.delete(oldest);
  }
  counterCache.set(key, { value, ts: Date.now() });
}

/** Load org's plan. Returns free-tier defaults if no row exists. */
export async function getOrgPlan(db: Database, orgId: string): Promise<OrgPlanInfo> {
  const result = await db.execute(sql`
    SELECT tier, status, dodo_customer_id FROM org_plan WHERE org_id = ${orgId} LIMIT 1
  `);
  const row = result.rows[0] as
    | { tier: string; status: string; dodo_customer_id: string | null }
    | undefined;
  if (!row) return { tier: "free", status: "active", dodoCustomerId: null };
  const tier: OrgTier = row.tier === "paid" || row.tier === "usage" ? "paid" : "free";
  return { tier, status: row.status, dodoCustomerId: row.dodo_customer_id ?? null };
}

export type LimitEventType = "api_call" | "repo_created" | "git_transfer_bytes" | "storage_bytes";

export type LimitCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "repo_limit"; used: number; limit: number }
  | { allowed: false; reason: "daily_rate_limit"; used: number; limit: number }
  | { allowed: false; reason: "account_frozen" };

/**
 * Check whether the org may perform this event.
 * Balance is NOT checked here — Dodo enforces it via credit entitlement.
 */
export async function checkLimits(
  db: Database,
  plan: OrgPlanInfo,
  orgId: string,
  eventType: LimitEventType
): Promise<LimitCheckResult> {
  if (plan.status === "frozen") {
    return { allowed: false, reason: "account_frozen" };
  }

  if (plan.tier === "paid") {
    return { allowed: true };
  }

  // ── free tier gates ──
  if (eventType === "repo_created") {
    const cacheKey = `${orgId}:repos`;
    let used = getCached(cacheKey);
    if (used === null) {
      const result = await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM repo WHERE org_id = ${orgId}`
      );
      used = (result.rows[0] as { count: number } | undefined)?.count ?? 0;
      setCache(cacheKey, used);
    }
    if (used >= FREE_TIER_LIMITS.maxRepos) {
      return { allowed: false, reason: "repo_limit", used, limit: FREE_TIER_LIMITS.maxRepos };
    }
    return { allowed: true };
  }

  if (eventType === "api_call") {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `${orgId}:api_day:${today}`;
    let used = getCached(cacheKey);
    if (used === null) {
      const result = await db.execute(sql`
        SELECT COALESCE(SUM(quantity), 0)::bigint AS total
        FROM usage_event
        WHERE org_id = ${orgId}
          AND event_type = 'api_call'
          AND recorded_at >= NOW() - INTERVAL '1 day'
      `);
      used = Number((result.rows[0] as { total: string } | undefined)?.total ?? 0);
      setCache(cacheKey, used);
    }
    if (used >= FREE_TIER_LIMITS.maxApiCallsPerDay) {
      return {
        allowed: false,
        reason: "daily_rate_limit",
        used,
        limit: FREE_TIER_LIMITS.maxApiCallsPerDay,
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}

/**
 * Legacy shim — `checkFreeLimits` is still used across ~10 call sites with the
 * old API. Keep it compatible during the transition.
 */
export async function checkFreeLimits(
  db: Database,
  orgId: string,
  _tier: string,
  eventType: LimitEventType
): Promise<{ allowed: boolean; used: number; limit: number; reason?: string }> {
  const plan = await getOrgPlan(db, orgId);
  const r = await checkLimits(db, plan, orgId, eventType);
  if (r.allowed) return { allowed: true, used: 0, limit: Infinity };
  if (r.reason === "repo_limit" || r.reason === "daily_rate_limit") {
    return { allowed: false, used: r.used, limit: r.limit, reason: r.reason };
  }
  return { allowed: false, used: 0, limit: 0, reason: r.reason };
}
