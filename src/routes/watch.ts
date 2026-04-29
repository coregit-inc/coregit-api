/**
 * SSE branch watcher.
 *
 * GET /v1/repos/:slug/watch?branch=main
 *
 * Emits `connected` once on subscribe, then `commit` events whenever the
 * branch tip moves, plus `:keepalive` comments every 20 s so HTTP/2 idle
 * timeouts and CDN buffers stay open. Connection self-terminates after
 * roughly 25 s of wall-clock — clients reconnect (the SDK iterator does
 * this automatically).
 *
 * Implementation: lightweight polling against the existing ref resolver.
 * No DO subscriber list yet; if traffic warrants it we'll switch to a
 * push from RepoHotDO's flush path.
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { resolveRef } from "./files";
import type { Env, Variables } from "../types";

const watch = new Hono<{ Bindings: Env; Variables: Variables }>();

const POLL_INTERVAL_MS = 2_000;
const KEEPALIVE_INTERVAL_MS = 20_000;
const MAX_CONNECTION_MS = 25_000;

const watchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);
  if (c.get("sessionStub")) resolved.storage.setSessionStub(c.get("sessionStub") as DurableObjectStub);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;
  const branch = c.req.query("branch") || found.defaultBranch;

  // Resolve initial sha synchronously so connect-time errors propagate.
  const initialSha = await resolveRef(storage, branch);
  if (!initialSha) {
    return c.json({ error: `Branch "${branch}" not found` }, 404);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let lastSha = initialSha;
      let lastKeepalive = Date.now();
      let closed = false;

      const enqueue = (data: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(data)); }
        catch { closed = true; }
      };

      enqueue(`event: connected\ndata: ${JSON.stringify({ sha: lastSha, branch })}\n\n`);

      while (!closed && Date.now() - startedAt < MAX_CONNECTION_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (closed) break;

        let curSha: string | null;
        try {
          curSha = await resolveRef(storage, branch);
        } catch {
          curSha = lastSha;
        }
        if (curSha && curSha !== lastSha) {
          enqueue(`event: commit\ndata: ${JSON.stringify({ sha: curSha, branch, ts: Date.now() })}\n\n`);
          lastSha = curSha;
        }
        if (Date.now() - lastKeepalive > KEEPALIVE_INTERVAL_MS) {
          enqueue(`: keepalive\n\n`);
          lastKeepalive = Date.now();
        }
      }
      // Tell the client the window closed cleanly; SDK auto-reconnects.
      enqueue(`event: rotate\ndata: ${JSON.stringify({ sha: lastSha, ts: Date.now() })}\n\n`);
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() {
      // Client disconnected — loop checks `closed` indirectly via enqueue throw.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};

watch.get("/:slug/watch", apiKeyAuth, watchHandler);
watch.get("/:namespace/:slug/watch", apiKeyAuth, watchHandler);

export { watch };
