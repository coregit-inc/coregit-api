/**
 * Tests for cherry-pick.ts optimizations:
 * 1. flattenTree with treeCache
 * 2. diffFlattenedTrees correctness
 * 3. computeDiffStatsFromDiffs correctness
 * 4. buildTreeFromFlat batch writes
 *
 * Uses a mock R2Bucket + GitR2Storage.
 */

import { describe, it, expect, vi } from "vitest";
import { zlibSync } from "fflate";
import {
  createGitObjectRaw,
  createTree,
  createCommit,
  hashGitObject,
} from "../src/git/objects";
import {
  flattenTree,
  diffFlattenedTrees,
  computeDiffStatsFromDiffs,
  buildTreeFromFlat,
  type FlatTree,
  type FileDiff,
} from "../src/git/cherry-pick";

// ── Mock R2Bucket ──

function createMockBucket() {
  const store = new Map<string, Uint8Array>();

  return {
    get: vi.fn(async (key: string) => {
      const data = store.get(key);
      if (!data) return null;
      return {
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        text: async () => new TextDecoder().decode(data),
        etag: `etag-${key}`,
      };
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      if (value instanceof Uint8Array) {
        store.set(key, value);
      } else if (typeof value === "string") {
        store.set(key, new TextEncoder().encode(value));
      }
      return { etag: `etag-${key}` };
    }),
    head: vi.fn(async (key: string) => store.has(key) ? { key } : null),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    _store: store,
  } as unknown as R2Bucket & { _store: Map<string, Uint8Array> };
}

async function createStorage(bucket: R2Bucket) {
  const { GitR2Storage } = await import("../src/git/storage");
  return new GitR2Storage(bucket, "user1", "repo1");
}

/** Helper: store a git object in the mock bucket */
async function storeObject(
  bucket: R2Bucket & { _store: Map<string, Uint8Array> },
  type: "blob" | "tree" | "commit",
  content: Uint8Array
): Promise<string> {
  const raw = createGitObjectRaw(type, content);
  const sha = await hashGitObject(type, content);
  const compressed = zlibSync(raw);
  bucket._store.set(`user1/repo1/objects/${sha.slice(0, 2)}/${sha.slice(2)}`, compressed);
  return sha;
}

/** Build a simple tree with files */
async function buildSimpleTree(
  bucket: R2Bucket & { _store: Map<string, Uint8Array> },
  files: Record<string, string>
): Promise<string> {
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const blobContent = new TextEncoder().encode(content);
    const blobSha = await storeObject(bucket, "blob", blobContent);
    entries.push({ mode: "100644", name, sha: blobSha });
  }
  const treeContent = createTree(entries);
  return storeObject(bucket, "tree", treeContent);
}

// ── Tests ──

