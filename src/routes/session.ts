/**
 * Session routes — Zero-Wait Git Protocol.
 *
 * POST   /v1/session           — Open session (auth once)
 * GET    /v1/session/:id/status — Session stats
 * POST   /v1/session/:id/flush  — Explicit flush to R2
 * DELETE /v1/session/:id        — Close (flush + destroy)
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { verifyWithCache } from "../auth/middleware";
import { checkRateLimit, checkOrgRateLimit } from "../services/rate-limit";
import type { Env, Variables } from "../types";

const session = new Hono<{ Bindings: Env; Variables: Variables }>();

const TTL_CAP_PAID_S = 8 * 60 * 60; // 8 hours
const TTL_CAP_FREE_S = 60 * 60; // 1 hour
const TTL_DEFAULT_S = 30 * 60; // 30 minutes

// POST /v1/session — Open a new session
//
// Body (optional): { ttl_seconds?, idle_extend? }
//   ttl_seconds  — caller-requested TTL in seconds; capped at 8 h (paid) / 1 h (free).
//                  Default 30 min when omitted (legacy behaviour).
//   idle_extend  — when true (default), every authenticated request slides
//                  the expiry alarm. Set false for a fixed expiry from open().
session.post("/session", async (c) => {
  const db = c.get("db");
  const key = c.req.header("x-api-key");
  if (!key) return c.json({ error: "Missing API key. Set x-api-key header." }, 401);

  const authCache = c.env.AUTH_CACHE as KVNamespace | undefined;
  const verified = await verifyWithCache(db, key, authCache);
  if (!verified) return c.json({ error: "Invalid API key" }, 401);

  const { auth } = verified;

  // Rate limit (session open = 1 request)
  const [rl, orgRl] = await Promise.all([
    checkRateLimit(c.env.RATE_LIMITER, auth.tokenId),
    checkOrgRateLimit(c.env.RATE_LIMITER, auth.orgId),
  ]);
  if (!rl.allowed) return c.json({ error: "Rate limit exceeded" }, 429);
  if (!orgRl.allowed) return c.json({ error: "Organization rate limit exceeded" }, 429);

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const cap = auth.tier === "paid" ? TTL_CAP_PAID_S : TTL_CAP_FREE_S;
  const requestedSec =
    typeof body?.ttl_seconds === "number" && body.ttl_seconds > 0
      ? Math.min(Math.floor(body.ttl_seconds), cap)
      : TTL_DEFAULT_S;
  const idleExtend = body?.idle_extend === false ? false : true;
  const ttlMs = requestedSec * 1000;

  const sessionId = `ses_${nanoid(21)}`;
  const doId = c.env.SESSION_DO.idFromName(sessionId);
  const stub = c.env.SESSION_DO.get(doId);

  const res = await stub.fetch("https://session/open", {
    method: "POST",
    body: JSON.stringify({
      orgId: auth.orgId,
      apiKeyId: auth.tokenId,
      scopes: auth.scopes,
      orgTier: auth.tier,
      dodoCustomerId: auth.dodoCustomerId,
      ttlMs,
      idleExtend,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to create session" }));
    return c.json(err, res.status as any);
  }

  return c.json({
    session_id: sessionId,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    ttl_seconds: requestedSec,
    idle_extend: idleExtend,
  }, 201);
});

// GET /v1/session/:id/status
session.get("/session/:id/status", async (c) => {
  const sessionId = c.req.param("id");
  if (!sessionId?.startsWith("ses_")) return c.json({ error: "Invalid session ID" }, 400);

  const doId = c.env.SESSION_DO.idFromName(sessionId);
  const stub = c.env.SESSION_DO.get(doId);
  const res = await stub.fetch("https://session/status");

  if (!res.ok) return c.json({ error: "Session not found" }, 404);
  return c.json(await res.json());
});

// POST /v1/session/:id/flush
session.post("/session/:id/flush", async (c) => {
  const sessionId = c.req.param("id");
  if (!sessionId?.startsWith("ses_")) return c.json({ error: "Invalid session ID" }, 400);

  const doId = c.env.SESSION_DO.idFromName(sessionId);
  const stub = c.env.SESSION_DO.get(doId);
  const res = await stub.fetch("https://session/flush", { method: "POST" });

  if (!res.ok) return c.json({ error: "Flush failed" }, 500);
  return c.json(await res.json());
});

// DELETE /v1/session/:id
session.delete("/session/:id", async (c) => {
  const sessionId = c.req.param("id");
  if (!sessionId?.startsWith("ses_")) return c.json({ error: "Invalid session ID" }, 400);

  const doId = c.env.SESSION_DO.idFromName(sessionId);
  const stub = c.env.SESSION_DO.get(doId);
  const res = await stub.fetch("https://session/close", { method: "POST" });

  if (!res.ok) return c.json({ error: "Close failed" }, 500);
  return c.json(await res.json());
});

export { session };
