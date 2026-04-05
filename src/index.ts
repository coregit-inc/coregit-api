/**
 * CoreGit API — Serverless Git for AI-native products
 *
 * Cloudflare Worker entry point.
 * Routes:
 *   /v1/repos                    — Repository CRUD
 *   /v1/repos/:slug/branches     — Branch operations (incl. merge strategies)
 *   /v1/repos/:slug/commits      — Commit operations (including API commit creation)
 *   /v1/repos/:slug/tree|blob    — File browsing
 *   /v1/repos/:slug/diff         — Diff between refs
 *   /v1/repos/:slug/compare      — Compare two refs (merge-base, ahead/behind, mergeable)
 *   /v1/repos/:slug/cherry-pick  — Cherry-pick commits onto a new base
 *   /v1/repos/:slug/refs         — Low-level ref CRUD with CAS
 *   /v1/repos/:slug/snapshots    — Named restore points
 *   /v1/repos/:slug/exec         — Workspace: execute shell commands against repo
 *   /v1/repos/:slug/sync         — Sync from external providers (GitHub, GitLab)
 *   /v1/search                   — Cross-repo code search
 *   /v1/workspace/exec           — Multi-repo workspace (mount & exec across repos)
 *   /v1/usage                    — Usage tracking
 *   /:org/:repo.git/*            — Git Smart HTTP (clone/push/pull)
 *   /:repo.git/*                 — Git Smart HTTP via custom domain
 *
 * Auth: API key only (hash lookup in Neon DB).
 * Better Auth lives in coregit-app (Next.js), not here.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import { createDb } from "./db";
import { getOrgPlan } from "./services/limits";
import { repos } from "./routes/repos";
import { branches } from "./routes/branches";
import { commits } from "./routes/commits";
import { files } from "./routes/files";
import { diff } from "./routes/diff";
import { compare } from "./routes/compare";
import { cherryPick } from "./routes/cherry-pick";
import { refs } from "./routes/refs";
import { snapshots } from "./routes/snapshots";
import { usage } from "./routes/usage";
import { publicRoutes } from "./routes/public";
import { git } from "./routes/git";
import { customDomainGit } from "./routes/custom-domain-git";
import { workspace, multiWorkspace } from "./routes/workspace";
import { sync } from "./routes/sync";
import { syncConfig } from "./routes/sync-config";
import { syncWebhooks } from "./routes/sync-webhooks";
import { connections } from "./routes/connections";
import { tokens } from "./routes/tokens";
import { webhooks } from "./routes/webhooks";
import { search } from "./routes/search";
import { audit } from "./routes/audit";
import type { Env, Variables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Request ID + Security headers ──

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-Id", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

// ── Custom domain resolution (must run before CORS and routes) ──

const DOMAIN_CACHE = new Map<string, { orgId: string; status: string; ts: number }>();
const DOMAIN_CACHE_TTL = 60_000;

app.use("*", async (c, next) => {
  const host = (c.req.header("host") || "").split(":")[0];

  if (
    host === "api.coregit.dev" ||
    host === "custom.coregit.dev" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1")
  ) {
    c.set("customDomain", null);
    return next();
  }

  // Custom domain request — resolve org
  const cached = DOMAIN_CACHE.get(host);
  if (cached && Date.now() - cached.ts < DOMAIN_CACHE_TTL) {
    if (cached.status !== "active") {
      return c.text("Domain is not active", 403);
    }
    if (!c.env.DATABASE_URL) return c.text("Database not configured", 500);
    const db = createDb(c.env.DATABASE_URL);
    c.set("db", db);
    c.set("orgId", cached.orgId);
    c.set("customDomain", host);
    const plan = await getOrgPlan(db, cached.orgId);
    c.set("orgTier", plan.tier);
    c.set("dodoCustomerId", plan.dodoCustomerId);
    return next();
  }

  if (!c.env.DATABASE_URL) return c.text("Database not configured", 500);
  const db = createDb(c.env.DATABASE_URL);
  c.set("db", db);

  const result = await db.execute(
    sql`SELECT org_id, status FROM custom_domain WHERE domain = ${host} LIMIT 1`
  );
  const row = result.rows[0] as { org_id: string; status: string } | undefined;

  if (!row || (row.status !== "active" && row.status !== "suspended")) {
    return c.text("Unknown domain", 421);
  }

  DOMAIN_CACHE.set(host, { orgId: row.org_id, status: row.status, ts: Date.now() });
  if (DOMAIN_CACHE.size > 200) {
    const oldest = DOMAIN_CACHE.keys().next().value;
    if (oldest) DOMAIN_CACHE.delete(oldest);
  }

  c.set("orgId", row.org_id);
  c.set("customDomain", host);
  const plan = await getOrgPlan(db, row.org_id);
  c.set("orgTier", plan.tier);
  c.set("dodoCustomerId", plan.dodoCustomerId);
  await next();
});

// ── CORS ──

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.CORS_ORIGIN || "https://coregit.dev";
      if (
        origin === allowed ||
        origin === "https://app.coregit.dev"
      ) {
        return origin;
      }
      // Allow custom domain self-origin
      const host = (c.req.header("host") || "").split(":")[0];
      if (origin === `https://${host}` && host !== "api.coregit.dev") {
        return origin;
      }
      // Only allow localhost in non-production
      if (
        c.env.ENVIRONMENT === "development" &&
        (origin?.startsWith("http://localhost:") ||
          origin?.startsWith("http://127.0.0.1:"))
      ) {
        return origin;
      }
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Request-Id"],
    maxAge: 86400,
  })
);

// ── Body size limit for REST API routes (5 MB) ──

app.use("/v1/*", bodyLimit({ maxSize: 5 * 1024 * 1024 }));

// ── Health ──

app.get("/", (c) => {
  if (c.get("customDomain")) {
    // On custom domain, / is not health — fall through to git routes
    return c.notFound();
  }
  return c.json({ name: "coregit-api", version: "0.1.0", status: "ok" });
});

app.get("/health", async (c) => {
  if (!c.env.DATABASE_URL) {
    return c.json({ status: "degraded", db: "not_configured" }, 503);
  }
  try {
    const db = createDb(c.env.DATABASE_URL);
    await db.execute(sql`SELECT 1`);
    return c.json({ status: "ok", db: "ok" });
  } catch {
    return c.json({ status: "degraded", db: "unreachable" }, 503);
  }
});

// ── DB middleware for API routes ──

app.use("/v1/*", async (c, next) => {
  // DB may already be set by custom domain middleware
  if (!c.get("db")) {
    if (!c.env.DATABASE_URL) return c.json({ error: "Database not configured" }, 500);
    c.set("db", createDb(c.env.DATABASE_URL));
  }
  await next();
});

// DB middleware for git routes (skip /v1/*)
app.use("/:org/:repo/*", async (c, next) => {
  const orgParam = c.req.param("org");
  if (orgParam === "v1") {
    return next();
  }
  const repoParam = c.req.param("repo");
  if (!repoParam?.endsWith(".git") && !repoParam?.includes(".git/")) {
    return next();
  }
  if (!c.get("db")) {
    if (!c.env.DATABASE_URL) return c.text("Database not configured", 500);
    c.set("db", createDb(c.env.DATABASE_URL));
  }
  await next();
});

// DB middleware for namespaced git routes: /:org/:namespace/:repo.git/*
app.use("/:org/:namespace/:repo/*", async (c, next) => {
  const orgParam = c.req.param("org");
  if (orgParam === "v1") return next();
  const repoParam = c.req.param("repo");
  if (!repoParam?.endsWith(".git") && !repoParam?.includes(".git/")) return next();
  if (!c.get("db")) {
    if (!c.env.DATABASE_URL) return c.text("Database not configured", 500);
    c.set("db", createDb(c.env.DATABASE_URL));
  }
  await next();
});

// ── Custom domain git routes (/:repo.git/* — no org prefix) ──

app.route("/", customDomainGit);

// ── API routes ──
// IMPORTANT: repos must be registered LAST among /v1/repos sub-routes.
// Its /:namespace/:slug pattern would shadow /:slug/branches etc. if registered first.

app.route("/v1/repos", branches);
app.route("/v1/repos", commits);
app.route("/v1/repos", files);
app.route("/v1/repos", diff);
app.route("/v1/repos", compare);
app.route("/v1/repos", cherryPick);
app.route("/v1/repos", refs);
app.route("/v1/repos", snapshots);
app.route("/v1/repos", workspace);
app.route("/v1/repos", sync);
app.route("/v1/repos", syncConfig);
app.route("/v1/repos", repos);
app.route("/v1", connections);
app.route("/v1", tokens);
app.route("/v1", webhooks);
app.route("/v1", search);
app.route("/v1", audit);

// ── Public webhook endpoints (no auth) — MUST be before auth-gated routes ──
// Sync webhooks use DB directly, mounted on /v1 but skip apiKeyAuth
app.route("/v1", syncWebhooks);
app.route("/v1", multiWorkspace);
app.route("/v1/usage", usage);

// ── Public read-only routes (no auth required) ──

app.route("/v1", publicRoutes);

// ── Git Smart HTTP (standard: /:org/:repo.git/*) ──

app.route("/", git);

// ── 404 ──

app.notFound((c) => c.json({ error: "Not found" }, 404));

// ── Error handler ──

app.onError((err, c) => {
  const requestId = c.get("requestId") || crypto.randomUUID().slice(0, 8);
  if (c.env.ENVIRONMENT === "development") {
    console.error(`[${requestId}] ${c.req.method} ${c.req.path}:`, err);
  } else {
    console.error(`[${requestId}] ${c.req.method} ${c.req.path}: ${err?.message || "Unknown error"}`);
  }
  return c.json({ error: "Internal server error", code: "INTERNAL_ERROR", request_id: requestId }, 500);
});

export default app;
