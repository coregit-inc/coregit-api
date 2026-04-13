/**
 * Packfile creation and reading for R2 storage.
 *
 * Creates minimal packfiles (no delta compression) from loose objects.
 * Packfiles reduce R2 keys from 100K+ per repo to a handful of packs.
 *
 * Pack format:
 *   Header: "PACK" (4 bytes) + version 2 (4 bytes) + object count (4 bytes)
 *   Entries: type+size varint + zlib-compressed data
 *   Trailer: 20-byte SHA-1 of everything above
 *
 * Pack index (JSON in KV):
 *   { entries: { [sha]: { offset, size, type } }, objectCount }
 */

import { zlibSync, unzlibSync } from "fflate";
import { sha1, type GitObjectType } from "./objects";

const encoder = new TextEncoder();

// Packfile type codes
const TYPE_CODES: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_TYPE: Record<number, GitObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

export interface PackIndexEntry {
  offset: number;
  size: number;
  type: GitObjectType;
}

export interface PackIndex {
  entries: Record<string, PackIndexEntry>; // sha → entry
  objectCount: number;
  packSha: string;
}

/**
 * Create a packfile from a list of objects.
 * No delta compression — stores each object as-is (OBJ_BLOB/TREE/COMMIT).
 */
export async function createMinimalPack(
  objects: { sha: string; type: GitObjectType; data: Uint8Array }[]
): Promise<{ pack: Uint8Array; index: PackIndex }> {
  const parts: Uint8Array[] = [];
  const indexEntries: Record<string, PackIndexEntry> = {};

  // Header: PACK + version 2 + object count
  const header = new Uint8Array(12);
  header[0] = 0x50; // P
  header[1] = 0x41; // A
  header[2] = 0x43; // C
  header[3] = 0x4b; // K
  writeUint32BE(header, 4, 2); // version 2
  writeUint32BE(header, 8, objects.length);
  parts.push(header);

  let currentOffset = 12;

  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    if (!typeCode) throw new Error(`Unknown object type: ${obj.type}`);

    // Encode type+size header (variable length)
    const headerBytes = encodeTypeAndSize(typeCode, obj.data.length);

    // Compress data
    const compressed = zlibSync(obj.data);

    // Record index entry (offset before writing)
    indexEntries[obj.sha] = {
      offset: currentOffset,
      size: obj.data.length,
      type: obj.type,
    };

    parts.push(headerBytes);
    parts.push(compressed);

    currentOffset += headerBytes.length + compressed.length;
  }

  // Concatenate all parts (without trailer)
  const packWithoutTrailer = concatUint8Arrays(parts);

  // Trailer: SHA-1 of everything
  const packSha = await sha1(packWithoutTrailer);
  const trailerBytes = hexToBytes(packSha);

  // Final pack = content + trailer
  const pack = new Uint8Array(packWithoutTrailer.length + 20);
  pack.set(packWithoutTrailer);
  pack.set(trailerBytes, packWithoutTrailer.length);

  return {
    pack,
    index: {
      entries: indexEntries,
      objectCount: objects.length,
      packSha,
    },
  };
}

/**
 * Read a single object from a packfile at the given offset.
 */
export function readFromPack(
  packData: Uint8Array,
  offset: number
): { type: GitObjectType; data: Uint8Array } {
  // Read type+size header
  let byte = packData[offset];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;

  while (byte & 0x80) {
    byte = packData[pos++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }

  const type = CODE_TO_TYPE[typeCode];
  if (!type) throw new Error(`Unknown pack object type code: ${typeCode}`);

  // Decompress data from pos
  const compressed = packData.subarray(pos);
  const decompressed = unzlibSync(compressed);

  return { type, data: decompressed };
}

// ── Helpers ──

function encodeTypeAndSize(typeCode: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let firstByte = (typeCode << 4) | (size & 0x0f);
  size >>= 4;

  if (size > 0) {
    firstByte |= 0x80;
  }
  bytes.push(firstByte);

  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }

  return new Uint8Array(bytes);
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
