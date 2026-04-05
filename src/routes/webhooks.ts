/**
 * Webhook CRUD routes.
 *
 * POST   /v1/webhooks           — Create webhook
 * GET    /v1/webhooks           — List webhooks
 * GET    /v1/webhooks/:id       — Get webhook
 * PATCH  /v1/webhooks/:id       — Update webhook
 * DELETE /v1/webhooks/:id       — Delete webhook
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeyAuth } from "../auth/middleware";
import { isMasterKey } from "../auth/scopes";
import { recordAudit } from "../services/audit";
import { isPrivateUrl } from "../services/url-validator";
import { encryptSecret } from "../services/secret-manager";
import type { Env, Variables } from "../types";

const VALID_EVENTS = ["push", "repo.created", "repo.deleted", "branch.created", "branch.deleted", "*"];

const webhooks = new Hono<{ Bindings: Env; Variables: Variables }>();

function generateSecret(): string {
  return "whsec_" + nanoid(32);
}

// POST /v1/webhooks
webhooks.post("/webhooks", apiKeyAuth, async (c) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage webhooks", code: "FORBIDDEN" }, 403);
  }

  const db = c.get("db");
  const orgId = c.get("orgId");

  let body: { url: string; events: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", code: "VALIDATION_ERROR" }, 400);
  }

  if (!body.url || typeof body.url !== "string") {
    return c.json({ error: "url is required", code: "VALIDATION_ERROR" }, 400);
  }

  try {
    new URL(body.url);
  } catch {
    return c.json({ error: "url must be a valid URL", code: "VALIDATION_ERROR" }, 400);
  }

  if (!body.url.startsWith("https://")) {
    return c.json({ error: "url must use HTTPS", code: "VALIDATION_ERROR" }, 400);
  }

  if (isPrivateUrl(body.url)) {
    return c.json({ error: "Webhook URL must not point to private or internal addresses", code: "VALIDATION_ERROR" }, 400);
  }

  if (!Array.isArray(body.events) || body.events.length === 0) {
    return c.json({ error: "events must be a non-empty array", code: "VALIDATION_ERROR" }, 400);
  }

  for (const ev of body.events) {
    if (!VALID_EVENTS.includes(ev)) {
      return c.json({ error: `Invalid event: ${ev}. Valid: ${VALID_EVENTS.join(", ")}`, code: "VALIDATION_ERROR" }, 400);
    }
  }

  const id = nanoid();
  const secret = generateSecret();

  // Encrypt secret before storing
  const encryptionKey = c.env.WEBHOOK_ENCRYPTION_KEY || c.env.SYNC_ENCRYPTION_KEY;
  const encryptedSecret = await encryptSecret(encryptionKey, secret);

  await db.execute(sql`
    INSERT INTO webhook (id, org_id, url, secret, events, active)
    VALUES (${id}, ${orgId}, ${body.url}, ${encryptedSecret}, ${body.events}::text[], true)
  `);

  recordAudit(c.executionCtx, db, {
    orgId, actorId: c.get("apiKeyId"), actorType: "master_key",
    action: "webhook.create", resourceType: "webhook", resourceId: id,
    metadata: { url: body.url, events: body.events }, requestId: c.get("requestId"),
  });

  return c.json({ id, url: body.url, events: body.events, secret, active: true }, 201);
});

// GET /v1/webhooks
webhooks.get("/webhooks", apiKeyAuth, async (c) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage webhooks", code: "FORBIDDEN" }, 403);
  }

  const db = c.get("db");
  const orgId = c.get("orgId");

  const result = await db.execute(
    sql`SELECT id, url, events, active, created_at FROM webhook
        WHERE org_id = ${orgId} ORDER BY created_at DESC`
  );

  return c.json({ webhooks: result.rows });
});

// GET /v1/webhooks/:id
webhooks.get("/webhooks/:id", apiKeyAuth, async (c) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage webhooks", code: "FORBIDDEN" }, 403);
  }

  const db = c.get("db");
  const orgId = c.get("orgId");
  const id = c.req.param("id");

  const result = await db.execute(
    sql`SELECT id, url, events, active, created_at FROM webhook
        WHERE id = ${id} AND org_id = ${orgId} LIMIT 1`
  );

  if (result.rows.length === 0) {
    return c.json({ error: "Webhook not found", code: "NOT_FOUND" }, 404);
  }

  return c.json(result.rows[0]);
});

// PATCH /v1/webhooks/:id
webhooks.patch("/webhooks/:id", apiKeyAuth, async (c) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage webhooks", code: "FORBIDDEN" }, 403);
  }

  const db = c.get("db");
  const orgId = c.get("orgId");
  const id = c.req.param("id");

  let body: { url?: string; events?: string[]; active?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", code: "VALIDATION_ERROR" }, 400);
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.url !== undefined) {
    if (!body.url.startsWith("https://")) {
      return c.json({ error: "url must use HTTPS", code: "VALIDATION_ERROR" }, 400);
    }
    if (isPrivateUrl(body.url)) {
      return c.json({ error: "Webhook URL must not point to private or internal addresses", code: "VALIDATION_ERROR" }, 400);
    }
    sets.push("url");
    values.push(body.url);
  }

  if (body.events !== undefined) {
    for (const ev of body.events) {
      if (!VALID_EVENTS.includes(ev)) {
        return c.json({ error: `Invalid event: ${ev}`, code: "VALIDATION_ERROR" }, 400);
      }
    }
    sets.push("events");
    values.push(body.events);
  }

  if (body.active !== undefined) {
    sets.push("active");
    values.push(String(body.active));
  }

  if (sets.length === 0) {
    return c.json({ error: "No fields to update", code: "VALIDATION_ERROR" }, 400);
  }

  // Build dynamic update — safe because column names are hardcoded above
  const setClauses = sets.map((col, i) => {
    if (col === "events") return sql`events = ${body.events}::text[]`;
    if (col === "url") return sql`url = ${body.url}`;
    if (col === "active") return sql`active = ${body.active}`;
    return sql``;
  });

  // Execute individual updates since drizzle raw sql doesn't easily compose SET clauses
  for (const clause of setClauses) {
    await db.execute(sql`UPDATE webhook SET ${clause} WHERE id = ${id} AND org_id = ${orgId}`);
  }

  recordAudit(c.executionCtx, db, {
    orgId, actorId: c.get("apiKeyId"), actorType: "master_key",
    action: "webhook.update", resourceType: "webhook", resourceId: id,
    metadata: { fields: sets }, requestId: c.get("requestId"),
  });

  return c.json({ updated: true });
});

// DELETE /v1/webhooks/:id
webhooks.delete("/webhooks/:id", apiKeyAuth, async (c) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can manage webhooks", code: "FORBIDDEN" }, 403);
  }

  const db = c.get("db");
  const orgId = c.get("orgId");
  const id = c.req.param("id");

  await db.execute(
    sql`DELETE FROM webhook WHERE id = ${id} AND org_id = ${orgId}`
  );

  recordAudit(c.executionCtx, db, {
    orgId, actorId: c.get("apiKeyId"), actorType: "master_key",
    action: "webhook.delete", resourceType: "webhook", resourceId: id,
    requestId: c.get("requestId"),
  });

  return c.json({ deleted: true });
});

export { webhooks };