describe("flattenTree", () => {
  it("should flatten a simple tree", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const treeSha = await buildSimpleTree(bucket, {
      "README.md": "# Hello",
      "index.ts": "console.log('hi')",
    });

    const flat = await flattenTree(storage, treeSha);
    expect(flat.size).toBe(2);
    expect(flat.has("README.md")).toBe(true);
    expect(flat.has("index.ts")).toBe(true);
  });

  it("should flatten nested tree", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    // Build inner tree (src/)
    const srcTreeSha = await buildSimpleTree(bucket, {
      "main.ts": "export default {}",
      "utils.ts": "export function foo() {}",
    });

    // Build root tree with src/ subdir
    const rootEntries = [
      { mode: "100644", name: "README.md", sha: await storeObject(bucket, "blob", new TextEncoder().encode("# Root")) },
      { mode: "40000", name: "src", sha: srcTreeSha },
    ];
    const rootTreeContent = createTree(rootEntries);
    const rootTreeSha = await storeObject(bucket, "tree", rootTreeContent);

    const flat = await flattenTree(storage, rootTreeSha);
    expect(flat.size).toBe(3);
    expect(flat.has("README.md")).toBe(true);
    expect(flat.has("src/main.ts")).toBe(true);
    expect(flat.has("src/utils.ts")).toBe(true);
  });

  it("should use treeCache across calls", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const treeSha = await buildSimpleTree(bucket, {
      "file.txt": "content",
    });

    const cache = new Map<string, FlatTree>();

    // First call — cache miss
    const flat1 = await flattenTree(storage, treeSha, "", cache);
    expect(flat1.size).toBe(1);
    expect(cache.size).toBe(1); // cached

    // Reset R2 get counter
    (bucket.get as ReturnType<typeof vi.fn>).mockClear();

    // Second call — cache hit (no R2 reads)
    const flat2 = await flattenTree(storage, treeSha, "", cache);
    expect(flat2.size).toBe(1);
    expect((bucket.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

describe("diffFlattenedTrees", () => {
  it("should detect additions", () => {
    const treeA: FlatTree = new Map();
    const treeB: FlatTree = new Map([
      ["new-file.txt", { sha: "aaaa".repeat(10), mode: "100644" }],
    ]);

    const diffs = diffFlattenedTrees(treeA, treeB);
    expect(diffs.length).toBe(1);
    expect(diffs[0].type).toBe("add");
    expect(diffs[0].path).toBe("new-file.txt");
  });

  it("should detect deletions", () => {
    const treeA: FlatTree = new Map([
      ["old-file.txt", { sha: "bbbb".repeat(10), mode: "100644" }],
    ]);
    const treeB: FlatTree = new Map();

    const diffs = diffFlattenedTrees(treeA, treeB);
    expect(diffs.length).toBe(1);
    expect(diffs[0].type).toBe("delete");
  });

  it("should detect modifications", () => {
    const treeA: FlatTree = new Map([
      ["file.txt", { sha: "aaaa".repeat(10), mode: "100644" }],
    ]);
    const treeB: FlatTree = new Map([
      ["file.txt", { sha: "bbbb".repeat(10), mode: "100644" }],
    ]);

    const diffs = diffFlattenedTrees(treeA, treeB);
    expect(diffs.length).toBe(1);
    expect(diffs[0].type).toBe("modify");
  });

  it("should detect no changes for identical trees", () => {
    const sha = "cccc".repeat(10);
    const tree: FlatTree = new Map([
      ["file.txt", { sha, mode: "100644" }],
    ]);
    const diffs = diffFlattenedTrees(tree, tree);
    expect(diffs.length).toBe(0);
  });
});

describe("computeDiffStatsFromDiffs", () => {
  it("should count additions for new files", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const blobContent = new TextEncoder().encode("line 1\nline 2\nline 3\n");
    const blobSha = await storeObject(bucket, "blob", blobContent);

    const diffs: FileDiff[] = [
      { path: "new.txt", type: "add", newSha: blobSha },
    ];

    const stats = await computeDiffStatsFromDiffs(storage, diffs);
    expect(stats.filesChanged).toBe(1);
    expect(stats.additions).toBe(4); // 3 lines + trailing newline = 4 split parts
    expect(stats.deletions).toBe(0);
  });

  it("should count deletions for removed files", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const blobContent = new TextEncoder().encode("old\ncontent\n");
    const blobSha = await storeObject(bucket, "blob", blobContent);

    const diffs: FileDiff[] = [
      { path: "old.txt", type: "delete", oldSha: blobSha },
    ];

    const stats = await computeDiffStatsFromDiffs(storage, diffs);
    expect(stats.filesChanged).toBe(1);
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(3); // "old", "content", "" (trailing \n)
  });

  it("should count line-level changes for modified files", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const oldBlob = new TextEncoder().encode("line 1\nline 2\nline 3\n");
    const newBlob = new TextEncoder().encode("line 1\nchanged\nline 3\n");
    const oldSha = await storeObject(bucket, "blob", oldBlob);
    const newSha = await storeObject(bucket, "blob", newBlob);

    const diffs: FileDiff[] = [
      { path: "file.txt", type: "modify", oldSha, newSha },
    ];

    const stats = await computeDiffStatsFromDiffs(storage, diffs);
    expect(stats.filesChanged).toBe(1);
    expect(stats.additions).toBe(1); // "changed"
    expect(stats.deletions).toBe(1); // "line 2"
  });

  it("should return zeros for empty diff list", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const stats = await computeDiffStatsFromDiffs(storage, []);
    expect(stats.filesChanged).toBe(0);
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(0);
  });
});

describe("buildTreeFromFlat batch writes", () => {
  it("should create correct tree structure", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const flatMap: FlatTree = new Map([
      ["README.md", { sha: "a".repeat(40), mode: "100644" }],
      ["src/index.ts", { sha: "b".repeat(40), mode: "100644" }],
      ["src/lib/utils.ts", { sha: "c".repeat(40), mode: "100644" }],
    ]);

    const rootSha = await buildTreeFromFlat(storage, flatMap);
    expect(rootSha).toMatch(/^[0-9a-f]{40}$/);

    // Root tree should be readable
    const rootRaw = await storage.getObject(rootSha);
    expect(rootRaw).not.toBeNull();
  });

  it("should use batch writes (putObjectBatch called)", async () => {
    const bucket = createMockBucket();
    const storage = await createStorage(bucket);

    const putSpy = vi.spyOn(storage, "putObjectBatch");

    const flatMap: FlatTree = new Map([
      ["a.txt", { sha: "a".repeat(40), mode: "100644" }],
      ["b.txt", { sha: "b".repeat(40), mode: "100644" }],
    ]);

    await buildTreeFromFlat(storage, flatMap);
    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});
