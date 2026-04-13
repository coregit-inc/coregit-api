/**
 * Git R2 Storage Layer
 *
 * R2 Key Structure (dual-mode: loose + packfiles):
 * {userId}/{repo}/
 * ├── objects/                      # legacy loose objects (zlib-compressed)
 * │   └── {sha[0:2]}/{sha[2:40]}
 * ├── pack/                         # packfiles (fewer R2 keys, scalable)
 * │   ├── {packId}.pack
 * │   └── {packId}.idx
 * ├── refs/
 * │   ├── heads/
 * │   │   └── main
 * │   └── tags/
 * │       └── v1.0
 * └── HEAD
 *
 * Object lookup order: in-memory cache → loose → pack indices → R2 pack
 * New writes go to loose. Packing triggered when loose count > PACK_THRESHOLD.
 */

import { createGitObjectRaw, type GitObjectType } from "./objects";
import { zlibSync, unzlibSync } from "fflate";
import { isValidSha } from "./validation";
import { createMinimalPack, readFromPack, type PackIndex } from "./pack-storage";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PACK_THRESHOLD = 256; // pack loose objects when count exceeds this

export class GitR2Storage {
  private bucket: R2Bucket;
  private basePath: string;
  private _objectCache: Map<string, Uint8Array> = new Map();
  private _cacheBytes = 0;
  private static readonly MAX_CACHE_BYTES = 32 * 1024 * 1024; // 32 MB per request

  /** KV namespace for caching pack indices (set externally) */
  private _packIndexKv: KVNamespace | undefined;
  /** Loaded pack indices for this request */
  private _packIndices: PackIndex[] | null = null;
  /** Edge cache for immutable git objects (Cache API, per-colo, <5ms) */
  private _edgeCache: Cache | undefined;
  /** Session stub for Zero-Wait hot layer reads/writes (Level 2) */
  private _sessionStub: DurableObjectStub | undefined;
  /** Per-repo hot layer DO stub (Level 1: automatic for all) */
  private _repoDOStub: DurableObjectStub | undefined;
  /** Base URL for edge cache keys */
  private static readonly CACHE_BASE = "https://cache.coregit.internal";

  constructor(bucket: R2Bucket, userId: string, repo: string) {
    this.bucket = bucket;
    this.basePath = `${userId}/${repo}`;
    // Cache API is available globally in Workers
    try { this._edgeCache = caches.default; } catch { /* not available in tests */ }
  }

  setPackIndexKv(kv: KVNamespace | undefined) {
    this._packIndexKv = kv;
  }

  setSessionStub(stub: DurableObjectStub | undefined) {
    this._sessionStub = stub;
  }

  setRepoDOStub(stub: DurableObjectStub, _basePath: string) {
    this._repoDOStub = stub;
  }

  /** Get the active hot layer stub — session (Level 2) takes priority over repo DO (Level 1) */
  private get _hotStub(): DurableObjectStub | undefined {
    return this._sessionStub || this._repoDOStub;
  }

  // ============ Object Operations ============

  /**
   * Get a git object by SHA.
   * Lookup order: in-memory → edge cache (Cache API, <5ms) → loose R2 → packfiles.
   * Git objects are content-addressed (SHA = hash of content) → truly immutable → cache forever.
   */
  async getObject(sha: string): Promise<Uint8Array | null> {
    // 1. In-memory cache hit (per-request)
    const cached = this._objectCache.get(sha);
    if (cached) return cached;

    // 2. Edge cache hit (per-colo, <5ms vs R2 200-500ms)
    const edgeCacheKey = `${GitR2Storage.CACHE_BASE}/${this.basePath}/objects/${sha}`;
    if (this._edgeCache) {
      const edgeHit = await this._edgeCache.match(edgeCacheKey);
      if (edgeHit) {
        const data = new Uint8Array(await edgeHit.arrayBuffer());
        this._addToCache(sha, data);
        return data;
      }
    }

    // 3. Hot layer — RepoDO (Level 1, all requests) or SessionDO (Level 2)
    const hotStub = this._hotStub;
    if (hotStub) {
      const hotUrl = this._sessionStub
        ? `https://session/get-object?sha=${sha}&repoKey=${encodeURIComponent(this.basePath)}`
        : `https://repo-hot/get-object?sha=${sha}`;
      const hotRes = await hotStub.fetch(hotUrl);
      if (hotRes.ok) {
        const compressed = new Uint8Array(await hotRes.arrayBuffer());
        const result = this._decompressAndCache(sha, compressed);
        return result;
      }
    }

    // 4. Try loose object in R2
    const key = this.objectKey(sha);
    const looseObj = await this.bucket.get(key);

    if (looseObj) {
      const result = this._decompressAndCache(sha, new Uint8Array(await looseObj.arrayBuffer()));
      this._putEdgeCache(edgeCacheKey, result);
      return result;
    }

    // 4. Try packfiles
    const packResult = await this._getFromPacks(sha);
    if (packResult) {
      const { type, data } = packResult;
      const fullObject = createGitObjectRaw(type, data);
      this._addToCache(sha, fullObject);
      this._putEdgeCache(edgeCacheKey, fullObject);
      return fullObject;
    }

    return null;
  }

