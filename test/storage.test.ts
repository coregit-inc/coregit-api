/**
 * Tests for storage.ts optimizations:
 * 1. Sync decompression (unzlibSync) correctness
 * 2. putObject skip-if-cached
 * 3. putObjectBatch
 * 4. getObjectBatch
 *
 * Uses a mock R2Bucket to avoid needing wrangler.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { zlibSync } from "fflate";
import { createGitObjectRaw } from "../src/git/objects";
import { createMockBucket } from "./helpers/mock-r2";

// ── Mock R2Bucket ──

async function createStorage(bucket: R2Bucket) {
  const { GitR2Storage } = await import("../src/git/storage");
  return new GitR2Storage(bucket, "user1", "repo1");
}

describe("GitR2Storage sync decompression", () => {
  it("should decompress zlib-compressed objects correctly", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    // Manually store a compressed blob
    const content = new TextEncoder().encode("hello world");
    const raw = createGitObjectRaw("blob", content);
    const compressed = zlibSync(raw);
    bucket._store.set("user1/repo1/objects/ce/013625030ba8dba906f756967f9e9ca394464a", compressed);

    const result = await storage.getObject("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!).startsWith("blob")).toBe(true);
    expect(new TextDecoder().decode(result!)).toContain("hello world");
  });

  it("should fallback to raw data if decompression fails", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    // Store invalid compressed data
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    bucket._store.set("user1/repo1/objects/aa/bbccddee112233445566778899aabbccddeeff", raw);

    const result = await storage.getObject("aabbccddee112233445566778899aabbccddeeff");
    expect(result).not.toBeNull();
    // Falls back to raw
    expect(result).toEqual(raw);
  });

  it("should return null for missing objects", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);
    const result = await storage.getObject("0000000000000000000000000000000000000000");
    expect(result).toBeNull();
  });
});

describe("putObject skip-if-cached", () => {
  it("should skip R2 write when SHA is already cached", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const content = new TextEncoder().encode("cached content");
    const sha = "ce013625030ba8dba906f756967f9e9ca394464a";

    // First write — should hit R2
    await storage.putObject(sha, "blob", content);
    const firstCallCount = (bucket.put as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Read it to populate cache
    await storage.getObject(sha);

    // Reset call count
    (bucket.put as ReturnType<typeof vi.fn>).mockClear();

    // Second write — should skip R2 (cached)
    await storage.putObject(sha, "blob", content);
    expect((bucket.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

describe("putObjectBatch", () => {
  it("should write multiple objects in parallel batches", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const objects = Array.from({ length: 5 }, (_, i) => ({
      sha: `${"0".repeat(38)}${i.toString(16).padStart(2, "0")}`,
      type: "blob" as const,
      data: new TextEncoder().encode(`content-${i}`),
    }));

    await storage.putObjectBatch(objects, 3);

    // All 5 should be written (2 batches: 3 + 2)
    expect((bucket.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5);
  });
});

describe("getObjectBatch", () => {
  it("should fetch multiple objects in parallel", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    // Store some objects first
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sha = `${"0".repeat(38)}${i.toString(16).padStart(2, "0")}`;
      shas.push(sha);
      await storage.putObject(sha, "blob", new TextEncoder().encode(`content-${i}`));
    }

    // Clear cache by creating new storage instance
    const freshStorage = await createStorage(bucket);
    const results = await freshStorage.getObjectBatch(shas);

    expect(results.size).toBe(5);
    for (const sha of shas) {
      expect(results.has(sha)).toBe(true);
    }
  });

  it("should skip missing objects", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const results = await storage.getObjectBatch([
      "0000000000000000000000000000000000000000",
      "1111111111111111111111111111111111111111",
    ]);

    expect(results.size).toBe(0);
  });
});

describe("putObject + getObject round-trip", () => {
  it("should store and retrieve blob correctly", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const content = new TextEncoder().encode("test file content\nline 2\n");
    const { hashGitObject, parseGitObject } = await import("../src/git/objects");
    const sha = await hashGitObject("blob", content);

    await storage.putObject(sha, "blob", content);

    // Clear cache
    const freshStorage = await createStorage(bucket);
    const raw = await freshStorage.getObject(sha);
    expect(raw).not.toBeNull();

    const parsed = parseGitObject(raw!);
    expect(parsed.type).toBe("blob");
    expect(new TextDecoder().decode(parsed.content)).toBe("test file content\nline 2\n");
  });

  it("should store and retrieve tree correctly", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const { createTree, parseTree, hashGitObject, parseGitObject } = await import("../src/git/objects");
    const entries = [
      { mode: "100644", name: "README.md", sha: "abcdef0123456789abcdef0123456789abcdef01" },
      { mode: "40000", name: "src", sha: "1234567890abcdef1234567890abcdef12345678" },
    ];

    const treeContent = createTree(entries);
    const sha = await hashGitObject("tree", treeContent);

    await storage.putObject(sha, "tree", treeContent);

    const freshStorage = await createStorage(bucket);
    const raw = await freshStorage.getObject(sha);
    expect(raw).not.toBeNull();

    const parsed = parseGitObject(raw!);
    expect(parsed.type).toBe("tree");

    const parsedEntries = parseTree(parsed.content);
    expect(parsedEntries.length).toBe(2);

    const readmeEntry = parsedEntries.find(e => e.name === "README.md");
    expect(readmeEntry).toBeDefined();
    expect(readmeEntry!.sha).toBe("abcdef0123456789abcdef0123456789abcdef01");
  });
});
