/**
 * Tests for objects.ts optimizations:
 * 1. bytesToHex correctness + benchmark vs old method
 * 2. parseGitObject with subarray (zero-copy)
 * 3. parseTree with subarray + bytesToHex
 * 4. sha1 hash correctness
 */

import { describe, it, expect, bench } from "vitest";
import {
  bytesToHex,
  sha1,
  hashGitObject,
  parseGitObject,
  parseTree,
  createTree,
  createGitObjectRaw,
  createCommit,
  parseCommit,
  shaToBytes,
  bytesToSha,
} from "../src/git/objects";

// ── Old implementations for benchmark comparison ──

function bytesToHexOld(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Correctness Tests ──

describe("bytesToHex", () => {
  it("should encode all-zero bytes", () => {
    const bytes = new Uint8Array(20);
    expect(bytesToHex(bytes)).toBe("0000000000000000000000000000000000000000");
  });

  it("should encode known SHA", () => {
    const bytes = new Uint8Array([
      0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0x00, 0xff,
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa,
    ]);
    expect(bytesToHex(bytes)).toBe("abcdef012345678900ff112233445566778899aa");
  });

  it("should match old implementation for random data", () => {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    expect(bytesToHex(bytes)).toBe(bytesToHexOld(bytes));
  });

  it("should match old implementation for all 256 byte values", () => {
    for (let b = 0; b < 256; b++) {
      const bytes = new Uint8Array([b]);
      expect(bytesToHex(bytes)).toBe(bytesToHexOld(bytes));
    }
  });
});

describe("sha1", () => {
  it("should hash empty data correctly", async () => {
    // SHA-1 of empty string = da39a3ee5e6b4b0d3255bfef95601890afd80709
    const hash = await sha1(new Uint8Array(0));
    expect(hash).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("should hash 'hello' correctly", async () => {
    const data = new TextEncoder().encode("hello");
    const hash = await sha1(data);
    // SHA-1 of "hello" = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    expect(hash).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });
});

describe("hashGitObject", () => {
  it("should produce valid 40-char hex hash", async () => {
    const content = new TextEncoder().encode("hello");
    const hash = await hashGitObject("blob", content);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("should produce stable hashes (same input = same output)", async () => {
    const content = new TextEncoder().encode("hello");
    const hash1 = await hashGitObject("blob", content);
    const hash2 = await hashGitObject("blob", content);
    expect(hash1).toBe(hash2);
  });

  it("should produce different hashes for different content", async () => {
    const hash1 = await hashGitObject("blob", new TextEncoder().encode("hello"));
    const hash2 = await hashGitObject("blob", new TextEncoder().encode("world"));
    expect(hash1).not.toBe(hash2);
  });

  it("should produce different hashes for different types", async () => {
    const content = new TextEncoder().encode("test");
    const blobHash = await hashGitObject("blob", content);
    const commitHash = await hashGitObject("commit", content);
    expect(blobHash).not.toBe(commitHash);
  });
});

describe("parseGitObject with subarray", () => {
  it("should parse blob object", () => {
    const content = new TextEncoder().encode("hello world");
    const raw = createGitObjectRaw("blob", content);
    const parsed = parseGitObject(raw);
    expect(parsed.type).toBe("blob");
    expect(parsed.size).toBe(11);
    expect(new TextDecoder().decode(parsed.content)).toBe("hello world");
  });

  it("should parse commit object round-trip", () => {
    const commitContent = createCommit({
      tree: "abcdef0123456789abcdef0123456789abcdef01",
      parents: ["1234567890abcdef1234567890abcdef12345678"],
      author: "Test User <test@test.com> 1700000000 +0000",
      committer: "Test User <test@test.com> 1700000000 +0000",
      message: "test commit",
    });
    const raw = createGitObjectRaw("commit", commitContent);
    const parsed = parseGitObject(raw);
    expect(parsed.type).toBe("commit");
    const commit = parseCommit(parsed.content);
    expect(commit.tree).toBe("abcdef0123456789abcdef0123456789abcdef01");
    expect(commit.parents).toEqual(["1234567890abcdef1234567890abcdef12345678"]);
    expect(commit.message).toBe("test commit");
  });

  it("content should be a view (subarray), not a copy", () => {
    const content = new TextEncoder().encode("test data");
    const raw = createGitObjectRaw("blob", content);
    const parsed = parseGitObject(raw);
    // subarray shares the same buffer
    expect(parsed.content.buffer).toBe(raw.buffer);
  });
});

describe("parseTree + createTree round-trip", () => {
  it("should round-trip tree entries", () => {
    const entries = [
      { mode: "100644", name: "file.txt", sha: "abcdef0123456789abcdef0123456789abcdef01" },
      { mode: "40000", name: "src", sha: "1234567890abcdef1234567890abcdef12345678" },
    ];
    const treeContent = createTree(entries);
    const parsed = parseTree(treeContent);
    // Git sorts: files before dirs with special directory suffix
    expect(parsed.length).toBe(2);
    // Both entries should be present
    const names = parsed.map(e => e.name).sort();
    expect(names).toEqual(["file.txt", "src"]);

    for (const entry of parsed) {
      const original = entries.find(e => e.name === entry.name)!;
      expect(entry.mode).toBe(original.mode);
      expect(entry.sha).toBe(original.sha);
    }
  });

  it("should handle many entries", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      mode: "100644",
      name: `file-${i.toString().padStart(3, "0")}.ts`,
      sha: `${"a".repeat(38)}${i.toString(16).padStart(2, "0")}`,
    }));
    const treeContent = createTree(entries);
    const parsed = parseTree(treeContent);
    expect(parsed.length).toBe(100);
  });
});

describe("shaToBytes / bytesToSha round-trip", () => {
  it("should round-trip", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const bytes = shaToBytes(sha);
    expect(bytes.length).toBe(20);
    expect(bytesToSha(bytes)).toBe(sha);
  });
});