  /** Store in edge cache (fire-and-forget). Git objects are immutable — cache 1 year. */
  private _putEdgeCache(cacheKey: string, data: Uint8Array): void {
    if (!this._edgeCache) return;
    const response = new Response(data, {
      headers: {
        "Cache-Control": "public, s-maxage=31536000, immutable",
        "Content-Type": "application/x-git-object",
        "Content-Length": String(data.byteLength),
      },
    });
    // fire-and-forget — don't block on cache write
    this._edgeCache.put(cacheKey, response).catch(() => {});
  }

  private _decompressAndCache(sha: string, compressed: Uint8Array): Uint8Array {
    const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024; // 100 MB
    let result: Uint8Array;
    try {
      result = unzlibSync(compressed);
    } catch {
      result = compressed;
    }

    if (result.byteLength > MAX_DECOMPRESSED_SIZE) {
      throw new Error(`Git object exceeds ${MAX_DECOMPRESSED_SIZE} byte decompression limit`);
    }

    this._addToCache(sha, result);
    return result;
  }

  private _addToCache(sha: string, data: Uint8Array) {
    this._cacheBytes += data.length;
    if (this._cacheBytes > GitR2Storage.MAX_CACHE_BYTES) {
      const iter = this._objectCache.keys();
      while (this._cacheBytes > GitR2Storage.MAX_CACHE_BYTES / 2) {
        const key = iter.next().value;
        if (!key) break;
        this._cacheBytes -= this._objectCache.get(key)!.length;
        this._objectCache.delete(key);
      }
    }
    this._objectCache.set(sha, data);
  }

  /**
   * Look up a SHA in loaded pack indices, fetch from R2 pack if found.
   */
  private async _getFromPacks(sha: string): Promise<{ type: GitObjectType; data: Uint8Array } | null> {
    const indices = await this._loadPackIndices();
    for (const idx of indices) {
      const entry = idx.entries[sha];
      if (!entry) continue;

      // Fetch the pack from R2
      const packKey = `${this.basePath}/pack/${idx.packSha}.pack`;
      const packObj = await this.bucket.get(packKey);
      if (!packObj) continue;

      const packData = new Uint8Array(await packObj.arrayBuffer());
      return readFromPack(packData, entry.offset);
    }
    return null;
  }

  /**
   * Load all pack indices for this repo. Cached per-request in memory,
   * and in KV (immutable — pack SHA is content-addressed).
   */
  private async _loadPackIndices(): Promise<PackIndex[]> {
    if (this._packIndices !== null) return this._packIndices;

    // List pack index files in R2
    const prefix = `${this.basePath}/pack/`;
    const listed = await this.bucket.list({ prefix, limit: 100 });
    const idxKeys = listed.objects
      .filter((o) => o.key.endsWith(".idx"))
      .map((o) => o.key);

    if (idxKeys.length === 0) {
      this._packIndices = [];
      return [];
    }

    const indices: PackIndex[] = [];
    const kv = this._packIndexKv;

    for (const idxKey of idxKeys) {
      const packSha = idxKey.slice(prefix.length, -4); // remove prefix and .idx

      // Try KV cache first
      if (kv) {
        const cached = await kv.get(`packidx:${this.basePath}/${packSha}`, "json") as PackIndex | null;
        if (cached) {
          indices.push(cached);
          continue;
        }
      }

      // Load from R2
      const idxObj = await this.bucket.get(idxKey);
      if (!idxObj) continue;

      const idxData = JSON.parse(await idxObj.text()) as PackIndex;
      indices.push(idxData);

      // Cache in KV (immutable — no TTL)
      if (kv) {
        kv.put(`packidx:${this.basePath}/${packSha}`, JSON.stringify(idxData)).catch(() => {});
      }
    }

    this._packIndices = indices;
    return indices;
  }

