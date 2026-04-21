/**
 * Custom Hostname management — internal endpoints, authed via
 * INTERNAL_SYNC_TOKEN (same pattern as /v1/sync/* and /v1/connections/*).
 *
 * The Next.js dashboard (coregit-app) forwards user-authenticated domain
 * operations here so the CF API token stays in Worker secrets instead of
 * living in Vercel env.
 *
 *   POST   /v1/domains/hostnames               { domain }           → creates CF custom hostname
 *   GET    /v1/domains/hostnames/:id                                 → fetches current status
 *   DELETE /v1/domains/hostnames/:id                                 → removes the CF hostname
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import {
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostname,
} from "../services/cloudflare-api";
import type { Env, Variables } from "../types";

export const domains = new Hono<{ Bindings: Env; Variables: Variables }>();

// apiKeyAuth handles both x-api-key and x-internal-token flows.
// For these routes only x-internal-token is meaningful — the Next.js
// dashboard is the sole caller.
domains.use("/domains/*", apiKeyAuth);

domains.post("/domains/hostnames", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { domain?: string } | null;
  const domain = (body?.domain ?? "").trim().toLowerCase();
  if (!domain) return c.json({ error: "domain is required" }, 400);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return c.json({ error: "Invalid domain format" }, 400);
  }

  try {
    const hostname = await createCustomHostname(c.env, domain);
    return c.json({
      cf_hostname_id: hostname.id,
      hostname: hostname.hostname,
      status: hostname.status,
      ssl_status: hostname.ssl?.status ?? null,
      ownership_verification: hostname.ownership_verification ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return c.json({ error: `Cloudflare error: ${msg}` }, 502);
  }
});

domains.get("/domains/hostnames/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const hostname = await getCustomHostname(c.env, id);
    return c.json({
      cf_hostname_id: hostname.id,
      hostname: hostname.hostname,
      status: hostname.status,
      ssl_status: hostname.ssl?.status ?? null,
      ownership_verification: hostname.ownership_verification ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return c.json({ error: `Cloudflare error: ${msg}` }, 502);
  }
});

domains.delete("/domains/hostnames/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await deleteCustomHostname(c.env, id);
    return c.json({ deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return c.json({ error: `Cloudflare error: ${msg}` }, 502);
  }
});
