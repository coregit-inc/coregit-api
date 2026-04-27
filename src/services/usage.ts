/**
 * Usage tracking — analytics DB insert + fire-and-forget Dodo meter ingest.
 *
 * All billing flows through Dodo Credit Entitlements now:
 *   recordUsage() → POST /events/ingest → Dodo worker (60s) → meter aggregation
 *   → credits deducted from (entitlement × customer) balance.
 *
 * `dodoCustomerId` must be passed from the Hono context (set in auth middleware).
 * If null (e.g. internal calls), Dodo ingest is skipped — analytics still recorded.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";
import type { Env } from "../types";
import { DodoCredits } from "./dodo-credits";
import { toDodoMeterEvent } from "./meter-pricing";

export type UsageEventType =
  | "api_call"
  | "storage_bytes"
  | "git_transfer_bytes"
  | "repo_created"
  | "repo_deleted"
  | "semantic_search_query"
  | "semantic_index_chunks"
  | "graph_query"
  | "hybrid_search"
  | "lazy_edit_tokens"
  | "agentic_search_tokens"
  | "wiki_ingest_run"
  | "wiki_llm_tokens"
  | "wiki_connector_setup";

/**
 * Record a usage event. Analytics DB insert + optional Dodo meter ingest,
 * both fire-and-forget.
 */
export function recordUsage(
  ctx: ExecutionContext,
  env: Env,
  db: Database,
  orgId: string,
  dodoCustomerId: string | null,
  eventType: UsageEventType,
  quantity: number,
  metadata?: Record<string, unknown>
): void {
  // Mark whether this event would be billable so the reconciliation /
  // fallback-debit job in coregit-app can rebuild charges from usage_event
  // alone, without round-tripping Dodo.
  const billable = quantity > 0 && toDodoMeterEvent(eventType, quantity) !== null;
  const eventMetadata = { ...(metadata ?? {}), billable };

  // 1) analytics: usage_event row
  ctx.waitUntil(
    db
      .execute(
        sql`INSERT INTO usage_event (org_id, event_type, quantity, metadata)
            VALUES (${orgId}, ${eventType}, ${quantity}, ${JSON.stringify(eventMetadata)})`
      )
      .catch((err) => console.error("[usage] event insert failed:", err))
  );

  // 2) Dodo meter ingest — fire-and-forget
  if (!dodoCustomerId || quantity <= 0) return;
  if (!env.DODO_PAYMENTS_API_KEY || !env.DODO_CREDIT_ENTITLEMENT_ID) return;

  const meter = toDodoMeterEvent(eventType, quantity);
  if (!meter) return; // not billable

  const dodo = new DodoCredits({
    apiKey: env.DODO_PAYMENTS_API_KEY,
    entitlementId: env.DODO_CREDIT_ENTITLEMENT_ID,
  });
  const eventId = `${orgId}_${eventType}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  ctx.waitUntil(
    dodo
      .ingestEvents([
        {
          event_id: eventId,
          customer_id: dodoCustomerId,
          event_name: meter.eventName,
          timestamp: new Date().toISOString(),
          metadata: { ...meter.metadata, ...metadata, quantity },
        },
      ])
      .catch((err) => console.error("[dodo ingest]", err))
  );
}

/**
 * Monthly usage summary per event type — used by /api/billing/status
 * as a sanity check (main balance comes from Dodo).
 */
export async function getUsageSummary(
  db: Database,
  orgId: string,
  period: string
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
