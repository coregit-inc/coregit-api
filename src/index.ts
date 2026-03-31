/**
 * CoreGit API — Serverless Git for AI-native products
 *
 * Cloudflare Worker entry point.
 * Routes:
 *   /v1/repos                    — Repository CRUD
 *   /v1/repos/:slug/branches     — Branch operations
 *   /v1/repos/:slug/commits      — Commit operations (including API commit creation)
 *   /v1/repos/:slug/tree|blob    — File browsing
 *   /v1/repos/:slug/diff         — Diff between refs
 *   /v1/repos/:slug/snapshots    — Named restore points
 *   /v1/usage                    — Usage tracking
 *   /:org/:repo.git/*            — Git Smart HTTP (clone/push/pull)
 *
 * Auth: API key only (hash lookup in Neon DB).
 * Better Auth lives in coregit-app (Next.js), not here.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { createDb } from "./db";
import { repos } from "./routes/repos";
import { branches } from "./routes/branches";
import { commits } from "./routes/commits";
import { files } from "./routes/files";
import { diff } from "./routes/diff";
import { snapshots } from "./routes/snapshots";
import { usage } from "./routes/usage";
import { publicRoutes } from "./routes/public";
import { git } from "./routes/git";
import type { Env, Variables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Security headers ──

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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

app.get("/", (c) =>
  c.json({ name: "coregit-api", version: "0.1.0", status: "ok" })
);

app.get("/health", (c) => c.json({ status: "ok" }));

// ── DB middleware for API routes ──

app.use("/v1/*", async (c, next) => {
  if (!c.env.DATABASE_URL) return c.json({ error: "Database not configured" }, 500);
  c.set("db", createDb(c.env.DATABASE_URL));
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
  if (!c.env.DATABASE_URL) return c.text("Database not configured", 500);
  c.set("db", createDb(c.env.DATABASE_URL));
  await next();
});

// ── API routes ──

app.route("/v1/repos", repos);
app.route("/v1/repos", branches);
app.route("/v1/repos", commits);
app.route("/v1/repos", files);
app.route("/v1/repos", diff);
app.route("/v1/repos", snapshots);
app.route("/v1/usage", usage);

// ── Public read-only routes (no auth required) ──

app.route("/v1", publicRoutes);

// ── Git Smart HTTP ──

app.route("/", git);

// ── 404 ──

app.notFound((c) => c.json({ error: "Not found" }, 404));

// ── Error handler ──

app.onError((err, c) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.error(`[${requestId}] ${c.req.method} ${c.req.path}:`, err);
  c.header("X-Request-Id", requestId);
  return c.json({ error: "Internal server error", request_id: requestId }, 500);
});

export default app;
