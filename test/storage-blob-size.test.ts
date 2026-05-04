/**
 * Tests for the blob-size bypass added to GitR2Storage.putObject.
 *
 * Cloudflare DO legacy storage caps each value at 131_072 bytes. Any compressed
 * object larger than MAX_DO_VALUE_BYTES (120 KB) must skip the SessionDO and
 * RepoHotDO hot-cache layers and write straight to R2. Smaller objects must
 * still take the fast-ack DO path.
 */

import { describe, it, expect, vi } from "vitest";
import { hashGitObject, parseGitObject } from "../src/git/objects";
import { GitR2Storage, MAX_DO_VALUE_BYTES } from "../src/git/storage";

function createMockBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    get: vi.fn(async (key: string) => {
      const data = store.get(key);
      if (!data) return null;
      return {
        arrayBuffer: async () =>
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        text: async () => new TextDecoder().decode(data),
        etag: `etag-${key}`,
      };
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      if (value instanceof Uint8Array) store.set(key, value);
      else if (typeof value === "string") store.set(key, new TextEncoder().encode(value));
      else if (value instanceof ArrayBuffer) store.set(key, new Uint8Array(value));
      return { etag: `etag-${key}` };
    }),
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    _store: store,
  } as unknown as R2Bucket & { _store: Map<string, Uint8Array> };
}

/** Random bytes are effectively incompressible — use them when we need a
 *  predictable post-zlib size. */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // crypto.getRandomValues caps at 65_536 bytes per call — fill in chunks.
  const CHUNK = 65_536;
  for (let i = 0; i < n; i += CHUNK) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + CHUNK, n)));
  }
  return out;
}

function makeDOStub(handler: (req: Request) => Promise<Response> | Response) {
  return {
    fetch: vi.fn(async (input: string | Request, init?: RequestInit) => {
      const req = typeof input === "string" ? new Request(input, init) : input;
      return handler(req);
    }),
  } as unknown as DurableObjectStub;
}

describe("putObject blob-size bypass", () => {
  it("writes large blobs (compressed > MAX_DO_VALUE_BYTES) straight to R2 even with sessionStub", async () => {
    const bucket = createMockBucket();
    const storage = new GitR2Storage(bucket, "user1", "repo1");

    const sessionStub = makeDOStub(async () => {
      throw new Error("sessionStub.fetch must not be called for oversize blobs");
    });
    storage.setSessionStub(sessionStub);

    // 200 KB random bytes → compresses to ~200 KB (well above 120 KB cap)
    const content = randomBytes(200 * 1024);
    const sha = await hashGitObject("blob", content);

    await storage.putObject(sha, "blob", content);

    expect((sessionStub.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((bucket.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    const [r2Key] = (bucket.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(r2Key).toBe(`_blobs/${sha.slice(0, 2)}/${sha.slice(2)}`);

    // Round-trip via a fresh storage instance to bypass in-memory cache
    const fresh = new GitR2Storage(bucket, "user1", "repo1");
    const raw = await fresh.getObject(sha);
    expect(raw).not.toBeNull();
    const parsed = parseGitObject(raw!);
    expect(parsed.type).toBe("blob");
    expect(parsed.content.byteLength).toBe(content.byteLength);
  });

  it("writes large blobs straight to R2 even with repoDOStub", async () => {
    const bucket = createMockBucket();
    const storage = new GitR2Storage(bucket, "user1", "repo1");

    const repoStub = makeDOStub(async () => {
      throw new Error("repoDOStub.fetch must not be called for oversize blobs");
    });
    storage.setRepoDOStub(repoStub, "user1/repo1");

    const content = randomBytes(200 * 1024);
    const sha = await hashGitObject("blob", content);

    await storage.putObject(sha, "blob", content);

    expect((repoStub.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect((bucket.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("uses sessionStub fast-path for small blobs (under MAX_DO_VALUE_BYTES)", async () => {
    const bucket = createMockBucket();
    const storage = new GitR2Storage(bucket, "user1", "repo1");

    const sessionStub = makeDOStub(async () => new Response(null, { status: 202 }));
    storage.setSessionStub(sessionStub);

    const content = new TextEncoder().encode("small file content\nline 2\n");
    const sha = await hashGitObject("blob", content);

    await storage.putObject(sha, "blob", content);

    expect((sessionStub.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // R2 not touched on session 202 fast-path
    expect((bucket.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("falls back to direct R2 write when sessionStub returns 507 (defensive guard)", async () => {
    const bucket = createMockBucket();
    const storage = new GitR2Storage(bucket, "user1", "repo1");

    // Borderline case: under MAX_DO_VALUE_BYTES at the storage layer (so we hit
    // the DO branch), but DO defensively rejects with 507. Caller should write
    // to R2 directly.
    const sessionStub = makeDOStub(async () => new Response(null, { status: 507 }));
    storage.setSessionStub(sessionStub);

    const content = new TextEncoder().encode("borderline blob");
    const sha = await hashGitObject("blob", content);

    await storage.putObject(sha, "blob", content);

    expect((sessionStub.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((bucket.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    const fresh = new GitR2Storage(bucket, "user1", "repo1");
    const raw = await fresh.getObject(sha);
    expect(raw).not.toBeNull();
    const parsed = parseGitObject(raw!);
    expect(parsed.type).toBe("blob");
    expect(new TextDecoder().decode(parsed.content)).toBe("borderline blob");
  });

  it("MAX_DO_VALUE_BYTES is below the Cloudflare DO 131_072 hard cap", () => {
    expect(MAX_DO_VALUE_BYTES).toBeLessThan(131_072);
    expect(MAX_DO_VALUE_BYTES).toBeGreaterThan(64 * 1024);
  });
});
