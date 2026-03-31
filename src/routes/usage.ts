/**
 * Usage endpoints
 *
 * GET /v1/usage          — Usage summary for current billing period
 * GET /v1/usage/details  — Detailed usage events
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { apiKeyAuth } from "../auth/middleware";
import { getUsageSummary } from "../services/usage";
import type { Env, Variables } from "../types";

const usage = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /v1/usage
usage.get("/", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");

  // Default to current month
  const now = new Date();
  const period =
    c.req.query("period") ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Validate period format
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return c.json({ error: "Invalid period format. Use YYYY-MM (e.g. 2026-03)" }, 400);
  }

  try {
    const summary = await getUsageSummary(db, orgId, period);

    return c.json({
      period,
      api_calls: summary.api_call || 0,
      repos_created: summary.repo_created || 0,
      storage_bytes: summary.storage_bytes || 0,
      git_transfer_bytes: summary.git_transfer_bytes || 0,
    });
  } catch (error) {
    console.error("Failed to get usage:", error);
    return c.json({ error: "Failed to get usage" }, 500);
  }
});

// GET /v1/usage/details
usage.get("/details", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  try {
    const result = await db.execute(sql`
      SELECT id, event_type, quantity, metadata, recorded_at
      FROM usage_event
      WHERE org_id = ${orgId}
      ORDER BY recorded_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return c.json({
      events: result.rows,
      limit,
      offset,
    });
  } catch (error) {
    console.error("Failed to get usage details:", error);
    return c.json({ error: "Failed to get usage details" }, 500);
  }
});

export { usage };
