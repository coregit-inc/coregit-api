/**
 * Hono application construction.
 *
 * Extracted from src/index.ts so the app can be reused by both the default
 * Worker fetch handler and the CoregitCoreBinding WorkerEntrypoint (RPC from
 * adjacent private Workers on the same Cloudflare account).
 *
 * This file must remain focused on wiring: no business logic, no side effects
 * beyond attaching middleware and mounting routers.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { sql } from "drizzle-orm";
import { createDb, dbConnectionString } from "./db";
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
import { agenticSearch } from "./routes/agentic-search";
import { audit } from "./routes/audit";
import { lfs } from "./routes/lfs";
import { lfsLocks } from "./routes/lfs-locks";
import { lfsRest } from "./routes/lfs-rest";
import { semanticSearch } from "./routes/semantic-search";
import { semanticIndexRoutes } from "./routes/semantic-index";
import { graphRoutes } from "./routes/graph";
import { hybridSearchRoutes } from "./routes/hybrid-search";
import { forks } from "./routes/forks";
import { watch } from "./routes/watch";
import { prefetch } from "./routes/prefetch";
import { session } from "./routes/session";
import { admin } from "./routes/admin";
import { domains } from "./routes/domains";
import { setRepoCacheRef, setRepoHotDORef, setRefCacheKvRef, setObjCacheKvRef } from "./services/repo-resolver";
import type { Env, Variables } from "./types";

export const app = new Hono<{ Bindings: Env; Variables: Variables }>();

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

const DOMAIN_CACHE = new Map<string, { orgId: string; status: string; ts: number }>();
const DOMAIN_CACHE_TTL = 60_000;

// Matches preview-alias hosts produced by `wrangler versions upload
// --preview-alias`. The mandatory dash before `coregit-api` keeps the
// bare prod workers.dev URL (`coregit-api.<account>.workers.dev`) out
// of the trusted set — it'll still fall through to custom-domain
// lookup and return 421.
const PREVIEW_ALIAS_RE = /^[a-z0-9-]+-coregit-api\.[a-z0-9-]+\.workers\.dev$/;

app.use("*", async (c, next) => {
  const host = (c.req.header("host") || "").split(":")[0];

  if (
    host === "api.coregit.dev" ||
    host === "custom.coregit.dev" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    PREVIEW_ALIAS_RE.test(host)
  ) {
    c.set("customDomain", null);
    return next();
  }

  const cached = DOMAIN_CACHE.get(host);
  if (cached && Date.now() - cached.ts < DOMAIN_CACHE_TTL) {
    if (cached.status !== "active") {
      return c.text("Domain is not active", 403);
    }
    if (!dbConnectionString(c.env)) return c.text("Database not configured", 500);
    const db = createDb(dbConnectionString(c.env));
    c.set("db", db);
    c.set("orgId", cached.orgId);
    c.set("customDomain", host);
    const plan = await getOrgPlan(db, cached.orgId);
    c.set("orgTier", plan.tier);
    c.set("dodoCustomerId", plan.dodoCustomerId);
    c.set("planStatus", plan.status);
    return next();
  }

  if (!dbConnectionString(c.env)) return c.text("Database not configured", 500);
  const db = createDb(dbConnectionString(c.env));
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
  c.set("planStatus", plan.status);
  await next();
});

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
      const host = (c.req.header("host") || "").split(":")[0];
      if (origin === `https://${host}` && host !== "api.coregit.dev") {
        return origin;
      }
      if (
        c.env.ENVIRONMENT === "development" &&
        (origin?.startsWith("http://localhost:") ||
          origin?.startsWith("http://127.0.0.1:"))
      ) {
        return origin;
      }
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-session-id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: [
      "X-Request-Id",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "X-Org-RateLimit-Limit",
      "X-Org-RateLimit-Remaining",
      "Retry-After",
    ],
    maxAge: 86400,
  })
);

app.use("/v1/*", bodyLimit({ maxSize: 5 * 1024 * 1024 }));

app.get("/", (c) => {
  if (c.get("customDomain")) {
    return c.notFound();
  }
  return c.json({ name: "coregit-api", version: "0.1.0", status: "ok" });
});

app.get("/health", async (c) => {
  if (!dbConnectionString(c.env)) {
    return c.json({ status: "degraded", db: "not_configured" }, 503);
  }
  try {
    const db = createDb(dbConnectionString(c.env));
    await db.execute(sql`SELECT 1`);
    return c.json({ status: "ok", db: "ok" });
  } catch {
    return c.json({ status: "degraded", db: "unreachable" }, 503);
  }
});

app.use("/v1/*", async (c, next) => {
  if (!c.get("db")) {
    const connStr = dbConnectionString(c.env);
    if (!connStr) return c.json({ error: "Database not configured" }, 500);
    c.set("db", createDb(connStr));
  }
  setRepoCacheRef(c.env.AUTH_CACHE as KVNamespace | undefined);
  setRepoHotDORef(c.env.REPO_HOT_DO as DurableObjectNamespace | undefined);
  setRefCacheKvRef(c.env.AUTH_CACHE as KVNamespace | undefined);
  setObjCacheKvRef(c.env.GIT_OBJ_CACHE as KVNamespace | undefined);
  await next();
});

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
    if (!dbConnectionString(c.env)) return c.text("Database not configured", 500);
    c.set("db", createDb(dbConnectionString(c.env)));
  }
  await next();
});

app.use("/:org/:namespace/:repo/*", async (c, next) => {
  const orgParam = c.req.param("org");
  if (orgParam === "v1") return next();
  const repoParam = c.req.param("repo");
  if (!repoParam?.endsWith(".git") && !repoParam?.includes(".git/")) return next();
  if (!c.get("db")) {
    if (!dbConnectionString(c.env)) return c.text("Database not configured", 500);
    c.set("db", createDb(dbConnectionString(c.env)));
  }
  await next();
});

app.route("/", customDomainGit);

// LLM Wiki — forwarded to the adjacent private Worker via Service Binding.
// Cloudflare route rules can't wildcard mid-path (no "/repos/*/wiki/*"),
// so we catch these paths here and hand the raw Request to env.WIKI.
// When WIKI isn't bound (e.g. self-hosted deploys without the add-on),
// requests fall through to a 404 without leaking internals.
const WIKI_PATH_RE = /^\/v1\/repos\/[^/]+(?:\/[^/]+)?\/wiki(?:\/|$)/;
app.all("/v1/repos/:a/wiki/*", async (c) => forwardToWiki(c));
app.all("/v1/repos/:a/wiki", async (c) => forwardToWiki(c));
app.all("/v1/repos/:a/:b/wiki/*", async (c) => forwardToWiki(c));
app.all("/v1/repos/:a/:b/wiki", async (c) => forwardToWiki(c));
async function forwardToWiki(c: any): Promise<Response> {
  if (!WIKI_PATH_RE.test(new URL(c.req.url).pathname)) return c.json({ error: "Not found" }, 404);
  const wiki = (c.env as Env).WIKI;
  if (!wiki) return c.json({ error: "Wiki worker not configured" }, 503);
  return wiki.fetch(c.req.raw);
}

app.route("/v1/repos", branches);
app.route("/v1/repos", commits);
app.route("/v1/repos", files);
app.route("/v1/repos", diff);
app.route("/v1/repos", compare);
app.route("/v1/repos", cherryPick);
app.route("/v1/repos", refs);
app.route("/v1/repos", snapshots);
app.route("/v1/repos", lfsRest);
app.route("/v1/repos", workspace);
app.route("/v1/repos", sync);
app.route("/v1/repos", syncConfig);
app.route("/v1/repos", semanticSearch);
app.route("/v1/repos", graphRoutes);
app.route("/v1/repos", hybridSearchRoutes);
app.route("/v1/repos", agenticSearch);
app.route("/v1/repos", semanticIndexRoutes);
app.route("/v1/repos", forks);
app.route("/v1/repos", watch);
app.route("/v1/repos", prefetch);
app.route("/v1/repos", repos);
app.route("/v1", connections);
app.route("/v1", domains);
app.route("/v1", tokens);
app.route("/v1", webhooks);
app.route("/v1", search);
app.route("/v1", audit);

app.route("/v1", syncWebhooks);
app.route("/v1", session);
app.route("/v1", multiWorkspace);
app.route("/v1/admin", admin);
app.route("/v1/usage", usage);

app.route("/v1", publicRoutes);

app.route("/", lfs);
app.route("/", lfsLocks);

app.route("/", git);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  const requestId = c.get("requestId") || crypto.randomUUID().slice(0, 8);
  if (c.env.ENVIRONMENT === "development") {
    console.error(`[${requestId}] ${c.req.method} ${c.req.path}:`, err);
  } else {
    console.error(`[${requestId}] ${c.req.method} ${c.req.path}: ${err?.message || "Unknown error"}`);
  }
  return c.json({ error: "Internal server error", code: "INTERNAL_ERROR", request_id: requestId }, 500);
});
