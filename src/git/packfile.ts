/**
 * Git packfile parsing and generation
 *
 * Packfile format:
 * - Header: "PACK" + version (4 bytes) + object count (4 bytes)
 * - Objects: type/size encoded, followed by zlib-compressed data
 * - Trailer: 20-byte SHA-1 of the packfile
 *
 * Object types in packfile:
 * 1 = commit, 2 = tree, 3 = blob, 4 = tag
 * 6 = OFS_DELTA, 7 = REF_DELTA
 */

import { GitR2Storage } from "./storage";
import {
  type GitObjectType,
  parseGitObject,
  parseTree,
  parseCommit,
  sha1,
  shaToBytes,
  bytesToSha,
} from "./objects";
import pako from "pako";
import { zlibSync } from "fflate";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Packfile object type codes
const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

function typeToCode(type: GitObjectType): number {
  switch (type) {
    case "commit":
      return OBJ_COMMIT;
    case "tree":
      return OBJ_TREE;
    case "blob":
      return OBJ_BLOB;
    case "tag":
      return OBJ_TAG;
    default:
      throw new Error(`Unknown object type: ${type}`);
  }
}

function codeToType(code: number): GitObjectType {
  switch (code) {
    case OBJ_COMMIT:
      return "commit";
    case OBJ_TREE:
      return "tree";
    case OBJ_BLOB:
      return "blob";
    case OBJ_TAG:
      return "tag";
    default:
      throw new Error(`Unknown object type code: ${code}`);
  }
}

// ============ Packfile Parsing (for git push) ============

interface PackfileObject {
  type: GitObjectType;
  data: Uint8Array;
  sha: string;
  /** Set to true after data has been freed from memory (stored in R2) */
  dataFreed?: boolean;
}

interface DeltaObject {
  type: "ofs_delta" | "ref_delta";
  baseOffset?: number;
  baseSha?: string;
  deltaData: Uint8Array;
  packOffset: number;
}

/**
 * Parse a packfile and store objects to R2 in parallel batches.
 * Objects are parsed sequentially (required for offset tracking),
 * then stored to R2 in parallel batches for performance.
 */
