/**
 * API commit creation service.
 *
 * Builds git tree + blob objects directly in R2 and creates commits
 * without requiring a git push. The killer feature for AI agents.
 */

import { GitR2Storage } from "../git/storage";
import {
  hashGitObject,
  createCommit,
  parseGitObject,
  parseCommit,
  createTree,
  type TreeEntry,
} from "../git/objects";
import { flattenTree as flattenTreeFromSha } from "../git/cherry-pick";

export interface EditOperation {
  /** Replace lines [start, end] (1-based, inclusive). Use same start/end to insert before that line. */
  range?: [number, number];
  /** Find this exact string and replace it. Must be unique in the file. */
  old_string?: string;
  /** The replacement content. Omit with old_string to delete the match. */
  new_string?: string;
  /** New content for range-based edits. */
  content?: string;
}

export interface FileChange {
  path: string;
  content?: string;
  encoding?: "utf-8" | "base64";
  action?: "create" | "edit" | "delete" | "rename";
  /** For action: "edit" — array of surgical edits applied in order. */
  edits?: EditOperation[];
  /** For action: "rename" — new path for the file. */
  new_path?: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// Module-level KV ref — set by the commit route before calling createApiCommit.
let _treeCacheRef: KVNamespace | undefined;

export function setTreeCacheRef(kv: KVNamespace | undefined) {
  _treeCacheRef = kv;
}

/**
 * Flatten a commit's tree into a Map<path, {sha, mode}>.
 * Uses commit-level KV cache (ftree:{commitSha}) + delegates to cherry-pick's
 * flattenTree for the actual tree walk (with tree-level KV cache).
 */
async function flattenTreeFromCommit(
  storage: GitR2Storage,
  commitSha: string
): Promise<Map<string, { sha: string; mode: string }>> {
  const kv = _treeCacheRef;

  // Check KV cache (commitSha → flat tree is immutable)
  if (kv) {
    const cached = await kv.get(`ftree:${commitSha}`, "json") as Array<[string, { sha: string; mode: string }]> | null;
    if (cached) {
      return new Map(cached);
    }
  }

  // Cache miss — flatten from R2 using shared flattenTree (gets tree-level KV cache too)
  const raw = await storage.getObject(commitSha);
  if (!raw) throw new Error(`Commit not found: ${commitSha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") throw new Error(`Expected commit, got ${obj.type}`);
  const commit = parseCommit(obj.content);
  const tree = await flattenTreeFromSha(storage, commit.tree, "", undefined, kv);

  // Write to KV cache (fire-and-forget, no TTL — immutable)
  if (kv) {
    kv.put(`ftree:${commitSha}`, JSON.stringify([...tree.entries()])).catch(() => {});
  }

  return tree;
}

/**
 * Build nested git tree objects from a flat path map.
 */
async function buildTreeFromFlat(
  storage: GitR2Storage,
  flatMap: Map<string, { sha: string; mode: string }>
): Promise<string> {
  interface DirNode {
    entries: Map<string, TreeEntry>;
    subdirs: Map<string, DirNode>;
  }

  const root: DirNode = { entries: new Map(), subdirs: new Map() };

  for (const [path, entry] of flatMap) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.subdirs.has(parts[i])) {
        node.subdirs.set(parts[i], { entries: new Map(), subdirs: new Map() });
      }
      node = node.subdirs.get(parts[i])!;
    }
    const filename = parts[parts.length - 1];
    node.entries.set(filename, { mode: entry.mode, name: filename, sha: entry.sha });
  }

  const pendingTrees: { sha: string; type: "tree"; data: Uint8Array }[] = [];

  async function buildNode(node: DirNode): Promise<string> {
    const subdirEntries = await Promise.all(
      [...node.subdirs.entries()].map(async ([name, subdir]) => {
        const sha = await buildNode(subdir);
        return { mode: "40000", name, sha } as TreeEntry;
      })
    );

    const treeEntries: TreeEntry[] = [...subdirEntries, ...[...node.entries.values()]];
    const treeContent = createTree(treeEntries);
    const treeSha = await hashGitObject("tree", treeContent);
    pendingTrees.push({ sha: treeSha, type: "tree", data: treeContent });
    return treeSha;
  }

  const rootSha = await buildNode(root);
  await storage.putObjectBatch(pendingTrees);
  return rootSha;
}

/**
 * Apply surgical edits to file content.
 * Supports two modes:
 *   1. Range-based:  { range: [start, end], content: "..." }
 *   2. String match: { old_string: "...", new_string: "..." }
 *
 * Edits are applied bottom-to-top for range-based (so line numbers stay stable)
 * and sequentially for string-based.
 */
export function applyEdits(original: string, edits: EditOperation[]): string {
  let result = original;

  // Separate range edits and string edits
  const rangeEdits: (EditOperation & { range: [number, number] })[] = [];
  const stringEdits: EditOperation[] = [];

  for (const edit of edits) {
    if (edit.range) {
      rangeEdits.push(edit as EditOperation & { range: [number, number] });
    } else if (edit.old_string !== undefined) {
      stringEdits.push(edit);
    }
  }

  // Apply string-based edits first (sequential, order matters)
  for (const edit of stringEdits) {
    const idx = result.indexOf(edit.old_string!);
    if (idx === -1) {
      throw new EditConflictError(
        `String not found in file. Ensure old_string is unique and exact.`,
        edit.old_string!.slice(0, 80)
      );
    }
    // Check uniqueness
    const secondIdx = result.indexOf(edit.old_string!, idx + 1);
    if (secondIdx !== -1) {
      throw new EditConflictError(
        `old_string matches multiple locations. Provide more context to make it unique.`,
        edit.old_string!.slice(0, 80)
      );
    }
    result =
      result.slice(0, idx) +
      (edit.new_string ?? "") +
      result.slice(idx + edit.old_string!.length);
  }

  // Apply range-based edits bottom-to-top (so line numbers stay stable)
  if (rangeEdits.length > 0) {
    const sorted = [...rangeEdits].sort((a, b) => b.range[0] - a.range[0]);
    const lines = result.split("\n");

    for (const edit of sorted) {
      const [start, end] = edit.range;
      if (start < 1 || end < start || start > lines.length + 1) {
        throw new EditConflictError(
          `Invalid range [${start}, ${end}]. File has ${lines.length} lines.`,
          ""
        );
      }
      const newContent = edit.content ?? "";
      const newLines = newContent === "" ? [] : newContent.split("\n");
      // start-1 because lines array is 0-indexed, end-start+1 lines to replace
      const deleteCount = Math.min(end - start + 1, lines.length - start + 1);
      lines.splice(start - 1, deleteCount, ...newLines);
    }

    result = lines.join("\n");
  }

  return result;
}

export class EditConflictError extends Error {
  public context: string;
  constructor(message: string, context: string) {
    super(message);
    this.name = "EditConflictError";
    this.context = context;
  }
}

const encoder = new TextEncoder();

export class InvalidBase64Error extends Error {
  constructor(path: string) {
    super(`Invalid base64 content for file: ${path}`);
    this.name = "InvalidBase64Error";
  }
}

function base64ToBytes(base64: string, path: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new InvalidBase64Error(path);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a commit via API (no git push needed).
 *
 * 1. Reads current tree from branch HEAD (or parent_sha)
 * 2. Applies file changes (add/modify/delete)
 * 3. Creates git tree + blob objects in R2
 * 4. Creates commit object
 * 5. Updates branch ref with CAS (compare-and-swap) to prevent races
 */
export async function createApiCommit(
  storage: GitR2Storage,
  branch: string,
  message: string,
  author: CommitAuthor,
  changes: FileChange[],
  parentSha?: string
): Promise<{ sha: string; treeSha: string; parentSha: string; changedBlobs: Map<string, string> }> {
  // 1. Get current branch HEAD (with etag for CAS — avoids a second R2 read later)
  const headRef = await storage.getRefWithEtag(`refs/heads/${branch}`);
  const currentSha = headRef?.sha ?? null;
  const initialEtag = headRef?.etag;
  const effectiveParent = parentSha || currentSha;

  if (parentSha && currentSha && parentSha !== currentSha) {
    throw new ConflictError(
      "Branch has moved since parent_sha. Fetch latest HEAD and retry."
    );
  }

  // 2. Read current tree (or start with empty tree for first commit)
  let currentTree = new Map<string, { sha: string; mode: string }>();
  if (effectiveParent) {
    currentTree = await flattenTreeFromCommit(storage, effectiveParent);
  }

  // 3. Apply changes — collect blobs first, then batch-write to R2
  const pendingBlobs: { sha: string; type: "blob"; data: Uint8Array }[] = [];
  const changedBlobs = new Map<string, string>(); // path → blobSha for semantic indexing

  for (const change of changes) {
    const action = change.action || (change.content !== undefined ? "create" : undefined);

    if (action === "delete") {
      currentTree.delete(change.path);
    } else if (action === "rename") {
      if (!change.new_path) throw new Error(`new_path required for rename: ${change.path}`);
      const existing = currentTree.get(change.path);
      if (!existing) throw new Error(`File not found for rename: ${change.path}`);
      currentTree.delete(change.path);
      currentTree.set(change.new_path, existing);
      changedBlobs.set(change.new_path, existing.sha);
    } else if (action === "edit") {
      if (!change.edits || change.edits.length === 0) {
        throw new Error(`edits array required for action "edit": ${change.path}`);
      }
      // Read current file content from R2
      const existing = currentTree.get(change.path);
      if (!existing) throw new Error(`File not found for edit: ${change.path}`);
      const blobRaw = await storage.getObject(existing.sha);
      if (!blobRaw) throw new Error(`Blob not found: ${existing.sha}`);
      const blobObj = parseGitObject(blobRaw);
      const decoder = new TextDecoder();
      const originalContent = decoder.decode(blobObj.content);
      // Apply edits
      const edited = applyEdits(originalContent, change.edits);
      const editedBytes = encoder.encode(edited);
      const blobSha = await hashGitObject("blob", editedBytes);
      pendingBlobs.push({ sha: blobSha, type: "blob", data: editedBytes });
      currentTree.set(change.path, { sha: blobSha, mode: existing.mode });
      changedBlobs.set(change.path, blobSha);
    } else {
      // create / modify (default) — full content replacement
      if (!change.content && change.content !== "") {
        throw new Error(`Missing content for file: ${change.path}`);
      }
      const content =
        change.encoding === "base64"
          ? base64ToBytes(change.content, change.path)
          : encoder.encode(change.content);
      const blobSha = await hashGitObject("blob", content);
      pendingBlobs.push({ sha: blobSha, type: "blob", data: content });
      currentTree.set(change.path, { sha: blobSha, mode: "100644" });
      changedBlobs.set(change.path, blobSha);
    }
  }

  // Batch-write all blobs in parallel
  if (pendingBlobs.length > 0) {
    await storage.putObjectBatch(pendingBlobs);
  }

  // 4. Build nested tree objects
  const rootTreeSha = await buildTreeFromFlat(storage, currentTree);

  // 5. Create commit
  const timestamp = Math.floor(Date.now() / 1000);
  const authorStr = `${author.name} <${author.email}> ${timestamp} +0000`;
  const commitContent = createCommit({
    tree: rootTreeSha,
    parents: effectiveParent ? [effectiveParent] : [],
    author: authorStr,
    committer: authorStr,
    message,
  });
  const commitSha = await hashGitObject("commit", commitContent);

  // 6. Write commit + update ref with CAS (reuse etag from initial read)
  if (currentSha && initialEtag) {
    await storage.putObject(commitSha, "commit", commitContent);
    const ok = await storage.setRefConditional(
      `refs/heads/${branch}`,
      commitSha,
      initialEtag
    );
    if (!ok) {
      throw new ConflictError("Concurrent branch update. Retry.");
    }
  } else {
    // First commit — no CAS needed, write commit + ref in parallel
    await Promise.all([
      storage.putObject(commitSha, "commit", commitContent),
      storage.setRef(`refs/heads/${branch}`, commitSha),
    ]);
  }

  // Cache the new commit's flat tree for the next commit (fire-and-forget)
  const kv = _treeCacheRef;
  if (kv) {
    kv.put(`ftree:${commitSha}`, JSON.stringify([...currentTree.entries()])).catch(() => {});
  }

  return {
    sha: commitSha,
    treeSha: rootTreeSha,
    parentSha: effectiveParent || "",
    changedBlobs,
  };
}

export async function snapshotBranchTree(
  storage: GitR2Storage,
  branch: string
): Promise<Map<string, { sha: string; mode: string }>> {
  const head = await storage.getRef(`refs/heads/${branch}`);
  if (!head) return new Map();
  return flattenTreeFromCommit(storage, head);
}
