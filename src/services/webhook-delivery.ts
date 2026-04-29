/**
 * Webhook delivery service.
 *
 * Dispatches webhook events to registered URLs with HMAC-SHA256 signatures.
 * Fire-and-forget via waitUntil — does not block the request.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { decryptSecret } from "./secret-manager";
import { isPrivateUrl } from "./url-validator";

const encoder = new TextEncoder();

export type WebhookEventType =
  | "push"
  | "repo.created"
  | "repo.deleted"
  | "repo.forked"
  | "branch.created"
  | "branch.deleted";

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  org_id: string;
  data: Record<string, unknown>;
}

/**
 * Sign a payload using HMAC-SHA256.
 */
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deliver a webhook event to all matching subscribers for an org.
 * Runs via waitUntil — does not block the caller.
 */
export function deliverWebhooks(
  ctx: ExecutionContext,
  db: Database,
  orgId: string,
  event: WebhookEventType,
  data: Record<string, unknown>,
  encryptionKey?: string
): void {
  ctx.waitUntil(doDeliver(db, orgId, event, data, encryptionKey));
}

async function doDeliver(
  db: Database,
  orgId: string,
  event: WebhookEventType,
  data: Record<string, unknown>,
  encryptionKey?: string
): Promise<void> {
  // Fetch active webhooks that subscribe to this event
  const result = await db.execute(
    sql`SELECT id, url, secret, events FROM webhook
        WHERE org_id = ${orgId} AND active = 'true'`
  );

  const webhooks = result.rows as {
    id: string;
    url: string;
    secret: string;
    events: string[];
  }[];

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    org_id: orgId,
    data,
  };

  const body = JSON.stringify(payload);

  const deliveries = webhooks
    .filter((wh) => wh.events.includes(event) || wh.events.includes("*"))
    .map(async (wh) => {
      try {
        // Re-validate URL at delivery time to prevent DNS rebinding SSRF
        if (isPrivateUrl(wh.url)) {
          console.error(`[webhook] ${wh.id} → ${wh.url} blocked: resolves to private address`);
          return;
        }

        // Decrypt secret if encryption key is available (new encrypted format contains ':')
        let secret = wh.secret;
        if (encryptionKey && wh.secret.includes(":")) {
          try {
            secret = await decryptSecret(encryptionKey, wh.secret);
          } catch {
            console.error(`[webhook] ${wh.id} failed to decrypt secret, skipping`);
            return;
          }
        }
        const signature = await sign(secret, body);
        const response = await fetch(wh.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CoreGit-Event": event,
            "X-CoreGit-Signature": signature,
            "X-CoreGit-Webhook-Id": wh.id,
            "User-Agent": "CoreGit-Webhook/1.0",
          },
          body,
          signal: AbortSignal.timeout(10_000), // 10s timeout per delivery
        });
        if (!response.ok) {
          console.error(`[webhook] ${wh.id} → ${wh.url} returned ${response.status}`);
        }
      } catch (err) {
        console.error(`[webhook] ${wh.id} → ${wh.url} failed:`, err);
      }
    });

  await Promise.allSettled(deliveries);
}
