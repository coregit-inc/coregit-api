/**
 * Git R2 Storage Layer
 *
 * R2 Key Structure:
 * {userId}/{repo}/
 * ├── objects/
 * │   └── {sha[0:2]}/{sha[2:40]}  # loose objects (zlib-compressed)
 * ├── refs/
 * │   ├── heads/
 * │   │   └── main                 # SHA + newline
 * │   └── tags/
 * │       └── v1.0                 # SHA + newline
 * ├── HEAD                         # "ref: refs/heads/main\n"
 * └── pack/                        # Future: packfiles
 */

import { createGitObjectRaw, type GitObjectType } from "./objects";
import { zlibSync, unzlibSync } from "fflate";
import { isValidSha } from "./validation";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class GitR2Storage {
  private bucket: R2Bucket;
  private basePath: string;
  private _objectCache: Map<string, Uint8Array> = new Map();
  private _cacheBytes = 0;
  private static readonly MAX_CACHE_BYTES = 32 * 1024 * 1024; // 32 MB per request

  constructor(bucket: R2Bucket, userId: string, repo: string) {
    this.bucket = bucket;
    this.basePath = `${userId}/${repo}`;
  }

  // ============ Object Operations ============

  /**
   * Get a git object by SHA
   * Returns decompressed object data or null if not found
   */
  async getObject(sha: string): Promise<Uint8Array | null> {
    // Cache hit — skip R2 entirely
    const cached = this._objectCache.get(sha);
    if (cached) return cached;

    const key = this.objectKey(sha);
    const obj = await this.bucket.get(key);

    if (!obj) {
      return null;
    }

    const compressed = new Uint8Array(await obj.arrayBuffer());

    // Decompress using sync unzlibSync — matches zlibSync format, no async overhead
    const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024; // 100 MB
    let result: Uint8Array;
    try {
      result = unzlibSync(compressed);
    } catch {
      // If decompression fails, return raw (might be uncompressed)
      result = compressed;
    }

    if (result.byteLength > MAX_DECOMPRESSED_SIZE) {
      throw new Error(`Git object exceeds ${MAX_DECOMPRESSED_SIZE} byte decompression limit`);
    }

    // Populate cache with simple size-based eviction
    this._cacheBytes += result.length;
    if (this._cacheBytes > GitR2Storage.MAX_CACHE_BYTES) {
      // Evict oldest half
      const iter = this._objectCache.keys();
      while (this._cacheBytes > GitR2Storage.MAX_CACHE_BYTES / 2) {
        const key = iter.next().value;
        if (!key) break;
        this._cacheBytes -= this._objectCache.get(key)!.length;
        this._objectCache.delete(key);
      }
    }
    this._objectCache.set(sha, result);

    return result;
  }

  /**
   * Store a git object by SHA
   * Compresses the object data before storing
   */
  async putObject(sha: string, type: GitObjectType, content: Uint8Array): Promise<void> {
    // Skip R2 write if already in memory cache (content-addressed = idempotent)
    if (this._objectCache.has(sha)) return;

    const key = this.objectKey(sha);

    // Create full git object (header + content)
    const fullObject = createGitObjectRaw(type, content);

    // Compress using sync zlibSync (faster than async CompressionStream)
    const compressed = zlibSync(fullObject);

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

  // ============ Reference Operations ============

  /**
   * Get a reference (e.g., refs/heads/main)
   * Returns the SHA it points to or null if not found
   */
  async getRef(name: string): Promise<string | null> {
    const key = `${this.basePath}/${name}`;
    const obj = await this.bucket.get(key);

    if (!obj) {
      return null;
    }

    const content = await obj.text();
    return content.trim();
  }

  /**
   * Set a reference to point to a SHA
   */
  async setRef(name: string, sha: string): Promise<void> {
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

  // ============ Private Helpers ============

  private objectKey(sha: string): string {
    if (!isValidSha(sha)) {
      throw new Error(`Invalid SHA: ${sha}`);
    }
    return `${this.basePath}/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
  }
}
