/**
 * Audit log endpoint
 *
 * GET /v1/audit-log — List audit events (master key only)
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { isMasterKey } from "../auth/scopes";
import type { Env, Variables } from "../types";

const audit = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /v1/audit-log
audit.get("/audit-log", apiKeyAuth, async (c) => {
  if (!isMasterKey(c.get("apiKeyPermissions"))) {
    return c.json({ error: "Only master API keys can view audit logs", code: "FORBIDDEN" }, 403);
  }

  const orgId = c.get("orgId");
  const db = c.get("db");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const cursor = c.req.query("cursor"); // id to start after
  const action = c.req.query("action");
  const resourceType = c.req.query("resource_type");
  const since = c.req.query("since"); // ISO timestamp
  const until = c.req.query("until"); // ISO timestamp

  let query = sql`SELECT id, actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, request_id, created_at
      FROM audit_log
      WHERE org_id = ${orgId}`;

  if (action) {
    query = sql`${query} AND action = ${action}`;
  }
  if (resourceType) {
    query = sql`${query} AND resource_type = ${resourceType}`;
  }
  if (since) {
    query = sql`${query} AND created_at >= ${since}::timestamptz`;
  }
  if (until) {
    query = sql`${query} AND created_at <= ${until}::timestamptz`;
  }
  if (cursor) {
    const cursorId = Number(cursor);
    if (!Number.isSafeInteger(cursorId) || cursorId <= 0) {
      return c.json({ error: "Invalid cursor" }, 400);
    }
    query = sql`${query} AND id < ${cursorId}`;
  }

  query = sql`${query} ORDER BY id DESC LIMIT ${limit + 1}`;

  const result = await db.execute(query);

  const rows = result.rows as any[];
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? String(events[events.length - 1].id) : null;

  return c.json({
    events,
    next_cursor: nextCursor,
  });
});

export { audit };