  /**
   * Store a git object by SHA
   * Compresses the object data before storing
   */
  async putObject(sha: string, type: GitObjectType, content: Uint8Array): Promise<void> {
    // Skip write if already in memory cache (content-addressed = idempotent)
    if (this._objectCache.has(sha)) return;

    const fullObject = createGitObjectRaw(type, content);
    const compressed = zlibSync(fullObject);

    // Hot layer — RepoDO (Level 1) or SessionDO (Level 2). ~2ms vs R2 200-500ms.
    const hotStub = this._hotStub;
    if (hotStub) {
      const hotUrl = this._sessionStub
        ? `https://session/put-object?sha=${sha}&repoKey=${encodeURIComponent(this.basePath)}`
        : `https://repo-hot/put-object?sha=${sha}&basePath=${encodeURIComponent(this.basePath)}`;
      const res = await hotStub.fetch(hotUrl, { method: "POST", body: compressed });
      if (res.status === 202) {
        this._addToCache(sha, fullObject);
        return;
      }
      // 507 = DO full, fall through to R2
    }

    // Cold path — direct R2 write
    const key = this.objectKey(sha);
    await this.bucket.put(key, compressed, {
      httpMetadata: { contentType: "application/x-git-object" },
    });
  }

  /**
   * Store a raw (already formatted) git object
   */
  async putObjectRaw(sha: string, data: Uint8Array): Promise<void> {
    const key = this.objectKey(sha);

    // Compress using sync zlibSync (faster than async CompressionStream)
    const compressed = zlibSync(data);

    await this.bucket.put(key, compressed, {
      httpMetadata: { contentType: "application/x-git-object" },
    });
  }

  /**
   * Check if an object exists
   */
  async hasObject(sha: string): Promise<boolean> {
    const key = this.objectKey(sha);
    const obj = await this.bucket.head(key);
    return obj !== null;
  }

  /**
   * Store multiple objects in parallel batches
   */
  async putObjectBatch(
    objects: { sha: string; type: GitObjectType; data: Uint8Array }[],
    batchSize = 20
  ): Promise<void> {
    for (let i = 0; i < objects.length; i += batchSize) {
      const batch = objects.slice(i, i + batchSize);
      await Promise.all(
        batch.map((obj) => this.putObject(obj.sha, obj.type, obj.data))
      );
    }
  }

  /**
   * Fetch multiple objects in parallel batches
   */
  async getObjectBatch(
    shas: string[],
    batchSize = 20
  ): Promise<Map<string, Uint8Array>> {
    const results = new Map<string, Uint8Array>();
    for (let i = 0; i < shas.length; i += batchSize) {
      const batch = shas.slice(i, i + batchSize);
      const entries = await Promise.all(
        batch.map(async (sha) => {
          const data = await this.getObject(sha);
          return [sha, data] as const;
        })
      );
      for (const [sha, data] of entries) {
        if (data) results.set(sha, data);
      }
    }
    return results;
  }

