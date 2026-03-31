/**
 * Usage tracking service.
 * Records usage events to local DB AND forwards to Dodo Payments for billing.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { forwardUsageToDodo, DODO_EVENTS } from "./dodo";

export type UsageEventType =
  | "api_call"
  | "storage_bytes"
  | "git_transfer_bytes"
  | "repo_created"
  | "repo_deleted";

/**
 * Record a usage event to local DB and forward to Dodo if the org has a Dodo customer.
 */
export function recordUsage(
  ctx: ExecutionContext,
  db: Database,
  orgId: string,
  eventType: UsageEventType,
  quantity: number,
  metadata?: Record<string, unknown>,
  dodoApiKey?: string,
  dodoCustomerId?: string | null
) {
  // 1. Local DB insert (fire-and-forget)
  ctx.waitUntil(
    db
      .execute(
        sql`INSERT INTO usage_event (org_id, event_type, quantity, metadata)
          VALUES (${orgId}, ${eventType}, ${quantity}, ${metadata ? JSON.stringify(metadata) : null})`
      )
      .catch((err) => {
        console.error("Failed to record usage event:", err);
      })
  );

  // 2. Forward to Dodo Payments for billing (only if org is on usage tier)
  if (dodoApiKey && dodoCustomerId) {
    const now = Date.now();
    const eventId = `${orgId}_${eventType}_${now}`;

    const dodoEventName = mapToDodoEvent(eventType);
    if (dodoEventName) {
      const dodoMetadata =
        eventType === "git_transfer_bytes"
          ? { bytes: quantity, ...metadata }
          : metadata;

      forwardUsageToDodo(
        ctx,
        dodoApiKey,
        dodoCustomerId,
        dodoEventName,
        eventId,
        dodoMetadata
      );
    }
  }
}

function mapToDodoEvent(eventType: UsageEventType): string | null {
  switch (eventType) {
    case "api_call":
      return DODO_EVENTS.apiCall;
    case "git_transfer_bytes":
      return DODO_EVENTS.gitTransfer;
    case "repo_created":
    case "repo_deleted":
      return DODO_EVENTS.repoCount;
    default:
      return null;
  }
}

export async function getUsageSummary(
  db: Database,
  orgId: string,
  period: string // "YYYY-MM"
): Promise<Record<string, number>> {
  const startDate = `${period}-01`;
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
