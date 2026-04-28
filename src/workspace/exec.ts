/**
 * Workspace command execution service.
 *
 * Creates a just-bash instance with GitR2FileSystem,
 * runs commands, and optionally commits changes back to git.
 */

import { Bash } from "just-bash/browser";
import { GitR2Storage } from "../git/storage";
import { GitR2FileSystem, type FileChange } from "./filesystem";
import {
  parseGitObject,
  parseCommit,
  hashGitObject,
  createCommit,
  createTree,
  type TreeEntry,
} from "../git/objects";
import { applyPreApplyChanges, type PreApplyChange } from "./pre-apply";

// ============ Types ============

export interface ExecOptions {
  branch?: string;
  ref?: string;
  cwd?: string;
  env?: Record<string, string>;
  commit?: boolean;
  commitMessage?: string;
  author?: { name: string; email: string };
  preApplyChanges?: PreApplyChange[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles: FileChange[];
  commitSha?: string;
  executionTimeMs: number;
}

// ============ Constants ============

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB
const EXECUTION_LIMITS = {
  maxCommandCount: 5000,
  maxLoopIterations: 5000,
  maxCallDepth: 50,
  maxAwkIterations: 5000,
  maxSedIterations: 5000,
};

// ============ Exec Service ============

export async function execInWorkspace(
  storage: GitR2Storage,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const startTime = Date.now();
  const branch = options.branch;
  const ref = options.ref;

  // 1. Resolve ref/branch → commit → tree
  let commitSha: string | null = null;
  let branchRef: string | null = null;

  if (ref) {
    // Resolve arbitrary ref (SHA, branch name, tag)
    commitSha = await resolveRefToCommit(storage, ref);
    if (!commitSha) {
      return {
        stdout: "",
        stderr: `fatal: ref '${ref}' not found\n`,
        exitCode: 128,
        changedFiles: [],
        executionTimeMs: Date.now() - startTime,
      };
    }
    // If branch is also provided, use it for committing
    if (branch) {
      branchRef = `refs/heads/${branch}`;
    }
  } else {
    // Default: resolve branch (backwards compatible)
    const targetBranch = branch || "main";
    branchRef = `refs/heads/${targetBranch}`;
    commitSha = await storage.getRef(branchRef);
    if (!commitSha) {
      return {
        stdout: "",
        stderr: `fatal: branch '${targetBranch}' not found\n`,
        exitCode: 128,
        changedFiles: [],
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  const commitRaw = await storage.getObject(commitSha);
  if (!commitRaw) {
    return {
      stdout: "",
      stderr: `fatal: commit object not found\n`,
      exitCode: 128,
      changedFiles: [],
      executionTimeMs: Date.now() - startTime,
    };
  }

  const commitObj = parseGitObject(commitRaw);
  if (commitObj.type !== "commit") {
    return {
      stdout: "",
      stderr: "fatal: object is not a commit\n",
      exitCode: 128,
      changedFiles: [],
      executionTimeMs: Date.now() - startTime,
    };
  }

  const commit = parseCommit(commitObj.content);
  const treeSha = commit.tree;

  // 2. Create filesystem and preload path index
  const fs = new GitR2FileSystem(storage, treeSha);
  await fs.preload();

  // 2b. Apply SDK-buffered changes (commitMode: manual / on-exec) so the bash
  //     command sees them. They land in fs.getChanges() and get committed if
  //     options.commit === true.
  if (options.preApplyChanges && options.preApplyChanges.length > 0) {
    try {
      await applyPreApplyChanges(fs, options.preApplyChanges);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        stdout: "",
        stderr: `pre-apply failed: ${msg}\n`,
        exitCode: 1,
        changedFiles: [],
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  // 3. Create bash instance
  const bash = new Bash({
    fs,
    cwd: options.cwd || "/",
    env: {
      HOME: "/",
      USER: "workspace",
      PATH: "/bin:/usr/bin",
      TERM: "dumb",
      ...options.env,
    },
    executionLimits: EXECUTION_LIMITS,
  });

  // 4. Execute command
  const result = await bash.exec(command);

  // Truncate output
  let stdout = result.stdout;
  let stderr = result.stderr;
  if (stdout.length > MAX_OUTPUT_BYTES) {
    stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated at 1MB)\n";
  }
  if (stderr.length > MAX_OUTPUT_BYTES) {
    stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated at 1MB)\n";
  }

  // 5. Collect changes
  const changedFiles = fs.getChanges();

  // 6. Optionally commit
  let newCommitSha: string | undefined;

  if (options.commit && changedFiles.length > 0) {
    if (!branchRef) {
      return {
        stdout,
        stderr: stderr + "error: branch is required when commit=true with a ref\n",
        exitCode: 1,
        changedFiles,
        executionTimeMs: Date.now() - startTime,
      };
    }
    if (!options.commitMessage) {
      return {
        stdout,
        stderr: stderr + "error: commit_message is required when commit=true\n",
        exitCode: 1,
        changedFiles,
        executionTimeMs: Date.now() - startTime,
      };
    }

    newCommitSha = await commitChanges(
      storage,
      fs,
      treeSha,
      commitSha,
      branchRef,
      options.commitMessage,
      options.author
    );
  }

  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
    changedFiles,
    commitSha: newCommitSha,
    executionTimeMs: Date.now() - startTime,
  };
}

// ============ Commit Logic ============

async function commitChanges(
  storage: GitR2Storage,
  fs: GitR2FileSystem,
  originalTreeSha: string,
  parentCommitSha: string,
  branchRef: string,
  message: string,
  author?: { name: string; email: string }
): Promise<string> {
  const mergedTree = fs.getMergedFlatTree();

  // Build FlatTree: store new blobs, keep existing SHAs
  const flatMap = new Map<string, { sha: string; mode: string }>();
  const pendingBlobs: { sha: string; type: "blob"; data: Uint8Array }[] = [];
  const encoder = new TextEncoder();

  for (const [path, entry] of mergedTree) {
    if ("sha" in entry) {
      flatMap.set(path, entry);
    } else {
      const blobSha = await hashGitObject("blob", entry.content);
      pendingBlobs.push({ sha: blobSha, type: "blob" as const, data: entry.content });
      flatMap.set(path, { sha: blobSha, mode: entry.mode });
    }
  }

  // Batch-write blobs
  if (pendingBlobs.length > 0) {
    await storage.putObjectBatch(pendingBlobs);
  }

  // Build nested tree structure (same pattern as commit-builder.ts)
  const newTreeSha = await buildTreeFromFlat(storage, flatMap);

  if (newTreeSha === originalTreeSha) return parentCommitSha;

  // Create commit
  const now = Math.floor(Date.now() / 1000);
  const authorName = author?.name || "Workspace";
  const authorEmail = author?.email || "workspace@coregit.dev";
  const authorLine = `${authorName} <${authorEmail}> ${now} +0000`;

  const commitContent = createCommit({
    tree: newTreeSha,
    parents: [parentCommitSha],
    author: authorLine,
    committer: authorLine,
    message,
  });

  const commitSha = await hashGitObject("commit", commitContent);
  await storage.putObject(commitSha, "commit", commitContent);

  // Update branch ref with CAS
  const ref = await storage.getRefWithEtag(branchRef);
  if (ref) {
    const ok = await storage.setRefConditional(branchRef, commitSha, ref.etag);
    if (!ok) {
      // CAS failed — still return the commit SHA, caller can retry
      await storage.setRef(branchRef, commitSha);
    }
  } else {
    await storage.setRef(branchRef, commitSha);
  }

  return commitSha;
}

/**
 * Resolve a ref string (branch name, tag name, or SHA) to a commit SHA.
 */
async function resolveRefToCommit(storage: GitR2Storage, ref: string): Promise<string | null> {
  if (ref === "HEAD") return storage.resolveHead();
  const [branchSha, tagSha] = await Promise.all([
    storage.getRef(`refs/heads/${ref}`),
    storage.getRef(`refs/tags/${ref}`),
  ]);
  if (branchSha) return branchSha;
  if (tagSha) return tagSha;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const exists = await storage.hasObject(ref);
    if (exists) return ref;
  }
  return null;
}

/**
 * Build nested git tree objects from a flat path map.
 * (Same logic as commit-builder.ts buildTreeFromFlat)
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
    pendingTrees.push({ sha: treeSha, type: "tree" as const, data: treeContent });
    return treeSha;
  }

  const rootSha = await buildNode(root);
  await storage.putObjectBatch(pendingTrees);
  return rootSha;
}
