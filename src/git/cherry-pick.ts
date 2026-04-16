/**
 * Git cherry-pick primitives for stacked changes
 *
 * Builds on objects.ts (parseCommit, parseTree, createTree, createCommit, hashGitObject)
 * and storage.ts (GitR2Storage) to provide commit-range walking, tree diffing,
 * and cherry-pick replay functionality.
 */

import {
  parseGitObject,
  parseCommit,
  parseTree,
  createTree,
  createCommit,
  hashGitObject,
  type Commit,
  type TreeEntry,
} from "./objects";
import { GitR2Storage } from "./storage";
import { merge3 } from "./merge3";

const encoder = new TextEncoder();

// ============ Types ============

export interface CommitInfo {
  sha: string;
  commit: Commit;
}

export interface FlatEntry {
  sha: string;
  mode: string;
}

export type FlatTree = Map<string, FlatEntry>;

export interface FileDiff {
  path: string;
  type: "add" | "modify" | "delete";
  oldSha?: string;
  newSha?: string;
  oldMode?: string;
  newMode?: string;
}

export interface CherryPickResult {
  success: boolean;
  headSha: string | null;
  conflicts?: string[];
  lastCleanSha?: string;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export class BaseCommitNotAncestorError extends Error {
  constructor(
    public baseExclusive: string,
    public headInclusive: string,
    public reason: "reached_root" | "safety_limit",
    public safetyLimit?: number
  ) {
    const detail =
      reason === "reached_root"
        ? " (reached root)"
        : ` within ${safetyLimit ?? "unknown"} commits`;
    super(`Base commit ${baseExclusive} is not reachable from ${headInclusive}${detail}`);
    this.name = "BaseCommitNotAncestorError";
    Object.setPrototypeOf(this, BaseCommitNotAncestorError.prototype);
  }
}

/** instanceof may fail in bundled environments (Cloudflare Workers / esbuild). */
export function isBaseCommitNotAncestorError(err: unknown): err is BaseCommitNotAncestorError {
  if (err instanceof BaseCommitNotAncestorError) return true;
  return err instanceof Error && err.name === "BaseCommitNotAncestorError";
}

// ============ Helpers ============

async function getCommitObj(storage: GitR2Storage, sha: string): Promise<Commit> {
  const raw = await storage.getObject(sha);
  if (!raw) throw new Error(`Commit object not found: ${sha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") throw new Error(`Expected commit, got ${obj.type}: ${sha}`);
  return parseCommit(obj.content);
}

async function getTreeEntries(storage: GitR2Storage, treeSha: string): Promise<TreeEntry[]> {
  const raw = await storage.getObject(treeSha);
  if (!raw) throw new Error(`Tree object not found: ${treeSha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}: ${treeSha}`);
  return parseTree(obj.content);
}

// ============ Core Functions ============

/**
 * Walk first-parent chain from head backward until reaching base.
 * Returns commits in chronological order (oldest first).
 * baseExclusive is NOT included in the result.
 */
export async function getCommitRange(
  storage: GitR2Storage,
  baseExclusive: string,
  headInclusive: string
): Promise<CommitInfo[]> {
  const commits: CommitInfo[] = [];
  let current = headInclusive;
  const SAFETY_LIMIT = 200;

  while (current !== baseExclusive && commits.length < SAFETY_LIMIT) {
    const commit = await getCommitObj(storage, current);
    commits.push({ sha: current, commit });

    // Walk first-parent only
    if (commit.parents.length === 0) {
      // Reached root without finding base
      throw new BaseCommitNotAncestorError(baseExclusive, headInclusive, "reached_root");
    }
    current = commit.parents[0];
  }

  if (current !== baseExclusive) {
    throw new BaseCommitNotAncestorError(
      baseExclusive,
      headInclusive,
      "safety_limit",
      SAFETY_LIMIT
    );
  }

  // Reverse to chronological order (oldest first)
  commits.reverse();
  return commits;
}

/**
 * Walk the first-parent chain from head to root, returning all commits
 * in chronological order (oldest first). Used as a fallback when
 * getCommitRange fails because the base commit is unreachable.
 */
export async function walkFirstParentChain(
  storage: GitR2Storage,
  headInclusive: string
): Promise<CommitInfo[]> {
  const commits: CommitInfo[] = [];
  let current: string | null = headInclusive;
  const SAFETY_LIMIT = 200;

  while (current && commits.length < SAFETY_LIMIT) {
    const commit = await getCommitObj(storage, current);
    commits.push({ sha: current, commit });
    current = commit.parents.length > 0 ? commit.parents[0] : null;
  }

  commits.reverse();
  return commits;
}

/**
 * Recursively flatten a git tree into a Map<path, {sha, mode}>.
 * All sibling directories are fetched in parallel (BFS per level).
 *
 * Caching layers:
 *   L1: in-memory `treeCache` Map (per-request, cross-call dedup)
 *   L2: KV `kvCache` (cross-request, keyed by root treeSha — immutable)
 */
export async function flattenTree(
  storage: GitR2Storage,
  treeSha: string,
  prefix: string = "",
  treeCache?: Map<string, FlatTree>,
  kvCache?: KVNamespace
): Promise<FlatTree> {
  // Check cross-call cache for this exact subtree
  const cacheKey = `${treeSha}:${prefix}`;
  if (treeCache) {
    const cached = treeCache.get(cacheKey);
    if (cached) return cached;
  }

  // L2: KV cache — only on root call (prefix === "") to avoid per-subtree KV lookups
  if (prefix === "" && kvCache) {
    const kvKey = `ftree:${treeSha}`;
    const cached = await kvCache.get(kvKey, "json") as Array<[string, FlatEntry]> | null;
    if (cached) {
      const result: FlatTree = new Map(cached);
      if (treeCache) treeCache.set(cacheKey, result);
      return result;
    }
  }

  const entries = await getTreeEntries(storage, treeSha);
  const result: FlatTree = new Map();

  const dirEntries = entries.filter(e => e.mode === "40000");
  const fileEntries = entries.filter(e => e.mode !== "40000");

  // Files: add immediately — no I/O needed
  for (const entry of fileEntries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.set(fullPath, { sha: entry.sha, mode: entry.mode });
  }

  // Directories: recurse all siblings in parallel
  if (dirEntries.length > 0) {
    const subtrees = await Promise.all(
      dirEntries.map(entry => {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        return flattenTree(storage, entry.sha, fullPath, treeCache);
      })
    );
    for (const subtree of subtrees) {
      for (const [path, val] of subtree) {
        result.set(path, val);
      }
    }
  }

  // Store in L1 cache for reuse
  if (treeCache) {
    treeCache.set(cacheKey, result);
  }

  // Store in L2 KV — only root call, fire-and-forget (tree SHA is immutable, no TTL)
  if (prefix === "" && kvCache) {
    const kvKey = `ftree:${treeSha}`;
    kvCache.put(kvKey, JSON.stringify([...result.entries()])).catch(() => {});
  }

  return result;
}

/**
 * Compare two flat trees and produce a list of file-level diffs.
 */
export function diffFlattenedTrees(treeA: FlatTree, treeB: FlatTree): FileDiff[] {
  const diffs: FileDiff[] = [];

  // Files in B but not in A (added), or different in B (modified)
  for (const [path, entryB] of treeB) {
    const entryA = treeA.get(path);
    if (!entryA) {
      diffs.push({ path, type: "add", newSha: entryB.sha, newMode: entryB.mode });
    } else if (entryA.sha !== entryB.sha || entryA.mode !== entryB.mode) {
      diffs.push({
        path,
        type: "modify",
        oldSha: entryA.sha,
        oldMode: entryA.mode,
        newSha: entryB.sha,
        newMode: entryB.mode,
      });
    }
  }

  // Files in A but not in B (deleted)
  for (const [path, entryA] of treeA) {
    if (!treeB.has(path)) {
      diffs.push({ path, type: "delete", oldSha: entryA.sha, oldMode: entryA.mode });
    }
  }

  return diffs;
}

/**
 * Apply file-level diffs onto a base tree with 3-way conflict detection.
 *
 * originalBaseTreeSha = the tree the diffs were computed against (commit's parent tree)
 * baseTreeSha = the tree we're applying onto (the new base)
 *
 * For each diff:
 * - add: if file already exists in new base with different content -> conflict
 * - modify: if file in new base differs from originalBase -> conflict (both sides changed)
 * - delete: if file in new base differs from originalBase -> conflict
 *
 * Returns {treeSha, conflicts}. If conflicts is non-empty, treeSha is null.
 */
export async function applyDiffsToTree(
  storage: GitR2Storage,
  baseTreeSha: string,
  diffs: FileDiff[],
  originalBaseTreeSha: string,
  treeCache?: Map<string, FlatTree>
): Promise<{ treeSha: string | null; conflicts: string[] }> {
  // Fetch both trees in parallel (with shared cache)
  const [baseFlat, originalBaseFlat] = await Promise.all([
    flattenTree(storage, baseTreeSha, "", treeCache),
    flattenTree(storage, originalBaseTreeSha, "", treeCache),
  ]);
  const conflicts: string[] = [];

  // Build result flat tree starting from base
  const resultFlat = new Map(baseFlat);

  for (const diff of diffs) {
    const baseEntry = baseFlat.get(diff.path);
    const origEntry = originalBaseFlat.get(diff.path);

    switch (diff.type) {
      case "add": {
        if (baseEntry) {
          // File exists in new base — check if it's the same as what we're adding
          if (baseEntry.sha !== diff.newSha) {
            // Both sides added the file with different content — try 3-way merge with empty base
            const [oursContent, theirsContent] = await Promise.all([
              getBlobContent(storage, diff.newSha!),
              getBlobContent(storage, baseEntry.sha),
            ]);

            if (oursContent != null && theirsContent != null) {
              const result = merge3("", oursContent, theirsContent);
              if (result.success) {
                const merged = encoder.encode(result.mergedContent!);
                const sha = await hashGitObject("blob", merged);
                await storage.putObject(sha, "blob", merged);
                resultFlat.set(diff.path, { sha, mode: diff.newMode || "100644" });
                continue;
              }
            }
            conflicts.push(diff.path);
            continue;
          }
          // Same content — no conflict, already present
        }
        resultFlat.set(diff.path, { sha: diff.newSha!, mode: diff.newMode! });
        break;
      }
      case "modify": {
        if (!baseEntry) {
          // File was deleted in new base but modified in cherry-pick → delete/modify conflict
          conflicts.push(diff.path);
          continue;
        }
        // Check if base also changed from original
        const origSha = origEntry?.sha;
        if (baseEntry.sha !== origSha && baseEntry.sha !== diff.newSha) {
          // Both sides changed the file differently — try content-level 3-way merge
          const [baseContent, oursContent, theirsContent] = await Promise.all([
            getBlobContent(storage, origSha!),
            getBlobContent(storage, diff.newSha!),
            getBlobContent(storage, baseEntry.sha),
          ]);

          if (baseContent != null && oursContent != null && theirsContent != null) {
            const result = merge3(baseContent, oursContent, theirsContent);
            if (result.success) {
              // Auto-merge succeeded — create new blob
              const merged = encoder.encode(result.mergedContent!);
              const sha = await hashGitObject("blob", merged);
              await storage.putObject(sha, "blob", merged);
              resultFlat.set(diff.path, { sha, mode: diff.newMode || "100644" });
              continue; // Not a conflict!
            }
          }
          // Merge failed or binary file
          conflicts.push(diff.path);
          continue;
        }
        // Apply the modification
        if (diff.newSha) {
          resultFlat.set(diff.path, { sha: diff.newSha, mode: diff.newMode || "100644" });
        }
        break;
      }
      case "delete": {
        if (baseEntry) {
          const origSha = origEntry?.sha;
          if (baseEntry.sha !== origSha) {
            // File changed in new base — conflict
            conflicts.push(diff.path);
            continue;
          }
        }
        resultFlat.delete(diff.path);
        break;
      }
    }
  }

  if (conflicts.length > 0) {
    return { treeSha: null, conflicts };
  }

  const treeSha = await buildTreeFromFlat(storage, resultFlat);
  return { treeSha, conflicts: [] };
}

/**
 * Rebuild nested git tree objects from a flat path map.
 * Stores all new tree objects to R2 and returns the root tree SHA.
 */
export async function buildTreeFromFlat(
  storage: GitR2Storage,
  flatMap: FlatTree
): Promise<string> {
  // Group entries by directory
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

  // Collect all tree objects, then batch-write at the end
  const pendingTrees: { sha: string; type: "tree"; data: Uint8Array }[] = [];
  const seenShas = new Set<string>();

  // Build trees bottom-up, all siblings in parallel
  async function buildNode(node: DirNode): Promise<string> {
    // Process all subdirectories in parallel
    const subdirEntries = await Promise.all(
      [...node.subdirs.entries()].map(async ([name, subdir]) => {
        const subdirSha = await buildNode(subdir);
        return { mode: "40000", name, sha: subdirSha } as TreeEntry;
      })
    );

    const treeEntries: TreeEntry[] = [
      ...subdirEntries,
      ...[...node.entries.values()],
    ];

    const treeContent = createTree(treeEntries);
    const treeSha = await hashGitObject("tree", treeContent);

    if (!seenShas.has(treeSha)) {
      seenShas.add(treeSha);
      pendingTrees.push({ sha: treeSha, type: "tree", data: treeContent });
    }

    return treeSha;
  }

  const rootSha = await buildNode(root);
  await storage.putObjectBatch(pendingTrees);
  return rootSha;
}

/**
 * Cherry-pick a sequence of commits onto a base.
 *
 * For each commit: compute its diff (commit tree vs parent tree),
 * apply onto current base, create new commit.
 *
 * If any conflict -> stop immediately.
 */
export async function cherryPickCommits(
  storage: GitR2Storage,
  commits: CommitInfo[],
  ontoBaseSha: string
): Promise<CherryPickResult> {
  let currentBaseSha = ontoBaseSha;
  let currentBaseCommit = await getCommitObj(storage, ontoBaseSha);
  let lastCleanSha = ontoBaseSha;

  // Shared tree cache across all iterations — overlapping subtrees are fetched once
  const treeCache = new Map<string, FlatTree>();

  // Track parent tree from previous iteration to avoid redundant getCommitObj calls.
  // commits[] is in chronological order (oldest first), so commits[i].commit.parents[0]
  // === commits[i-1].sha for a linear chain — we already have its tree.
  let prevOriginalTree: string | null = null;

  for (let i = 0; i < commits.length; i++) {
    const { commit: originalCommit } = commits[i];

    // Get the original commit's parent tree (what the diff is relative to)
    let originalParentTreeSha: string;
    if (i === 0) {
      // First commit — must fetch parent from storage
      const originalParentSha = originalCommit.parents[0];
      if (originalParentSha) {
        const parentCommit = await getCommitObj(storage, originalParentSha);
        originalParentTreeSha = parentCommit.tree;
      } else {
        // Root commit — diff against empty tree
        originalParentTreeSha = await buildTreeFromFlat(storage, new Map());
      }
    } else {
      // Parent is commits[i-1], whose tree we already know
      originalParentTreeSha = prevOriginalTree!;
    }
    prevOriginalTree = originalCommit.tree;

    // Compute diff of this commit — both trees fetched in parallel by flattenTree
    // (shared treeCache avoids re-flattening overlapping subtrees across iterations)
    const [originalParentFlat, originalFlat] = await Promise.all([
      flattenTree(storage, originalParentTreeSha, "", treeCache),
      flattenTree(storage, originalCommit.tree, "", treeCache),
    ]);
    const diffs = diffFlattenedTrees(originalParentFlat, originalFlat);

    if (diffs.length === 0) {
      // Empty commit — skip but maintain chain
      continue;
    }

    // Apply diffs onto current base tree
    const { treeSha, conflicts } = await applyDiffsToTree(
      storage,
      currentBaseCommit.tree,
      diffs,
      originalParentTreeSha,
      treeCache
    );

    if (conflicts.length > 0) {
      return {
        success: false,
        headSha: null,
        conflicts,
        lastCleanSha,
      };
    }

    // Create new commit with the cherry-picked tree
    const newCommitContent = createCommit({
      tree: treeSha!,
      parents: [currentBaseSha],
      author: originalCommit.author,
      committer: originalCommit.committer,
      message: originalCommit.message,
    });

    const newCommitSha = await hashGitObject("commit", newCommitContent);

    // Write unconditionally — content-addressed, idempotent
    await storage.putObject(newCommitSha, "commit", newCommitContent);

    // Advance base
    currentBaseSha = newCommitSha;
    currentBaseCommit = {
      tree: treeSha!,
      parents: [lastCleanSha],
      author: originalCommit.author,
      committer: originalCommit.committer,
      message: originalCommit.message,
    };
    lastCleanSha = newCommitSha;
  }

  return {
    success: true,
    headSha: currentBaseSha === ontoBaseSha ? null : currentBaseSha,
  };
}

/**
 * Find the merge base (common ancestor) of two commits.
 * Uses breadth-first walk of both histories.
 */
export async function findMergeBase(
  storage: GitR2Storage,
  sha1: string,
  sha2: string
): Promise<string | null> {
  const visited1 = new Set<string>();
  const visited2 = new Set<string>();
  const queue1: string[] = [sha1];
  const queue2: string[] = [sha2];

  const LIMIT = 500;
  let steps = 0;

  while ((queue1.length > 0 || queue2.length > 0) && steps < LIMIT) {
    // Walk sha1's history
    if (queue1.length > 0) {
      const current = queue1.shift()!;
      if (visited2.has(current)) return current;
      if (!visited1.has(current)) {
        visited1.add(current);
        steps++;
        try {
          const commit = await getCommitObj(storage, current);
          for (const parent of commit.parents) {
            if (!visited1.has(parent)) queue1.push(parent);
          }
        } catch {
          // Object not found — stop this branch
        }
      }
    }

    // Walk sha2's history
    if (queue2.length > 0) {
      const current = queue2.shift()!;
      if (visited1.has(current)) return current;
      if (!visited2.has(current)) {
        visited2.add(current);
        steps++;
        try {
          const commit = await getCommitObj(storage, current);
          for (const parent of commit.parents) {
            if (!visited2.has(parent)) queue2.push(parent);
          }
        } catch {
          // Object not found — stop this branch
        }
      }
    }
  }

  return null;
}

/**
 * Compute diff stats (filesChanged, additions, deletions) by comparing blob sizes.
 * This is a rough approximation since we don't do line-level diffing.
 * For accurate line counts, we compare blob contents.
 */
export async function computeDiffStats(
  storage: GitR2Storage,
  baseTreeSha: string,
  headTreeSha: string
): Promise<DiffStats> {
  // Fetch both trees in parallel
  const [baseFlat, headFlat] = await Promise.all([
    flattenTree(storage, baseTreeSha),
    flattenTree(storage, headTreeSha),
  ]);
  const diffs = diffFlattenedTrees(baseFlat, headFlat);

  // Read all blobs in parallel
  const results = await Promise.all(
    diffs.map(async (diff) => {
      let add = 0;
      let del = 0;
      switch (diff.type) {
        case "add": {
          const content = await getBlobContent(storage, diff.newSha!);
          if (content) add = countLines(content);
          break;
        }
        case "delete": {
          const content = await getBlobContent(storage, diff.oldSha!);
          if (content) del = countLines(content);
          break;
        }
        case "modify": {
          const [oldContent, newContent] = await Promise.all([
            getBlobContent(storage, diff.oldSha!),
            getBlobContent(storage, diff.newSha!),
          ]);
          if (oldContent && newContent) {
            const oldLines = oldContent.split("\n");
            const newLines = newContent.split("\n");
            const maxLen = Math.max(oldLines.length, newLines.length);
            for (let i = 0; i < maxLen; i++) {
              const ol = oldLines[i];
              const nl = newLines[i];
              if (ol !== nl) {
                if (ol !== undefined) del++;
                if (nl !== undefined) add++;
              }
            }
          }
          break;
        }
      }
      return { add, del };
    })
  );

  const additions = results.reduce((s, r) => s + r.add, 0);
  const deletions = results.reduce((s, r) => s + r.del, 0);

  return { filesChanged: diffs.length, additions, deletions };
}

/**
 * Compute diff stats from pre-computed diffs — avoids redundant tree flattening.
 * Use this when you already have FileDiff[] from diffFlattenedTrees().
 */
export async function computeDiffStatsFromDiffs(
  storage: GitR2Storage,
  diffs: FileDiff[]
): Promise<DiffStats> {
  const results = await Promise.all(
    diffs.map(async (diff) => {
      let add = 0;
      let del = 0;
      switch (diff.type) {
        case "add": {
          const content = await getBlobContent(storage, diff.newSha!);
          if (content) add = countLines(content);
          break;
        }
        case "delete": {
          const content = await getBlobContent(storage, diff.oldSha!);
          if (content) del = countLines(content);
          break;
        }
        case "modify": {
          const [oldContent, newContent] = await Promise.all([
            getBlobContent(storage, diff.oldSha!),
            getBlobContent(storage, diff.newSha!),
          ]);
          if (oldContent && newContent) {
            const oldLines = oldContent.split("\n");
            const newLines = newContent.split("\n");
            const maxLen = Math.max(oldLines.length, newLines.length);
            for (let i = 0; i < maxLen; i++) {
              const ol = oldLines[i];
              const nl = newLines[i];
              if (ol !== nl) {
                if (ol !== undefined) del++;
                if (nl !== undefined) add++;
              }
            }
          }
          break;
        }
      }
      return { add, del };
    })
  );

  const additions = results.reduce((s, r) => s + r.add, 0);
  const deletions = results.reduce((s, r) => s + r.del, 0);

  return { filesChanged: diffs.length, additions, deletions };
}

export async function getBlobContent(storage: GitR2Storage, sha: string): Promise<string | null> {
  const raw = await storage.getObject(sha);
  if (!raw) return null;
  const obj = parseGitObject(raw);
  if (obj.type !== "blob") return null;
  return new TextDecoder().decode(obj.content);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}
