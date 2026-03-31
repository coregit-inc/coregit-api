/**
 * Free tier enforcement for CoreGit API.
 *
 * Checks whether an org on the free plan has exceeded monthly usage limits.
 * Usage-tier orgs are unlimited (metered by Dodo Payments).
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

  if (eventType === "repo_created") {
    const result = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM repo WHERE org_id = ${orgId}`
    );
    const used = (result.rows[0] as any)?.count ?? 0;
    return {
      allowed: used < FREE_LIMITS.repos,
      used,
      limit: FREE_LIMITS.repos,
    };
  }

  if (eventType === "api_call") {
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(quantity), 0)::bigint AS total
      FROM usage_event
      WHERE org_id = ${orgId}
        AND event_type = 'api_call'
        AND recorded_at >= date_trunc('month', NOW())
    `);
    const used = Number((result.rows[0] as any)?.total ?? 0);
    return {
      allowed: used < FREE_LIMITS.api_calls,
      used,
      limit: FREE_LIMITS.api_calls,
    };
  }

  if (eventType === "git_transfer_bytes") {
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(quantity), 0)::bigint AS total
      FROM usage_event
      WHERE org_id = ${orgId}
        AND event_type = 'git_transfer_bytes'
        AND recorded_at >= date_trunc('month', NOW())
    `);
    const used = Number((result.rows[0] as any)?.total ?? 0);
    return {
      allowed: used < FREE_LIMITS.git_transfer_bytes,
      used,
      limit: FREE_LIMITS.git_transfer_bytes,
    };
  }

  return { allowed: true, used: 0, limit: Infinity };
}
