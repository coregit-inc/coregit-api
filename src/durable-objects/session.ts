/**
 * Session Durable Object — Zero-Wait Git Protocol.
 *
 * Holds per-session auth state + pending git objects + pending ref updates.
 * Writes go to DO storage (~2ms) instead of R2 (~200-500ms).
 * Flush writes to R2 on session close or after 30min inactivity.
 *
 * Auth is checked once at session open. Subsequent requests with
 * X-Session-Id header validate against DO (<1ms warm) — no DB/KV auth.
 */

import { MAX_DO_VALUE_BYTES } from "../git/storage";

interface SessionMeta {
  orgId: string;
  apiKeyId: string;
  scopes: Record<string, string[]> | null;
  orgTier: "free" | "paid";
  dodoCustomerId: string | null;
  createdAt: number;
  lastActivityAt: number;
  closed: boolean;
  /** Configurable per-session TTL in ms. Defaults to 30 min if absent (legacy). */
  ttlMs?: number;
  /** When true (default), every authenticated request slides the expiry alarm. */
  idleExtend?: boolean;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const SESSION_TTL_CAP_MS_PAID = 8 * 60 * 60 * 1000; // 8 hours
export const SESSION_TTL_CAP_MS_FREE = 60 * 60 * 1000; // 1 hour
const MAX_PENDING_OBJECTS = 2000; // matches RepoHotDO; npm-init pushes routinely hit 500–1500
const FLUSH_BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 30_000; // auto-flush when buffer is filling during a long push
const FLUSH_TRIGGER_COUNT = 200;  // schedule an intermediate flush once buffer grows past this

export class SessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: any;
  private meta: SessionMeta | null = null;
  private objectCount = 0;
  private initialized = false;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.initialized) return;
    this.meta = (await this.state.storage.get("meta")) as SessionMeta | null;
    this.objectCount = ((await this.state.storage.get("objcount")) as number) ?? 0;
    this.initialized = true;
  }

  private get ttlMs(): number {
    return this.meta?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  private async touch(): Promise<void> {
    if (!this.meta) return;
    // Sessions opened with idle_extend:false keep a fixed expiry — only flush
    // alarms (intermediate, set elsewhere) move; lastActivityAt does not.
    if (this.meta.idleExtend === false) return;
    this.meta.lastActivityAt = Date.now();
    await this.state.storage.put("meta", this.meta);
    // Preserve any sooner alarm (e.g. a pending auto-flush). Only extend the alarm out
    // to the TTL horizon if no earlier alarm is already scheduled.
    const existing = await this.state.storage.getAlarm();
    const ttlAlarm = Date.now() + this.ttlMs;
    if (existing === null || existing > ttlAlarm) {
      this.state.storage.setAlarm(ttlAlarm);
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/open" && request.method === "POST") return this.handleOpen(request);
    if (path === "/validate") return this.handleValidate();
    if (path === "/put-object" && request.method === "POST") return this.handlePutObject(request, url);
    if (path === "/get-object") return this.handleGetObject(url);
    if (path === "/put-ref" && request.method === "POST") return this.handlePutRef(request);
    if (path === "/get-ref") return this.handleGetRef(url);
    if (path === "/status") return this.handleStatus();
    if (path === "/flush" && request.method === "POST") return this.handleFlush();
    if (path === "/close" && request.method === "POST") return this.handleClose();

    return new Response("Not found", { status: 404 });
  }

  // ── Open ──

  private async handleOpen(request: Request): Promise<Response> {
    if (this.meta && !this.meta.closed) {
      return Response.json({ error: "Session already open" }, { status: 409 });
    }

    const body = (await request.json()) as Omit<SessionMeta, "createdAt" | "lastActivityAt" | "closed">;
    const now = Date.now();

    // Caller-supplied ttlMs is already capped per tier in the route handler.
    const ttlMs = body.ttlMs && body.ttlMs > 0 ? body.ttlMs : DEFAULT_SESSION_TTL_MS;
    const idleExtend = body.idleExtend ?? true;

    this.meta = {
      orgId: body.orgId,
      apiKeyId: body.apiKeyId,
      scopes: body.scopes,
      orgTier: body.orgTier,
      dodoCustomerId: body.dodoCustomerId,
      createdAt: now,
      lastActivityAt: now,
      closed: false,
      ttlMs,
      idleExtend,
    };

    this.objectCount = 0;
    await this.state.storage.put("meta", this.meta);
    await this.state.storage.put("objcount", 0);
    this.state.storage.setAlarm(now + ttlMs);

    return Response.json({ ok: true, ttlMs, idleExtend });
  }

  // ── Validate ──

  private handleValidate(): Response {
    if (!this.meta || this.meta.closed) {
      return Response.json({ error: "Session expired or closed" }, { status: 401 });
    }

    if (Date.now() - this.meta.lastActivityAt > this.ttlMs) {
      return Response.json({ error: "Session expired" }, { status: 401 });
    }

    // Touch activity (fire-and-forget — don't block validate response)
    this.touch();

    return Response.json({
      orgId: this.meta.orgId,
      apiKeyId: this.meta.apiKeyId,
      scopes: this.meta.scopes,
      orgTier: this.meta.orgTier,
      dodoCustomerId: this.meta.dodoCustomerId,
    });
  }

  // ── Put Object ──

  private async handlePutObject(request: Request, url: URL): Promise<Response> {
    if (!this.meta || this.meta.closed) return Response.json({ error: "Session closed" }, { status: 410 });

    if (this.objectCount >= MAX_PENDING_OBJECTS) {
      return Response.json({ error: `Max ${MAX_PENDING_OBJECTS} pending objects per session` }, { status: 413 });
    }

    const sha = url.searchParams.get("sha");
    const repoKey = url.searchParams.get("repoKey");
    if (!sha || !repoKey) return Response.json({ error: "sha and repoKey required" }, { status: 400 });

    const data = new Uint8Array(await request.arrayBuffer());
    if (data.byteLength > MAX_DO_VALUE_BYTES) {
      // Oversized for legacy DO storage — caller writes straight to R2.
      return new Response(null, { status: 507 });
    }
    const storageKey = `obj:${repoKey}:${sha}`;

    // Check if already exists (dedup)
    const existing = await this.state.storage.get(storageKey);
    if (!existing) {
      await this.state.storage.put(storageKey, data);
      this.objectCount++;
      await this.state.storage.put("objcount", this.objectCount);
    }

    await this.touch();

    // Schedule an intermediate flush while the buffer is actively growing so long
    // pushes don't sit on thousands of objects in DO storage until /flush or TTL.
    if (this.objectCount >= FLUSH_TRIGGER_COUNT) {
      const existingAlarm = await this.state.storage.getAlarm();
      const flushAt = Date.now() + FLUSH_INTERVAL_MS;
      if (existingAlarm === null || existingAlarm > flushAt) {
        this.state.storage.setAlarm(flushAt);
      }
    }

    return new Response(null, { status: 202 });
  }

  // ── Get Object ──

  private async handleGetObject(url: URL): Promise<Response> {
    if (!this.meta || this.meta.closed) return Response.json({ error: "Session closed" }, { status: 410 });

    const sha = url.searchParams.get("sha");
    const repoKey = url.searchParams.get("repoKey");
    if (!sha || !repoKey) return Response.json({ error: "sha and repoKey required" }, { status: 400 });

    const data = await this.state.storage.get(`obj:${repoKey}:${sha}`) as Uint8Array | undefined;
    if (!data) return new Response(null, { status: 404 });

    await this.touch();
    return new Response(data, { headers: { "Content-Type": "application/octet-stream" } });
  }

  // ── Put Ref ──

  private async handlePutRef(request: Request): Promise<Response> {
    if (!this.meta || this.meta.closed) return Response.json({ error: "Session closed" }, { status: 410 });

    const body = (await request.json()) as { repoKey: string; refName: string; sha: string };
    await this.state.storage.put(`ref:${body.repoKey}:${body.refName}`, body.sha);

    await this.touch();
    return new Response(null, { status: 202 });
  }

  // ── Get Ref ──

  private async handleGetRef(url: URL): Promise<Response> {
    if (!this.meta || this.meta.closed) return Response.json({ error: "Session closed" }, { status: 410 });

    const repoKey = url.searchParams.get("repoKey");
    const refName = url.searchParams.get("refName");
    if (!repoKey || !refName) return Response.json({ error: "repoKey and refName required" }, { status: 400 });

    const sha = await this.state.storage.get(`ref:${repoKey}:${refName}`) as string | undefined;
    if (!sha) return new Response(null, { status: 404 });

    return Response.json({ sha });
  }

  // ── Status ──

  private handleStatus(): Response {
    if (!this.meta) return Response.json({ error: "No session" }, { status: 404 });

    return Response.json({
      objectCount: this.objectCount,
      createdAt: this.meta.createdAt,
      lastActivityAt: this.meta.lastActivityAt,
      closed: this.meta.closed,
      ttlMs: this.ttlMs - (Date.now() - this.meta.lastActivityAt),
    });
  }

  // ── Flush ──

  private async handleFlush(): Promise<Response> {
    if (!this.meta) return Response.json({ error: "No session" }, { status: 404 });

    const result = await this.flushToR2();
    return Response.json(result);
  }

  private async flushToR2(): Promise<{ flushedObjects: number; flushedRefs: number }> {
    const bucket = this.env.REPOS_BUCKET as R2Bucket;
    if (!bucket) throw new Error("REPOS_BUCKET not available in DO env");

    let flushedObjects = 0;
    let flushedRefs = 0;

    // Flush objects in parallel batches
    const allEntries = await this.state.storage.list({ prefix: "obj:" });
    const objEntries = [...allEntries.entries()] as [string, Uint8Array][];

    for (let i = 0; i < objEntries.length; i += FLUSH_BATCH_SIZE) {
      const batch = objEntries.slice(i, i + FLUSH_BATCH_SIZE);
      await Promise.all(
        batch.map(async ([key, compressed]) => {
          // key: "obj:{repoKey}:{sha}"
          const withoutPrefix = key.slice(4); // remove "obj:"
          const lastColon = withoutPrefix.lastIndexOf(":");
          const repoKey = withoutPrefix.slice(0, lastColon);
          const sha = withoutPrefix.slice(lastColon + 1);
          const r2Key = `${repoKey}/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
          await bucket.put(r2Key, compressed, {
            httpMetadata: { contentType: "application/x-git-object" },
          });
        })
      );
      flushedObjects += batch.length;
    }

    // Flush refs
    const refEntries = await this.state.storage.list({ prefix: "ref:" });
    for (const [key, sha] of refEntries) {
      // key: "ref:{repoKey}:{refName}"  e.g. "ref:orgId/repo:refs/heads/main"
      const withoutPrefix = key.slice(4); // remove "ref:"
      const firstColon = withoutPrefix.indexOf(":");
      const repoKey = withoutPrefix.slice(0, firstColon);
      const refName = withoutPrefix.slice(firstColon + 1);
      const r2Key = `${repoKey}/${refName}`;
      await bucket.put(r2Key, (sha as string) + "\n", {
        httpMetadata: { contentType: "text/plain" },
      });
      flushedRefs++;
    }

    // Clear all object and ref entries from DO storage
    const keysToDelete = [
      ...objEntries.map(([k]) => k),
      ...[...refEntries.keys()],
    ];
    if (keysToDelete.length > 0) {
      await this.state.storage.delete(keysToDelete);
    }

    this.objectCount = 0;
    await this.state.storage.put("objcount", 0);

    return { flushedObjects, flushedRefs };
  }

  // ── Close ──

  private async handleClose(): Promise<Response> {
    if (!this.meta) return Response.json({ error: "No session" }, { status: 404 });

    const result = await this.flushToR2();

    this.meta.closed = true;
    await this.state.storage.put("meta", this.meta);

    return Response.json({ status: "closed", ...result });
  }

  // ── Alarm (auto-expire) ──

  async alarm(): Promise<void> {
    await this.ensureLoaded();

    if (!this.meta || this.meta.closed) {
      await this.state.storage.deleteAll();
      return;
    }

    // Check if session is still active
    if (Date.now() - this.meta.lastActivityAt < this.ttlMs) {
      // Still active. If we've accumulated pending objects, flush them to R2 now
      // so a long push doesn't hold thousands of objects in DO storage waiting for
      // explicit /flush or /close. flushToR2 writes any pending refs too — benign
      // since refs are SHA pointers and will be re-written at /close.
      if (this.objectCount > 0) {
        try {
          await this.flushToR2();
        } catch (err) {
          console.error("Session intermediate flush failed:", err);
        }
      }
      // Reschedule the expiry alarm at the normal TTL horizon.
      this.state.storage.setAlarm(this.meta.lastActivityAt + this.ttlMs);
      return;
    }

    // Expired — flush and destroy
    try {
      await this.flushToR2();
    } catch (err) {
      console.error("Session auto-flush failed:", err);
    }

    this.meta.closed = true;
    await this.state.storage.put("meta", this.meta);
  }
}
