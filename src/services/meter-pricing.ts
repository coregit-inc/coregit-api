/**
 * Pure pricing functions — extracted so the reconciliation script and the
 * cron-driven fallback debit (both live in coregit-app) can compute the
 * exact same dollar amounts as the live Dodo meter ingest path.
 *
 * Keep this file dependency-free and side-effect-free. No env, no fetch,
 * no DB access — just math.
 */

import { METER_EVENT_NAMES, type MeterEventKey } from "./dodo-credits";
import type { UsageEventType } from "./usage";

/** Per-event conversion: quantity → Dodo meter units (event_name + metadata). */
export function toDodoMeterEvent(
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
      return { eventName: METER_EVENT_NAMES.lazy_edit_tokens, metadata: { output_tokens: quantity } };
    case "agentic_search_tokens":
      return { eventName: METER_EVENT_NAMES.agentic_search_tokens, metadata: { output_tokens: quantity } };
    case "wiki_ingest_run":
      return { eventName: METER_EVENT_NAMES.wiki_ingest_run };
    case "wiki_llm_tokens":
      return { eventName: METER_EVENT_NAMES.wiki_llm_tokens, metadata: { total_tokens: quantity } };
    case "wiki_connector_setup":
      return null;
    default:
      return null;
  }
}

/**
 * Per-meter dollar prices in USD per *credit unit* (1 unit on the Dodo meter).
 * Mirrors the Dodo meter prices set via dashboard. Keep in sync with
 * `coregit-app/lib/billing/plans.ts` METER_PRICES_USD.
 *
 * Used by reconciliation + fallback debit cron — never by the live ingest
 * path (live path lets Dodo do the math).
 */
export const METER_PRICES_USD: Record<MeterEventKey, number> = {
  // $0.0001 per API call (10000 calls per credit)
  api_call: 0.0001,
  // $0.001 per MB transferred (1000 MB per credit)
  git_transfer_bytes: 0.001,
  // $0.001 per MB stored per snapshot (1000 MB per credit)
  storage_bytes: 0.001,
  // $1.32 per 1M output tokens (10% markup over Morph $1.20/MTok)
  lazy_edit_tokens: 1.32 / 1_000_000,
  // $1.32 per 1M output tokens (matches lazy_edit pricing)
  agentic_search_tokens: 1.32 / 1_000_000,
  // $0.01 per ingest run (100 runs per credit)
  wiki_ingest_run: 0.01,
  // $1 per 1M tokens (~4x markup over Inception ~$0.25/MTok input)
  wiki_llm_tokens: 1.0 / 1_000_000,
};

/**
 * Compute the dollar cost of a single usage event. Returns 0 for non-billable
 * events. Prefers the meter's natural unit (mb / total_tokens / output_tokens)
 * so the math matches Dodo's aggregation exactly.
 */
export function priceUsageEventUSD(eventType: UsageEventType, quantity: number): number {
  const meter = toDodoMeterEvent(eventType, quantity);
  if (!meter) return 0;
  const meterKey = Object.entries(METER_EVENT_NAMES).find(([, v]) => v === meter.eventName)?.[0] as
    | MeterEventKey
    | undefined;
  if (!meterKey) return 0;
  const unitPrice = METER_PRICES_USD[meterKey];

  const md = meter.metadata ?? {};
  const units =
    typeof md.mb === "number" ? md.mb :
    typeof md.total_tokens === "number" ? md.total_tokens :
    typeof md.output_tokens === "number" ? md.output_tokens :
    1; // count-based meters (api_call, wiki_ingest_run)
  return units * unitPrice;
}
