/**
 * Benchmarks for objects.ts optimizations
 * Run with: npm run test:bench
 */

import { bench, describe } from "vitest";
import {
  bytesToHex,
  sha1,
  parseGitObject,
  parseTree,
  createTree,
  createGitObjectRaw,
} from "../src/git/objects";
import { zlibSync, unzlibSync } from "fflate";

// Old implementations for comparison
function bytesToHexOld(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function decompressOld(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(compressed);
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ── SHA hex encoding ──

describe("bytesToHex", () => {
  const testBytes = new Uint8Array(20);
  crypto.getRandomValues(testBytes);

  bench("new (lookup table)", () => {
    bytesToHex(testBytes);
  });

  bench("old (Array.from.map.join)", () => {
    bytesToHexOld(testBytes);
  });
});

// ── Decompression ──

describe("decompression (1KB blob)", () => {
  const blob = createGitObjectRaw("blob", new TextEncoder().encode("x".repeat(1000)));
  const compressed = zlibSync(blob);

  bench("new (unzlibSync)", () => {
    unzlibSync(compressed);
  });

  bench("old (DecompressionStream)", async () => {
    await decompressOld(compressed);
  });
});

describe("decompression (10KB blob)", () => {
  const blob = createGitObjectRaw("blob", new TextEncoder().encode("x".repeat(10000)));
  const compressed = zlibSync(blob);

  bench("new (unzlibSync)", () => {
    unzlibSync(compressed);
  });

  bench("old (DecompressionStream)", async () => {
    await decompressOld(compressed);
  });
});

// ── parseTree ──

describe("parseTree", () => {
  const smallTree = createTree(
    Array.from({ length: 5 }, (_, i) => ({
      mode: "100644",
      name: `file-${i}.ts`,
      sha: `${"a".repeat(38)}${i.toString(16).padStart(2, "0")}`,
    }))
  );

  const largeTree = createTree(
    Array.from({ length: 50 }, (_, i) => ({
      mode: "100644",
      name: `file-${i.toString().padStart(3, "0")}.ts`,
      sha: `${"a".repeat(38)}${i.toString(16).padStart(2, "0")}`,
    }))
  );

  bench("5 entries", () => {
    parseTree(smallTree);
  });

  bench("50 entries", () => {
    parseTree(largeTree);
  });
});

// ── parseGitObject ──

describe("parseGitObject", () => {
  const blob1k = createGitObjectRaw("blob", new TextEncoder().encode("x".repeat(1000)));
  const blob10k = createGitObjectRaw("blob", new TextEncoder().encode("x".repeat(10000)));

  bench("1KB blob", () => {
    parseGitObject(blob1k);
  });

  bench("10KB blob", () => {
    parseGitObject(blob10k);
  });
});

// ── sha1 ──

describe("sha1", () => {
  const data1k = new TextEncoder().encode("x".repeat(1000));
  const data10k = new TextEncoder().encode("x".repeat(10000));

  bench("1KB", async () => {
    await sha1(data1k);
  });

  bench("10KB", async () => {
    await sha1(data10k);
  });
});
