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
import { DodoCredits, METER_EVENT_NAMES, type MeterEventKey } from "./dodo-credits";

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
 * Per-event conversion: quantity → Dodo meter units.
 *   api_call: count aggregation, 1 event = 1 call (metadata-less)
 *   git_transfer_bytes / storage_bytes: sum on "mb" key, bytes → MB (ceil)
 *
 * Non-billable events (repo_*, graph_query, hybrid_search, semantic_*):
 *   analytics only; we do NOT ingest to Dodo — avoid noisy ledger.
 */
function toDodoMeterEvent(
  eventType: UsageEventType,
  quantity: number
): { eventName: string; metadata?: Record<string, unknown> } | null {
  switch (eventType) {
    case "api_call":
      return { eventName: METER_EVENT_NAMES.api_call };
    case "git_transfer_bytes": {
      const mb = Math.max(1, Math.ceil(quantity / (1024 * 1024)));
      return { eventName: METER_EVENT_NAMES.git_transfer_bytes, metadata: { mb, bytes: quantity } };
    }
    case "storage_bytes": {
      const mb = Math.max(1, Math.ceil(quantity / (1024 * 1024)));
      return { eventName: METER_EVENT_NAMES.storage_bytes, metadata: { mb, bytes: quantity } };
    }
    case "lazy_edit_tokens":
      // Billed on Morph output (completion) tokens with a thin markup configured
      // in the Dodo meter price (target: $1.32 / 1M tokens = 10% markup over
      // Morph's $1.20 / 1M). Keep this low — Coregit's value is the commit
      // pipeline, not an LLM reseller margin.
      return {
        eventName: METER_EVENT_NAMES.lazy_edit_tokens,
        metadata: { output_tokens: quantity },
      };
    case "agentic_search_tokens":
      // Billed on summed Morph WarpGrep completion tokens across all turns.
      // Dodo meter target: $1.32 / 1M tokens (10% markup over Morph).
      return {
        eventName: METER_EVENT_NAMES.agentic_search_tokens,
        metadata: { output_tokens: quantity },
      };
    case "wiki_ingest_run":
      // One event per completed wiki workflow run (ingest/sync/dream/
      // lint/refresh). Low-volume, flat-rate meter — the LLM token
      // meter below is the actual variable cost.
      return { eventName: METER_EVENT_NAMES.wiki_ingest_run };
    case "wiki_llm_tokens":
      // Billed on the sum of Mercury-2 prompt + completion tokens
      // (cached tokens billed separately via metadata). Dodo meter
      // target: ~2x the Inception raw rate so we clear Inception's
      // ~$0.25/$0.75 per MTok cost with a small margin.
      return {
        eventName: METER_EVENT_NAMES.wiki_llm_tokens,
        metadata: { total_tokens: quantity },
      };
    case "wiki_connector_setup":
      // Analytics only — connector installation is free, no Dodo meter.
      return null;
    default:
      return null; // not billable
  }
}

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
  // 1) analytics: usage_event row
  ctx.waitUntil(
    db
      .execute(
        sql`INSERT INTO usage_event (org_id, event_type, quantity, metadata)
            VALUES (${orgId}, ${eventType}, ${quantity}, ${metadata ? JSON.stringify(metadata) : null})`
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
