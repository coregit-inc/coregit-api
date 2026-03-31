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
  parseTree,
  createTree,
  type TreeEntry,
} from "../git/objects";

export interface FileChange {
  path: string;
  content?: string;
  encoding?: "utf-8" | "base64";
  action?: "delete";
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

/**
 * Recursively flatten a git tree into a Map<path, {sha, mode}>.
 */
async function flattenTreeFromCommit(
  storage: GitR2Storage,
  commitSha: string
): Promise<Map<string, { sha: string; mode: string }>> {
  const raw = await storage.getObject(commitSha);
  if (!raw) throw new Error(`Commit not found: ${commitSha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") throw new Error(`Expected commit, got ${obj.type}`);
  const commit = parseCommit(obj.content);
  return flattenTree(storage, commit.tree);
}

async function flattenTree(
  storage: GitR2Storage,
  treeSha: string,
  prefix = ""
): Promise<Map<string, { sha: string; mode: string }>> {
  const raw = await storage.getObject(treeSha);
  if (!raw) throw new Error(`Tree not found: ${treeSha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}`);
  const entries = parseTree(obj.content);
  const result = new Map<string, { sha: string; mode: string }>();

  const dirs = entries.filter((e) => e.mode === "40000");
  const files = entries.filter((e) => e.mode !== "40000");

  for (const entry of files) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.set(fullPath, { sha: entry.sha, mode: entry.mode });
  }

  if (dirs.length > 0) {
    const subtrees = await Promise.all(
      dirs.map((entry) => {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        return flattenTree(storage, entry.sha, fullPath);
      })
    );
    for (const subtree of subtrees) {
      for (const [path, val] of subtree) {
        result.set(path, val);
      }
    }
  }

  return result;
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
    await storage.putObject(treeSha, "tree", treeContent);
    return treeSha;
  }

  return buildNode(root);
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
): Promise<{ sha: string; treeSha: string; parentSha: string }> {
  // 1. Get current branch HEAD
  const currentSha = await storage.getRef(`refs/heads/${branch}`);
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

  // 3. Apply changes
  for (const change of changes) {
    if (change.action === "delete") {
      currentTree.delete(change.path);
    } else {
      if (!change.content && change.content !== "") {
        throw new Error(`Missing content for file: ${change.path}`);
      }
      const content =
        change.encoding === "base64"
          ? base64ToBytes(change.content, change.path)
          : encoder.encode(change.content);
      const blobSha = await hashGitObject("blob", content);
      await storage.putObject(blobSha, "blob", content);
      currentTree.set(change.path, { sha: blobSha, mode: "100644" });
    }
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
  await storage.putObject(commitSha, "commit", commitContent);

  // 6. Update branch ref with CAS
  if (currentSha) {
    const ref = await storage.getRefWithEtag(`refs/heads/${branch}`);
    if (ref) {
      const ok = await storage.setRefConditional(
        `refs/heads/${branch}`,
        commitSha,
        ref.etag
      );
      if (!ok) {
        throw new ConflictError("Concurrent branch update. Retry.");
      }
    } else {
      await storage.setRef(`refs/heads/${branch}`, commitSha);
    }
  } else {
    await storage.setRef(`refs/heads/${branch}`, commitSha);
  }

  return {
    sha: commitSha,
    treeSha: rootTreeSha,
    parentSha: effectiveParent || "",
  };
}
