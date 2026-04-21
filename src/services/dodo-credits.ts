/**
 * Thin Dodo Payments client for credit entitlements.
 *
 * Used from the Worker on hot-path (event ingestion) and admin operations
 * (ledger entries, balance queries, mandate charges). `fetch`-based so it
 * runs in CF Workers without pulling the full `dodopayments` SDK.
 */

const BASE_URL = "https://live.dodopayments.com";

export interface DodoCreditsConfig {
  apiKey: string;
  entitlementId: string;
}

export interface IngestEvent {
  event_id: string;                 // idempotency key — must be unique
  customer_id: string;
  event_name: string;               // e.g. "coregit.v2.api_call"
  timestamp?: string;               // ISO; defaults to now
  metadata?: Record<string, unknown>;
}

export interface LedgerEntryInput {
  entry_type: "credit" | "debit";
  amount: string;                   // decimal string, e.g. "25.00"
  reason: string;
  idempotency_key?: string;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BalanceResponse {
  balance: string;                  // decimal string
  overage?: string;
  last_transaction_at?: string | null;
}

export class DodoCredits {
  constructor(private cfg: DodoCreditsConfig) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async getBalance(customerId: string): Promise<BalanceResponse> {
    const r = await fetch(
      `${BASE_URL}/credit-entitlements/${this.cfg.entitlementId}/balances/${customerId}`,
      { headers: this.headers() }
    );
    if (!r.ok) throw new Error(`Dodo balance ${r.status} ${await r.text()}`);
    return r.json() as Promise<BalanceResponse>;
  }

  async ingestEvents(events: IngestEvent[]): Promise<void> {
    if (events.length === 0) return;
    const r = await fetch(`${BASE_URL}/events/ingest`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ events }),
    });
    if (!r.ok) throw new Error(`Dodo ingest ${r.status} ${await r.text()}`);
  }

  async createLedgerEntry(customerId: string, entry: LedgerEntryInput): Promise<unknown> {
    const r = await fetch(
      `${BASE_URL}/credit-entitlements/${this.cfg.entitlementId}/balances/${customerId}/ledger-entries`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          credit_entitlement_id: this.cfg.entitlementId,
          ...entry,
        }),
      }
    );
    if (!r.ok) throw new Error(`Dodo ledger ${r.status} ${await r.text()}`);
    return r.json();
  }

  async chargeMandate(subscriptionId: string, amountCents: number): Promise<unknown> {
    const r = await fetch(`${BASE_URL}/subscriptions/${subscriptionId}/charge`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        product_price: amountCents,
        customer_balance_config: { allow_customer_credits_purchase: true },
      }),
    });
    if (!r.ok) throw new Error(`Dodo charge ${r.status} ${await r.text()}`);
    return r.json();
  }
}

/** Convenience: map our UsageEventType → Dodo meter event_name. */
export const METER_EVENT_NAMES = {
  api_call: "coregit.v2.api_call",
  git_transfer_bytes: "coregit.v2.git_transfer",
  storage_bytes: "coregit.v2.storage",
  lazy_edit_tokens: "coregit.v2.lazy_edit_tokens",
  agentic_search_tokens: "coregit.v2.agentic_search_tokens",
  wiki_ingest_run: "coregit.v2.wiki_ingest_run",
  wiki_llm_tokens: "coregit.v2.wiki_llm_tokens",
} as const;

export type MeterEventKey = keyof typeof METER_EVENT_NAMES;
