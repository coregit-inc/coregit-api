/**
 * Multi-repo workspace execution.
 *
 * Mounts multiple repos into a single virtual filesystem at /{slug}/,
 * executes commands, and optionally commits changes back to each repo.
 */

import { Bash } from "just-bash/browser";
import { GitR2Storage } from "../git/storage";
import { GitR2FileSystem, type FileChange } from "./filesystem";
import { MultiRepoFileSystem } from "./multi-repo-fs";
import {
  parseGitObject,
  parseCommit,
  hashGitObject,
  createCommit,
  createTree,
  type TreeEntry,
} from "../git/objects";

// ============ Types ============

export interface RepoMount {
  slug: string;
  storage: GitR2Storage;
  branch: string;
  commitSha: string;
  branchRef: string;
  treeSha: string;
  fs: GitR2FileSystem;
}

export interface MultiRepoExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  commit?: boolean;
  commitMessage?: string;
  author?: { name: string; email: string };
}

export interface MultiRepoExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles: Record<string, FileChange[]>;
  commits: Record<string, string>;
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

// ============ Multi-repo exec ============

export async function execInMultiRepoWorkspace(
  mounts: RepoMount[],
  command: string,
  options: MultiRepoExecOptions = {}
): Promise<MultiRepoExecResult> {
  const startTime = Date.now();

  // Create multi-repo filesystem
  const multiFs = new MultiRepoFileSystem(
    mounts.map((m) => ({ slug: m.slug, fs: m.fs }))
  );
  await multiFs.preload();

  // Create bash instance
  const bash = new Bash({
    fs: multiFs,
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

  // Execute
  const result = await bash.exec(command);

  let stdout = result.stdout;
  let stderr = result.stderr;
  if (stdout.length > MAX_OUTPUT_BYTES) {
    stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated at 1MB)\n";
  }
  if (stderr.length > MAX_OUTPUT_BYTES) {
    stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated at 1MB)\n";
  }

  // Collect changes per repo
  const changesByRepo = multiFs.getChangesByRepo();
  const changedFiles: Record<string, FileChange[]> = {};
  for (const [slug, changes] of changesByRepo) {
    changedFiles[slug] = changes;
  }

  // Commit per repo if requested
  const commits: Record<string, string> = {};
  if (options.commit && options.commitMessage) {
    for (const mount of mounts) {
      const repoChanges = changesByRepo.get(mount.slug);
      if (!repoChanges || repoChanges.length === 0) continue;

      const sha = await commitRepoChanges(
        mount.storage,
        mount.fs,
        mount.treeSha,
        mount.commitSha,
        mount.branchRef,
        options.commitMessage,
        options.author
      );
      commits[mount.slug] = sha;
    }
  }

  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
    changedFiles,
    commits,
    executionTimeMs: Date.now() - startTime,
  };
}

// ============ Commit Logic (per-repo) ============

async function commitRepoChanges(
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

  for (const [path, entry] of mergedTree) {
    if ("sha" in entry) {
      flatMap.set(path, entry);
    } else {
      const blobSha = await hashGitObject("blob", entry.content);
      pendingBlobs.push({ sha: blobSha, type: "blob" as const, data: entry.content });
      flatMap.set(path, { sha: blobSha, mode: entry.mode });
    }
  }

  if (pendingBlobs.length > 0) {
    await storage.putObjectBatch(pendingBlobs);
  }

  // Build nested tree
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
      await storage.setRef(branchRef, commitSha);
    }
  } else {
    await storage.setRef(branchRef, commitSha);
  }

  return commitSha;
}

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