export async function parsePackfile(
  data: Uint8Array,
  storage: GitR2Storage
): Promise<PackfileObject[]> {
  let offset = 0;

  // Read header
  const signature = decoder.decode(data.subarray(offset, offset + 4));
  if (signature !== "PACK") {
    throw new Error("Invalid packfile signature");
  }
  offset += 4;

  const version = readUint32BE(data, offset);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported packfile version: ${version}`);
  }
  offset += 4;

  const objectCount = readUint32BE(data, offset);
  offset += 4;

  const objects: PackfileObject[] = [];
  const pendingObjects: PackfileObject[] = [];
  const deltas: DeltaObject[] = [];
  const offsetToObject = new Map<number, PackfileObject>();

  // Phase 1: Parse all objects sequentially (no R2 writes)
  for (let i = 0; i < objectCount; i++) {
    const objectOffset = offset;
    const { type, size, headerSize } = readTypeAndSize(data, offset);
    offset += headerSize;

    if (type === OBJ_OFS_DELTA) {
      const { value: negOffset, bytes: negOffsetBytes } = readVariableOffset(data, offset);
      offset += negOffsetBytes;

      const compressedData = data.subarray(offset);
      const { decompressed, bytesRead } = decompressObject(compressedData, size);
      offset += bytesRead;

      deltas.push({
        type: "ofs_delta",
        baseOffset: objectOffset - negOffset,
        deltaData: decompressed,
        packOffset: objectOffset,
      });
    } else if (type === OBJ_REF_DELTA) {
      const baseSha = bytesToSha(data.subarray(offset, offset + 20));
      offset += 20;

      const compressedData = data.subarray(offset);
      const { decompressed, bytesRead } = decompressObject(compressedData, size);
      offset += bytesRead;

      deltas.push({
        type: "ref_delta",
        baseSha,
        deltaData: decompressed,
        packOffset: objectOffset,
      });
    } else {
      // Regular object — parse only, defer R2 write
      const compressedData = data.subarray(offset);
      const { decompressed, bytesRead } = decompressObject(compressedData, size);
      offset += bytesRead;

      const objType = codeToType(type);
      const sha = await computeObjectSha(objType, decompressed);

      const obj: PackfileObject = {
        type: objType,
        data: decompressed,
        sha,
      };

      objects.push(obj);
      pendingObjects.push(obj);
      offsetToObject.set(objectOffset, obj);
    }
  }

  // Phase 2: Batch store regular objects to R2 in parallel
  await storage.putObjectBatch(pendingObjects);

  // Free blob data after R2 storage (blobs are the largest objects).
  // Keep commit/tree data in memory — they're small and may be needed as delta bases.
  for (const obj of pendingObjects) {
    if (obj.type === "blob") {
      obj.data = new Uint8Array(0);
      obj.dataFreed = true;
    }
  }
  pendingObjects.length = 0; // release the array itself

  // Phase 3: Resolve deltas (may need storage.getObject for external bases)
  const resolvedObjects: PackfileObject[] = [];

  for (const delta of deltas) {
    let baseObj: PackfileObject | undefined;

    if (delta.type === "ofs_delta" && delta.baseOffset !== undefined) {
      baseObj = offsetToObject.get(delta.baseOffset);
    } else if (delta.type === "ref_delta" && delta.baseSha) {
      baseObj = objects.find((o) => o.sha === delta.baseSha);
    }

    // If base was found but its data was freed, or not found at all, fetch from R2
    if (baseObj?.dataFreed || !baseObj) {
      const sha = baseObj?.sha || delta.baseSha;
      if (sha) {
        const storedData = await storage.getObject(sha);
        if (storedData) {
          const parsed = parseGitObject(storedData);
          if (baseObj) {
            // Restore data temporarily for delta application
            baseObj = { ...baseObj, data: parsed.content, dataFreed: false };
          } else {
            baseObj = {
              type: parsed.type,
              data: parsed.content,
              sha,
            };
          }
        }
      }
    }

    if (!baseObj) {
      throw new Error(`Cannot resolve delta: base object not found`);
    }

    const resolvedData = applyDelta(baseObj.data, delta.deltaData);
    const sha = await computeObjectSha(baseObj.type, resolvedData);

    const resolvedObj: PackfileObject = {
      type: baseObj.type,
      data: resolvedData,
      sha,
    };

    objects.push(resolvedObj);
    resolvedObjects.push(resolvedObj);
    offsetToObject.set(delta.packOffset, resolvedObj);

    // Free delta data immediately after use
    delta.deltaData = new Uint8Array(0);
  }

  // Phase 4: Batch store resolved delta objects to R2 in parallel
  await storage.putObjectBatch(resolvedObjects);

  // Free blob data from resolved objects too
  for (const obj of resolvedObjects) {
    if (obj.type === "blob") {
      obj.data = new Uint8Array(0);
      obj.dataFreed = true;
    }
  }
  resolvedObjects.length = 0;
  deltas.length = 0;
  offsetToObject.clear();

  return objects;
}

// ============ Packfile Generation (for git clone/fetch) ============

/**
 * Generate a packfile containing specified objects
 */
export interface GeneratePackfileResult {
  packfile: Uint8Array;
  shallowCommits: string[];
}

export async function generatePackfile(
  wantShas: string[],
  haveShas: string[],
  storage: GitR2Storage,
  depth?: number
): Promise<GeneratePackfileResult> {
  // Map caches parsed objects during traversal — eliminates second fetch pass
  const objectsToSend = new Map<string, { type: GitObjectType; content: Uint8Array }>();
  const haveSet = new Set(haveShas);
  const shallowCommits = new Set<string>();

  await collectReachableObjectsBFS(wantShas, storage, objectsToSend, haveSet, depth, shallowCommits);

  // Use cached objects — no second fetch pass needed
  const objects = Array.from(objectsToSend.entries()).map(([sha, { type, content }]) => ({
    sha,
    type,
    data: content,
  }));

  return {
    packfile: await buildPackfile(objects),
    shallowCommits: Array.from(shallowCommits),
  };
}

const FETCH_BATCH_SIZE = 40; // Safe under HTTP/2 multiplexing limit (~75)

/**
 * Collect all objects reachable from startShas using parallel BFS.
 * Fetches up to FETCH_BATCH_SIZE objects concurrently, caching parsed
 * content in `collected` to avoid a second read pass.
 */
async function collectReachableObjectsBFS(
  startShas: string[],
  storage: GitR2Storage,
  collected: Map<string, { type: GitObjectType; content: Uint8Array }>,
  exclude: Set<string>,
  depth?: number,
  shallowCommits?: Set<string>
): Promise<void> {
  let queue: { sha: string; commitDepth: number }[] = startShas
    .filter((s) => !collected.has(s) && !exclude.has(s))
    .map((s) => ({ sha: s, commitDepth: 0 }));

  while (queue.length > 0) {
    const batch = queue.splice(0, FETCH_BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async ({ sha, commitDepth }) => {
        if (collected.has(sha) || exclude.has(sha)) return null;
        const rawData = await storage.getObject(sha);
        if (!rawData) return null;
        return { sha, commitDepth, rawData };
      })
    );

    for (const result of results) {
      if (!result || collected.has(result.sha)) continue;
      const { sha, commitDepth, rawData } = result;
      const parsed = parseGitObject(rawData);
      collected.set(sha, { type: parsed.type, content: parsed.content });

      if (parsed.type === "commit") {
        const commit = parseCommit(parsed.content);
        if (!collected.has(commit.tree) && !exclude.has(commit.tree))
          queue.push({ sha: commit.tree, commitDepth });
        if (depth !== undefined && commitDepth >= depth - 1) {
          if (commit.parents.length > 0 && shallowCommits) shallowCommits.add(sha);
          continue;
        }
        for (const parent of commit.parents)
          if (!collected.has(parent) && !exclude.has(parent))
            queue.push({ sha: parent, commitDepth: commitDepth + 1 });
      } else if (parsed.type === "tree") {
        const entries = parseTree(parsed.content);
        for (const entry of entries)
          if (!collected.has(entry.sha) && !exclude.has(entry.sha))
            queue.push({ sha: entry.sha, commitDepth });
      }
    }
  }
}

/**
 * Find shallow boundary commits without fetching trees or blobs.
 * Used for POST 1 shallow negotiation — much cheaper than a full packfile traversal.
 */
export async function findShallowCommits(
  wantShas: string[],
  haveShas: string[],
  storage: GitR2Storage,
  depth: number
): Promise<string[]> {
  const visited = new Set<string>(haveShas);
  const shallowCommits: string[] = [];
  let queue: { sha: string; d: number }[] = wantShas
    .filter((s) => !visited.has(s))
    .map((s) => ({ sha: s, d: 0 }));

  while (queue.length > 0) {
    const batch = queue.splice(0, FETCH_BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async ({ sha, d }) => {
        if (visited.has(sha)) return null;
        const rawData = await storage.getObject(sha);
        if (!rawData) return null;
        return { sha, d, rawData };
      })
    );

    for (const r of results) {
      if (!r || visited.has(r.sha)) continue;
      visited.add(r.sha);
      const parsed = parseGitObject(r.rawData);
      if (parsed.type !== "commit") continue;
      const commit = parseCommit(parsed.content);
      if (r.d >= depth - 1) {
        if (commit.parents.length > 0) shallowCommits.push(r.sha);
        continue;
      }
      for (const p of commit.parents)
        if (!visited.has(p)) queue.push({ sha: p, d: r.d + 1 });
    }
  }
  return shallowCommits;
}

/**
 * Build a packfile from a list of objects
 * MVP: No delta compression, all full objects
 */
async function buildPackfile(
  objects: { sha: string; type: GitObjectType; data: Uint8Array }[]
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];

  // Header: PACK + version (2) + object count
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"), 0);
  writeUint32BE(header, 4, 2); // version 2
  writeUint32BE(header, 8, objects.length);
  parts.push(header);

  // Each object
  for (const obj of objects) {
    // Encode type and size
    const typeCode = typeToCode(obj.type);
    const typeSizeHeader = encodeTypeAndSize(typeCode, obj.data.length);
    parts.push(typeSizeHeader);

    // Compress data
    const compressed = compressData(obj.data);
    parts.push(compressed);
  }

  // Combine all parts
  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const packData = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    packData.set(part, offset);
    offset += part.length;
  }

  // Compute and append checksum (SHA-1 of pack data)
  const checksum = await sha1(packData);
  const checksumBytes = shaToBytes(checksum);

  const result = new Uint8Array(packData.length + 20);
  result.set(packData, 0);
  result.set(checksumBytes, packData.length);

  return result;
}

// ============ Helper Functions ============

function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] << 24) |
    (data[offset + 1] << 16) |
    (data[offset + 2] << 8) |
    data[offset + 3]
  );
}

function writeUint32BE(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >> 24) & 0xff;
  data[offset + 1] = (value >> 16) & 0xff;
  data[offset + 2] = (value >> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

/**
 * Read variable-length type and size from packfile
 * Format: 1-bit continuation, 3-bit type (first byte), 4-bit size
 * Following bytes: 1-bit continuation, 7-bit size
 */
function readTypeAndSize(
  data: Uint8Array,
  offset: number
): { type: number; size: number; headerSize: number } {
  let byte = data[offset];
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let headerSize = 1;

  while (byte & 0x80) {
    byte = data[offset + headerSize];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    headerSize++;
  }

  return { type, size, headerSize };
}

/**
 * Encode type and size for packfile
 */
function encodeTypeAndSize(type: number, size: number): Uint8Array {
  const bytes: number[] = [];

  // First byte: 3-bit type, 4-bit size
  let byte = (type << 4) | (size & 0x0f);
  size >>= 4;

  while (size > 0) {
    bytes.push(byte | 0x80); // Set continuation bit
    byte = size & 0x7f;
    size >>= 7;
  }

  bytes.push(byte);
  return new Uint8Array(bytes);
}

/**
 * Read variable-length offset for OFS_DELTA
 */
function readVariableOffset(
  data: Uint8Array,
  offset: number
): { value: number; bytes: number } {
  let byte = data[offset];
  let value = byte & 0x7f;
  let bytes = 1;

  while (byte & 0x80) {
    byte = data[offset + bytes];
    value = ((value + 1) << 7) | (byte & 0x7f);
    bytes++;
  }

  return { value, bytes };
}

/**
 * Decompress zlib data and find the compressed stream boundary.
 * Uses pako streaming inflate which reports bytes consumed via strm.avail_in,
 * giving exact compressed stream boundaries in a single decompression pass.
 * This is the same approach used by isomorphic-git (src/utils/git-list-pack.js).
 */
function decompressObject(
  data: Uint8Array,
  expectedSize: number
): { decompressed: Uint8Array; bytesRead: number } {
  // Git packfile objects use zlib (RFC 1950): 2-byte header + raw deflate + 4-byte adler32.
  // pako.Inflate in zlib mode fails when trailing data exists (next object bytes),
  // so we use raw mode and skip the zlib wrapper manually.
  const inflator = new pako.Inflate({ raw: true });
  inflator.push(data.subarray(2), false); // skip 2-byte zlib header

  if (inflator.err) {
    throw new Error(`Decompression failed: ${inflator.msg}`);
  }

  const decompressed = inflator.result as Uint8Array;
  if (decompressed.length !== expectedSize) {
    throw new Error(
      `Decompressed size mismatch: expected ${expectedSize}, got ${decompressed.length}`
    );
  }

  // Raw deflate bytes consumed + 2 (zlib header) + 4 (adler32 checksum)
  const rawConsumed = (data.length - 2) - (inflator as any).strm.avail_in;
  const bytesRead = 2 + rawConsumed + 4;

  return { decompressed, bytesRead };
}

/**
 * Compress data using zlib (for packfile generation)
 */
function compressData(data: Uint8Array): Uint8Array {
  return zlibSync(data);
}

/**
 * Apply a delta to a base object
 */
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let offset = 0;

  // Read base size (variable length encoding)
  const { value: baseSize, bytes: baseSizeBytes } = readDeltaSize(delta, offset);
  offset += baseSizeBytes;

  if (baseSize !== base.length) {
    throw new Error(`Delta base size mismatch: expected ${baseSize}, got ${base.length}`);
  }

  // Read result size
  const { value: resultSize, bytes: resultSizeBytes } = readDeltaSize(delta, offset);
  offset += resultSizeBytes;

  const result = new Uint8Array(resultSize);
  let resultOffset = 0;

  // Apply delta instructions
  while (offset < delta.length) {
    const cmd = delta[offset++];

    if (cmd & 0x80) {
      // Copy from base
      let copyOffset = 0;
      let copySize = 0;

      if (cmd & 0x01) copyOffset |= delta[offset++];
      if (cmd & 0x02) copyOffset |= delta[offset++] << 8;
      if (cmd & 0x04) copyOffset |= delta[offset++] << 16;
      if (cmd & 0x08) copyOffset |= delta[offset++] << 24;

      if (cmd & 0x10) copySize |= delta[offset++];
      if (cmd & 0x20) copySize |= delta[offset++] << 8;
      if (cmd & 0x40) copySize |= delta[offset++] << 16;

      if (copySize === 0) copySize = 0x10000;

      result.set(base.slice(copyOffset, copyOffset + copySize), resultOffset);
      resultOffset += copySize;
    } else if (cmd > 0) {
      // Insert from delta
      result.set(delta.slice(offset, offset + cmd), resultOffset);
      offset += cmd;
      resultOffset += cmd;
    } else {
      throw new Error("Invalid delta command: 0");
    }
  }

  if (resultOffset !== resultSize) {
    throw new Error(`Delta result size mismatch: expected ${resultSize}, got ${resultOffset}`);
  }

  return result;
}

function readDeltaSize(data: Uint8Array, offset: number): { value: number; bytes: number } {
  let value = 0;
  let shift = 0;
  let bytes = 0;

  do {
    const byte = data[offset + bytes];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    bytes++;
  } while (data[offset + bytes - 1] & 0x80);

  return { value, bytes };
}

/**
 * Compute SHA-1 of a git object
 */
async function computeObjectSha(type: GitObjectType, data: Uint8Array): Promise<string> {
  const header = encoder.encode(`${type} ${data.length}\0`);
  const full = new Uint8Array(header.length + data.length);
  full.set(header, 0);
  full.set(data, header.length);
  return sha1(full);
}