  /**
   * List all object SHAs (for packfile generation)
   */
  async listObjects(): Promise<string[]> {
    const prefix = `${this.basePath}/objects/`;
    const shas: string[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({ prefix, cursor });

      for (const obj of listed.objects) {
        // Extract SHA from key: objects/ab/cdef1234...
        const parts = obj.key.slice(prefix.length).split("/");
        if (parts.length === 2 && parts[0].length === 2 && parts[1].length === 38) {
          shas.push(parts[0] + parts[1]);
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return shas;
  }

  // ============ Pack Operations ============

  /**
   * Pack all loose objects into a single packfile.
   * 1. List all loose objects
   * 2. Read each, create minimal pack
   * 3. Upload pack + JSON index to R2
   * 4. Delete loose objects
   * 5. Cache index in KV
   */
  async packLooseObjects(): Promise<{ packed: number; packSha: string } | null> {
    const prefix = `${this.basePath}/objects/`;
    const allKeys: string[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({ prefix, cursor });
      for (const obj of listed.objects) {
        if (obj.key.endsWith(".gitkeep")) continue;
        const parts = obj.key.slice(prefix.length).split("/");
        if (parts.length === 2 && parts[0].length === 2 && parts[1].length === 38) {
          allKeys.push(obj.key);
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    if (allKeys.length < 2) return null; // not worth packing 0-1 objects

    // Read all loose objects
    const objects: { sha: string; type: GitObjectType; data: Uint8Array }[] = [];
    const BATCH = 20;

    for (let i = 0; i < allKeys.length; i += BATCH) {
      const batch = allKeys.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (key) => {
          const sha = key.slice(prefix.length).replace("/", "");
          const obj = await this.bucket.get(key);
          if (!obj) return null;

          const compressed = new Uint8Array(await obj.arrayBuffer());
          let decompressed: Uint8Array;
          try {
            decompressed = unzlibSync(compressed);
          } catch {
            decompressed = compressed;
          }

          // Parse git object header to get type
          const { parseGitObject } = await import("./objects");
          const parsed = parseGitObject(decompressed);

          return { sha, type: parsed.type as GitObjectType, data: parsed.content };
        })
      );

      for (const r of results) {
        if (r) objects.push(r);
      }
    }

    if (objects.length === 0) return null;

    // Create packfile
    const { pack, index } = await createMinimalPack(objects);

    // Upload pack + index to R2
    const packKey = `${this.basePath}/pack/${index.packSha}.pack`;
    const idxKey = `${this.basePath}/pack/${index.packSha}.idx`;

    await Promise.all([
      this.bucket.put(packKey, pack, {
        httpMetadata: { contentType: "application/x-git-pack" },
      }),
      this.bucket.put(idxKey, JSON.stringify(index), {
        httpMetadata: { contentType: "application/json" },
      }),
    ]);

    // Cache index in KV
    if (this._packIndexKv) {
      await this._packIndexKv.put(
        `packidx:${this.basePath}/${index.packSha}`,
        JSON.stringify(index)
      ).catch(() => {});
    }

    // Delete loose objects in parallel batches
    for (let i = 0; i < allKeys.length; i += BATCH) {
      const batch = allKeys.slice(i, i + BATCH);
      await Promise.all(batch.map((key) => this.bucket.delete(key)));
    }

    // Reset pack indices cache (new pack added)
    this._packIndices = null;

    return { packed: objects.length, packSha: index.packSha };
  }

  // ============ Reference Operations ============

  /**
   * Get a reference (e.g., refs/heads/main)
   * Returns the SHA it points to or null if not found
   */
  async getRef(name: string): Promise<string | null> {
    // Hot layer first (pending ref updates)
    const hotStub = this._hotStub;
    if (hotStub) {
      const hotUrl = this._sessionStub
        ? `https://session/get-ref?repoKey=${encodeURIComponent(this.basePath)}&refName=${encodeURIComponent(name)}`
        : `https://repo-hot/get-ref?refName=${encodeURIComponent(name)}`;
      const res = await hotStub.fetch(hotUrl);
      if (res.ok) {
        const { sha } = (await res.json()) as { sha: string };
        return sha;
      }
    }

    // R2 cold storage
    const key = `${this.basePath}/${name}`;
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return (await obj.text()).trim();
  }

  /**
   * Set a reference to point to a SHA
   */
  async setRef(name: string, sha: string): Promise<void> {
    const hotStub = this._hotStub;
    if (hotStub) {
      const hotUrl = this._sessionStub
        ? "https://session/put-ref"
        : "https://repo-hot/put-ref";
      const body = this._sessionStub
        ? JSON.stringify({ repoKey: this.basePath, refName: name, sha })
        : JSON.stringify({ refName: name, sha });
      await hotStub.fetch(hotUrl, { method: "POST", body });
      return;
    }

    const key = `${this.basePath}/${name}`;
    await this.bucket.put(key, sha + "\n", {
      httpMetadata: { contentType: "text/plain" },
    });
  }

  /**
   * Get a reference along with its R2 etag (for conditional updates).
   * Returns null if the ref doesn't exist.
   */
  async getRefWithEtag(name: string): Promise<{ sha: string; etag: string } | null> {
    const key = `${this.basePath}/${name}`;
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const sha = (await obj.text()).trim();
    return { sha, etag: obj.etag };
  }

  /**
   * Conditionally set a reference using R2 etag compare-and-swap.
   * Only writes if the current object's etag matches expectedEtag.
   * Returns true if the write succeeded, false if CAS failed (concurrent update).
   */
  async setRefConditional(name: string, sha: string, expectedEtag: string): Promise<boolean> {
    const key = `${this.basePath}/${name}`;
    const result = await this.bucket.put(key, sha + "\n", {
      httpMetadata: { contentType: "text/plain" },
      onlyIf: { etagMatches: expectedEtag },
    });
    return result !== null;
  }

  /**
   * Delete a reference
   */
  async deleteRef(name: string): Promise<void> {
    const key = `${this.basePath}/${name}`;
    await this.bucket.delete(key);
  }

  /**
   * List all references with their SHAs
   */
  async listRefs(): Promise<Map<string, string>> {
    const refs = new Map<string, string>();
    const prefix = `${this.basePath}/refs/`;
    const allKeys: string[] = [];
    let cursor: string | undefined;

    // 1. Collect all keys (with pagination)
    do {
      const listed = await this.bucket.list({ prefix, cursor });
      for (const obj of listed.objects) {
        if (!obj.key.endsWith(".gitkeep")) allKeys.push(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    // 2. Fetch all ref values in parallel
    const entries = await Promise.all(
      allKeys.map(async (key) => {
        const refObj = await this.bucket.get(key);
        if (!refObj) return null;
        const sha = (await refObj.text()).trim();
        if (sha.length !== 40) return null;
        return [key.slice(this.basePath.length + 1), sha] as [string, string];
      })
    );

    for (const entry of entries) {
      if (entry) refs.set(entry[0], entry[1]);
    }
    return refs;
  }

  /**
   * Get HEAD reference
   * Returns either a ref name (e.g., "refs/heads/main") or a SHA
   */
  async getHead(): Promise<{ type: "ref" | "sha"; value: string } | null> {
    const key = `${this.basePath}/HEAD`;
    const obj = await this.bucket.get(key);

    if (!obj) {
      return null;
    }

    const content = (await obj.text()).trim();

    if (content.startsWith("ref: ")) {
      return { type: "ref", value: content.slice(5) };
    }

    return { type: "sha", value: content };
  }

  /**
   * Resolve HEAD to its actual SHA
   */
  async resolveHead(): Promise<string | null> {
    const head = await this.getHead();

    if (!head) {
      return null;
    }

    if (head.type === "sha") {
      return head.value;
    }

    // Follow the ref
    return this.getRef(head.value);
  }

  /**
   * Set HEAD to point to a ref
   */
  async setHead(ref: string): Promise<void> {
    const key = `${this.basePath}/HEAD`;
    await this.bucket.put(key, `ref: ${ref}\n`, {
      httpMetadata: { contentType: "text/plain" },
    });
  }

  /**
   * Set HEAD to a direct SHA (detached HEAD)
   */
  async setHeadDetached(sha: string): Promise<void> {
    const key = `${this.basePath}/HEAD`;
    await this.bucket.put(key, sha + "\n", {
      httpMetadata: { contentType: "text/plain" },
    });
  }

  // ============ Repository Operations ============

  /**
   * Initialize an empty repository
   */
  async initRepo(defaultBranch: string = "main"): Promise<void> {
    // Create HEAD pointing to default branch
    await this.setHead(`refs/heads/${defaultBranch}`);

    // Create placeholder files for directory structure
    await this.bucket.put(`${this.basePath}/refs/heads/.gitkeep`, "", {
      httpMetadata: { contentType: "text/plain" },
    });

    await this.bucket.put(`${this.basePath}/refs/tags/.gitkeep`, "", {
      httpMetadata: { contentType: "text/plain" },
    });

    await this.bucket.put(`${this.basePath}/objects/.gitkeep`, "", {
      httpMetadata: { contentType: "text/plain" },
    });
  }

  /**
   * Check if repository exists
   */
  async exists(): Promise<boolean> {
    const key = `${this.basePath}/HEAD`;
    const obj = await this.bucket.head(key);
    return obj !== null;
  }

  // ============ Copy Operations ============

  /**
   * Copy all R2 objects, refs, and HEAD from one repo path to another.
   * Used for forking templates.
   */
  static async copyRepo(
    bucket: R2Bucket,
    sourceBasePath: string,
    targetBasePath: string
  ): Promise<{ count: number }> {
    const prefix = `${sourceBasePath}/`;
    const allKeys: string[] = [];
    let cursor: string | undefined;

    // 1. List all keys under source
    do {
      const listed = await bucket.list({ prefix, cursor });
      for (const obj of listed.objects) {
        allKeys.push(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    // 2. Copy in parallel batches
    // CF Workers limits concurrent subrequests to 6. Each copy = get+put = 2 subrequests,
    // so effective concurrency is ~3 copies. Batch size of 10 keeps the pipeline full
    // without excessive queuing.
    const BATCH_SIZE = 10;
    let copied = 0;

    for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
      const batch = allKeys.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (key) => {
          const obj = await bucket.get(key);
          if (!obj) return;
          const targetKey = `${targetBasePath}/${key.slice(prefix.length)}`;
          await bucket.put(targetKey, obj.body, {
            httpMetadata: obj.httpMetadata,
          });
          copied++;
        })
      );
    }

    return { count: copied };
  }

  // ============ Private Helpers ============

  private objectKey(sha: string): string {
    if (!isValidSha(sha)) {
      throw new Error(`Invalid SHA: ${sha}`);
    }
    return `${this.basePath}/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
  }
}
