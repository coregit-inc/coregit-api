/**
 * Dodo Payments Event Ingestion — forwards usage events for billing.
 *
 * Docs: https://docs.dodopayments.com/features/usage-based-billing/event-ingestion
 *
 * Dodo meters aggregate these events into billable quantities:
 * - Count (api calls), Sum (bytes), Last (repo count, storage)
 * Then bills: (consumed - free_threshold) × price_per_unit
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";

const DODO_INGEST_URL = "https://live.dodopayments.com/events/ingest";

// Dodo event names — must match meters in Dodo dashboard
export const DODO_EVENTS = {
  apiCall: "coregit.api_call",
  gitTransfer: "coregit.git_transfer",
  storage: "coregit.storage",
  semanticSearch: "coregit.semantic_search",
  semanticIndex: "coregit.semantic_index",
} as const;

/**
 * Forward a usage event to Dodo Payments event ingestion API.
 * Fire-and-forget via waitUntil — does not block the request.
 */
export function forwardUsageToDodo(
  ctx: ExecutionContext,
  apiKey: string,
  dodoCustomerId: string,
  eventName: string,
  eventId: string,
  metadata?: Record<string, unknown>
) {
  ctx.waitUntil(
    fetch(DODO_INGEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        events: [
          {
            event_id: eventId,
            customer_id: dodoCustomerId,
            event_name: eventName,
            timestamp: new Date().toISOString(),
            metadata,
          },
        ],
      }),
    }).catch((err) => {
      console.error("Dodo event forward failed:", err);
    })
  );
}

/**
 * Look up the Dodo customer ID for an org.
 * Returns null if the org is on free tier (no Dodo customer).
 */
export async function getDodoCustomerId(
  db: Database,
  orgId: string
): Promise<string | null> {
  const result = await db.execute(
    sql`SELECT dodo_customer_id FROM org_plan WHERE org_id = ${orgId} AND tier = 'usage' LIMIT 1`
  );
  const row = result.rows[0] as { dodo_customer_id: string } | undefined;
  return row?.dodo_customer_id ?? null;
}
