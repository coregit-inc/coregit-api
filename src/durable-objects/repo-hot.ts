/**
 * RepoHotDO — per-repo hot layer (Level 1: automatic for all requests).
 *
 * Every write goes to DO storage (~2ms) instead of R2 (~200-500ms).
 * Every read checks DO first, falls back to R2.
 * Alarm flushes pending objects/refs to R2 every 30 seconds.
 *
 * One DO instance per repo. Created automatically by repo-resolver.
 * No opt-in needed — all clients get faster writes for free.
 */

import { MAX_DO_VALUE_BYTES } from "../git/storage";

const FLUSH_INTERVAL_MS = 30_000; // flush to R2 every 30 seconds
const MAX_PENDING_OBJECTS = 2000;
const FLUSH_BATCH_SIZE = 20;
const PACK_LOCK_TTL_MS = 5 * 60 * 1000; // background repack lock — long enough for slow cron runs

export class RepoHotDO implements DurableObject {
  private state: DurableObjectState;
  private env: any;
  private objectCount = 0;
  private initialized = false;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.initialized) return;
    this.objectCount = ((await this.state.storage.get("objcount")) as number) ?? 0;
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/put-object" && request.method === "POST") return this.handlePutObject(request, url);
    if (path === "/get-object") return this.handleGetObject(url);
    if (path === "/put-ref" && request.method === "POST") return this.handlePutRef(request);
    if (path === "/get-ref") return this.handleGetRef(url);
    if (path === "/get-ref-versioned") return this.handleGetRefVersioned(url);
    if (path === "/cas-ref" && request.method === "POST") return this.handleCasRef(request);
    if (path === "/flush" && request.method === "POST") return this.handleFlush();
    if (path === "/status") return this.handleStatus();
    if (path === "/pack-lock" && request.method === "POST") return this.handlePackLock();
    if (path === "/pack-unlock" && request.method === "POST") return this.handlePackUnlock();

    return new Response("Not found", { status: 404 });
  }

  // ── Pack Lock ──
  // Serializes background repack runs for this repo. `packLooseObjects` is not
  // transactional (it writes pack+index, then deletes loose). Two concurrent runs
  // on the same repo would double-pack. Scheduled worker acquires the lock; if
  // already held, skips this repo for this tick.

  private async handlePackLock(): Promise<Response> {
    const now = Date.now();
    const expiresAt = (await this.state.storage.get("packLockExpiresAt")) as number | undefined;
    if (expiresAt && expiresAt > now) {
      return Response.json({ acquired: false, expiresAt });
    }
    const newExpiresAt = now + PACK_LOCK_TTL_MS;
    await this.state.storage.put("packLockExpiresAt", newExpiresAt);
    return Response.json({ acquired: true, expiresAt: newExpiresAt });
  }

  private async handlePackUnlock(): Promise<Response> {
    await this.state.storage.delete("packLockExpiresAt");
    return Response.json({ released: true });
  }

  // ── Put Object ──

  private async handlePutObject(request: Request, url: URL): Promise<Response> {
    if (this.objectCount >= MAX_PENDING_OBJECTS) {
      // Over limit — write directly to R2, skip hot layer
      return new Response(null, { status: 507 }); // Insufficient Storage → caller falls back to R2
    }

    const sha = url.searchParams.get("sha");
    const basePath = url.searchParams.get("basePath");
    if (!sha) return new Response("sha required", { status: 400 });

    // Store basePath on first write (DO needs it for R2 flush)
    if (basePath) {
      const stored = await this.state.storage.get("basePath");
      if (!stored) await this.state.storage.put("basePath", basePath);
    }

    const data = new Uint8Array(await request.arrayBuffer());
    if (data.byteLength > MAX_DO_VALUE_BYTES) {
      // Oversized for legacy DO storage — caller writes straight to R2.
      return new Response(null, { status: 507 });
    }
    const storageKey = `obj:${sha}`;

    // Dedup — content-addressed
    const existing = await this.state.storage.get(storageKey);
    if (!existing) {
      await this.state.storage.put(storageKey, data);
      this.objectCount++;
      await this.state.storage.put("objcount", this.objectCount);
    }

    // Schedule flush if not already scheduled
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }

    return new Response(null, { status: 202 });
  }

  // ── Get Object ──

  private async handleGetObject(url: URL): Promise<Response> {
    const sha = url.searchParams.get("sha");
    if (!sha) return new Response("sha required", { status: 400 });

    const data = await this.state.storage.get(`obj:${sha}`) as Uint8Array | undefined;
    if (!data) return new Response(null, { status: 404 });

    return new Response(data, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  // ── Put Ref ──

  private async handlePutRef(request: Request): Promise<Response> {
    const body = (await request.json()) as { refName: string; sha: string; treeSha?: string };
    const ver = ((await this.state.storage.get(`refver:${body.refName}`)) as number) ?? 0;
    const newVer = ver + 1;
    // Atomic batch: ref value + version + treeSha (if provided)
    const entries: Record<string, string | number> = {
      [`ref:${body.refName}`]: body.sha,
      [`refver:${body.refName}`]: newVer,
    };
    if (body.treeSha) entries[`reftree:${body.refName}`] = body.treeSha;
    await this.state.storage.put(entries);

    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }

    return new Response(null, { status: 202 });
  }

  // ── Get Ref ──

  private async handleGetRef(url: URL): Promise<Response> {
    const refName = url.searchParams.get("refName");
    if (!refName) return new Response("refName required", { status: 400 });

    const sha = await this.state.storage.get(`ref:${refName}`) as string | undefined;
    if (!sha) return new Response(null, { status: 404 });

    return Response.json({ sha });
  }

  // ── Get Ref Versioned (for DO-based CAS) ──

  private async handleGetRefVersioned(url: URL): Promise<Response> {
    const refName = url.searchParams.get("refName");
    if (!refName) return new Response("refName required", { status: 400 });

    const sha = await this.state.storage.get(`ref:${refName}`) as string | undefined;
    if (!sha) return new Response(null, { status: 404 });

    const version = ((await this.state.storage.get(`refver:${refName}`)) as number) ?? 0;
    const treeSha = (await this.state.storage.get(`reftree:${refName}`)) as string | undefined;

    return Response.json({ sha, version, treeSha });
  }

  // ── CAS Ref (compare-and-swap via DO single-thread) ──

  private async handleCasRef(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      refName: string;
      newSha: string;
      expectedVersion: number;
      treeSha?: string;
      basePath?: string;
    };

    // Store basePath on first write (needed for R2 flush)
    if (body.basePath) {
      const stored = await this.state.storage.get("basePath");
      if (!stored) await this.state.storage.put("basePath", body.basePath);
    }

    const currentVersion = ((await this.state.storage.get(`refver:${body.refName}`)) as number) ?? 0;
    if (currentVersion !== body.expectedVersion) {
      return Response.json({ ok: false, currentVersion }, { status: 409 });
    }

    const newVer = currentVersion + 1;
    const entries: Record<string, string | number> = {
      [`ref:${body.refName}`]: body.newSha,
      [`refver:${body.refName}`]: newVer,
    };
    if (body.treeSha) entries[`reftree:${body.refName}`] = body.treeSha;
    await this.state.storage.put(entries);

    // Fire-and-forget R2 write for durability
    const basePath = (await this.state.storage.get("basePath")) as string | undefined;
    if (basePath) {
      const bucket = this.env.REPOS_BUCKET as R2Bucket;
      if (bucket) {
        const r2Key = `${basePath}/${body.refName}`;
        bucket.put(r2Key, body.newSha + "\n", {
          httpMetadata: { contentType: "text/plain" },
          customMetadata: body.treeSha ? { treeSha: body.treeSha } : undefined,
        }).catch(() => {});
      }
    }

    // Schedule flush alarm for remaining objects
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }

    return Response.json({ ok: true, version: newVer });
  }

  // ── Status ──

  private handleStatus(): Response {
    return Response.json({
      objectCount: this.objectCount,
      maxObjects: MAX_PENDING_OBJECTS,
      flushIntervalMs: FLUSH_INTERVAL_MS,
    });
  }

  // ── Flush (alarm-triggered or explicit) ──

  private async handleFlush(): Promise<Response> {
    const result = await this.flushToR2();
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (this.objectCount === 0) {
      return; // no pending objects to flush (refs stay cached in DO)
    }

    try {
      await this.flushToR2();
    } catch (err) {
      console.error("RepoHotDO flush failed:", err);
      // Reschedule to retry
      this.state.storage.setAlarm(Date.now() + 10_000);
    }
  }

  private async flushToR2(): Promise<{ flushedObjects: number; flushedRefs: number }> {
    const bucket = this.env.REPOS_BUCKET as R2Bucket;
    if (!bucket) throw new Error("REPOS_BUCKET not available");

    // We need the repo's R2 base path. It's encoded in the DO name (set by repo-resolver).
    // DO name format: "{orgId}/{repoStorageSuffix}"
    // But DOs don't know their own name. We store the basePath on first put.
    const basePath = await this.state.storage.get("basePath") as string | undefined;
    if (!basePath) {
      // No basePath stored yet — nothing was written through the proper flow
      return { flushedObjects: 0, flushedRefs: 0 };
    }

    let flushedObjects = 0;
    let flushedRefs = 0;

    // Flush objects
    const objEntries = await this.state.storage.list({ prefix: "obj:" });
    const objArray = [...objEntries.entries()] as [string, Uint8Array][];

    for (let i = 0; i < objArray.length; i += FLUSH_BATCH_SIZE) {
      const batch = objArray.slice(i, i + FLUSH_BATCH_SIZE);
      await Promise.all(
        batch.map(async ([key, compressed]) => {
          const sha = key.slice(4); // remove "obj:"
          const r2Key = `${basePath}/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
          await bucket.put(r2Key, compressed, {
            httpMetadata: { contentType: "application/x-git-object" },
          });
        })
      );
      flushedObjects += batch.length;
    }

    // Flush refs (keep in DO as cache — refs are tiny, serve as read-through cache)
    const refEntries = await this.state.storage.list({ prefix: "ref:" });
    for (const [key, sha] of refEntries) {
      const refName = key.slice(4); // remove "ref:"
      const r2Key = `${basePath}/${refName}`;
      // Include treeSha in R2 customMetadata if available
      const treeSha = (await this.state.storage.get(`reftree:${refName}`)) as string | undefined;
      await bucket.put(r2Key, (sha as string) + "\n", {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: treeSha ? { treeSha } : undefined,
      });
      flushedRefs++;
    }

    // Clear flushed entries (only objects — refs stay as cache for fast DO reads)
    const keysToDelete = [
      ...objArray.map(([k]) => k),
    ];
    if (keysToDelete.length > 0) {
      await this.state.storage.delete(keysToDelete);
    }

    this.objectCount = 0;
    await this.state.storage.put("objcount", 0);

    return { flushedObjects, flushedRefs };
  }
}
