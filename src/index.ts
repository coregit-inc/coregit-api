/**
 * CoreGit API — Serverless Git for AI-native products
 *
 * Cloudflare Worker entry point.
 * Routes:
 *   /api/auth/*                  — Better Auth (signup, login, orgs, API keys)
 *   /v1/repos                    — Repository CRUD
 *   /v1/repos/:slug/branches     — Branch operations
 *   /v1/repos/:slug/commits      — Commit operations (including API commit creation)
 *   /v1/repos/:slug/tree|blob    — File browsing
 *   /v1/repos/:slug/diff         — Diff between refs
 *   /v1/repos/:slug/snapshots    — Named restore points
 *   /v1/usage                    — Usage tracking
 *   /:org/:repo.git/*            — Git Smart HTTP (clone/push/pull)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDb } from "./db";
import { createAuth } from "./lib/auth";
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

// ── CORS for /api/auth/* (credentials: true for cross-subdomain cookies) ──

app.use(
  "/api/auth/*",
  cors({
    origin: (origin) => {
      if (
        origin === "https://app.coregit.dev" ||
        origin?.startsWith("http://localhost:") ||
        origin?.startsWith("http://127.0.0.1:")
      ) {
        return origin;
      }
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    maxAge: 600,
  })
);

// ── CORS for all other routes (skip /api/auth/* — handled above) ──

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth")) {
    return next();
  }
  return cors({
    origin: (origin, c) => {
      const allowed = c.env.CORS_ORIGIN || "https://coregit.dev";
      if (
        origin === allowed ||
        origin === "https://app.coregit.dev" ||
        origin?.startsWith("http://localhost:") ||
        origin?.startsWith("http://127.0.0.1:")
      ) {
        return origin;
      }
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    maxAge: 86400,
  })(c, next);
});

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

app.use("/api/auth/*", async (c, next) => {
  if (!c.env.DATABASE_URL) return c.json({ error: "Database not configured" }, 500);
  c.set("db", createDb(c.env.DATABASE_URL));
  await next();
});

// DB middleware for git routes (skip /api/* and /v1/*)
app.use("/:org/:repo/*", async (c, next) => {
  const orgParam = c.req.param("org");
  if (orgParam === "api" || orgParam === "v1") {
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

// ── Better Auth handler ──

app.all("/api/auth/*", (c) => {
  return createAuth(c.env).handler(c.req.raw);
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
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
