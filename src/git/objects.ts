/**
 * Git object handling: blobs, trees, commits, and tags
 *
 * Git object format:
 * - Header: "{type} {size}\0"
 * - Content: raw bytes
 * - SHA-1 hash of header + content
 */

export type GitObjectType = "blob" | "tree" | "commit" | "tag";

export interface GitObject {
  type: GitObjectType;
  size: number;
  content: Uint8Array;
  sha: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Pre-computed hex lookup table — avoids per-byte toString(16) + padStart */
const HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0")
);

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += HEX[bytes[i]];
  return hex;
}

/**
 * Compute SHA-1 hash of data
 */
export async function sha1(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Hash a git object (header + content)
 */
export async function hashGitObject(
  type: GitObjectType,
  content: Uint8Array
): Promise<string> {
  const header = encoder.encode(`${type} ${content.length}\0`);
  const full = new Uint8Array(header.length + content.length);
  full.set(header, 0);
  full.set(content, header.length);
  return sha1(full);
}

/**
 * Create a git object with computed hash
 */
export async function createGitObject(
  type: GitObjectType,
  content: Uint8Array
): Promise<GitObject> {
  const sha = await hashGitObject(type, content);
  return {
    type,
    size: content.length,
    content,
    sha,
  };
}

/**
 * Create raw git object bytes (header + content) for storage
 */
export function createGitObjectRaw(type: GitObjectType, content: Uint8Array): Uint8Array {
  const header = encoder.encode(`${type} ${content.length}\0`);
  const full = new Uint8Array(header.length + content.length);
  full.set(header, 0);
  full.set(content, header.length);
  return full;
}

/**
 * Parse a raw git object from storage
 */
export function parseGitObject(raw: Uint8Array): GitObject & { rawContent: Uint8Array } {
  // Find the null byte separating header from content
  let nullIndex = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) {
      nullIndex = i;
      break;
    }
  }

  if (nullIndex === -1) {
    throw new Error("Invalid git object: no null byte found");
  }

  const header = decoder.decode(raw.subarray(0, nullIndex));
  const [type, sizeStr] = header.split(" ");

  if (!type || !sizeStr) {
    throw new Error("Invalid git object header");
  }

  const size = parseInt(sizeStr, 10);
  const content = raw.subarray(nullIndex + 1);

  if (content.length !== size) {
    throw new Error(`Git object size mismatch: expected ${size}, got ${content.length}`);
  }

  return {
    type: type as GitObjectType,
    size,
    content,
    sha: "", // Will be computed separately if needed
    rawContent: raw,
  };
}

/**
 * Parse a tree object content
 */
export function parseTree(content: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;

  while (offset < content.length) {
    // Find space separating mode from name
    let spaceIndex = offset;
    while (spaceIndex < content.length && content[spaceIndex] !== 0x20) {
      spaceIndex++;
    }

    const mode = decoder.decode(content.subarray(offset, spaceIndex));

    // Find null byte separating name from SHA
    let nullIndex = spaceIndex + 1;
    while (nullIndex < content.length && content[nullIndex] !== 0) {
      nullIndex++;
    }

    const name = decoder.decode(content.subarray(spaceIndex + 1, nullIndex));

    // SHA is 20 bytes after the null
    const sha = bytesToHex(content.subarray(nullIndex + 1, nullIndex + 21));

    entries.push({ mode, name, sha });
    offset = nullIndex + 21;
  }

  return entries;
}

/**
 * Create a tree object content from entries
 */
export function createTree(entries: TreeEntry[]): Uint8Array {
  // Sort entries (git sorts trees by name with special handling for directories)
  const sorted = [...entries].sort((a, b) => {
    // Directories (trees) have a trailing / for sorting purposes
    const aName = a.mode === "40000" ? a.name + "/" : a.name;
    const bName = b.mode === "40000" ? b.name + "/" : b.name;
    return aName.localeCompare(bName);
  });

  const parts: Uint8Array[] = [];

  for (const entry of sorted) {
    // Mode and name separated by space, followed by null, then 20-byte SHA
    const modeAndName = encoder.encode(`${entry.mode} ${entry.name}\0`);
    const shaBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      shaBytes[i] = parseInt(entry.sha.slice(i * 2, i * 2 + 2), 16);
    }

    parts.push(modeAndName);
    parts.push(shaBytes);
  }

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/**
 * Parse a commit object content
 */
export function parseCommit(content: Uint8Array): Commit {
  const text = decoder.decode(content);
  const lines = text.split("\n");

  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  let messageStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === "") {
      // Empty line separates headers from message
      messageStart = i + 1;
      break;
    }

    if (line.startsWith("tree ")) {
      tree = line.slice(5);
    } else if (line.startsWith("parent ")) {
      parents.push(line.slice(7));
    } else if (line.startsWith("author ")) {
      author = line.slice(7);
    } else if (line.startsWith("committer ")) {
      committer = line.slice(10);
    }
  }

  const message = lines.slice(messageStart).join("\n");

  return { tree, parents, author, committer, message };
}

/**
 * Create a commit object content
 */
export function createCommit(commit: Commit): Uint8Array {
  const lines: string[] = [];

  lines.push(`tree ${commit.tree}`);
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  lines.push("");
  lines.push(commit.message);

  return encoder.encode(lines.join("\n"));
}

/**
 * Convert SHA string to 20-byte binary
 */
export function shaToBytes(sha: string): Uint8Array {
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(sha.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert 20-byte binary to SHA string
 */
export function bytesToSha(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}
