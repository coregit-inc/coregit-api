/**
 * Usage tracking service.
 * Records usage events via fire-and-forget (waitUntil).
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";

export type UsageEventType =
  | "api_call"
  | "storage_bytes"
  | "git_transfer_bytes"
  | "repo_created"
  | "repo_deleted";

export function recordUsage(
  ctx: ExecutionContext,
  db: Database,
  orgId: string,
  eventType: UsageEventType,
  quantity: number,
  metadata?: Record<string, unknown>
) {
  ctx.waitUntil(
    db.execute(
      sql`INSERT INTO usage_event (org_id, event_type, quantity, metadata)
          VALUES (${orgId}, ${eventType}, ${quantity}, ${metadata ? JSON.stringify(metadata) : null})`
    ).catch((err) => {
      console.error("Failed to record usage event:", err);
    })
  );
}

export async function getUsageSummary(
  db: Database,
  orgId: string,
  period: string // "YYYY-MM"
): Promise<Record<string, number>> {
  const startDate = `${period}-01`;
  // Next month
  const [year, month] = period.split("-").map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const result = await db.execute(sql`
    SELECT event_type, COALESCE(SUM(quantity), 0)::bigint AS total
    FROM usage_event
    WHERE org_id = ${orgId}
      AND recorded_at >= ${startDate}::timestamptz
      AND recorded_at < ${endDate}::timestamptz
    GROUP BY event_type
  `);

  const summary: Record<string, number> = {};
  for (const row of result.rows as { event_type: string; total: string }[]) {
    summary[row.event_type] = Number(row.total);
  }
  return summary;
}
