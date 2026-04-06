/**
 * Export CoreGit repository to GitHub via Git Data API.
 *
 * Algorithm:
 * 1. snapshotBranchTree() → current CoreGit tree
 * 2. If lastSyncedSha exists → snapshot old tree, compute diff
 * 3. GitHub Git Data API (atomic commit):
 *    - POST /repos/{owner}/{repo}/git/blobs — create blobs (parallel, batches of 20)
 *    - POST /repos/{owner}/{repo}/git/trees — create tree
 *    - POST /repos/{owner}/{repo}/git/commits — create commit
 *    - PATCH /repos/{owner}/{repo}/git/refs/heads/{branch} — update ref
 * 4. Return new GitHub commit SHA
 */

import { GitR2Storage } from "../git/storage";
import { snapshotBranchTree } from "./commit-builder";
import { parseGitObject, parseCommit, parseTree } from "../git/objects";

const GH_API = "https://api.github.com";
const USER_AGENT = "coregit-sync/0.1";
const BLOB_BATCH_SIZE = 20;

interface GithubExportParams {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  storage: GitR2Storage;
  lastSyncedSha: string | null;
  commitMessage?: string;
}

interface GithubExportResult {
  githubSha: string;
  filesChanged: number;
  skipped: boolean;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
}

/** Get the latest commit SHA on a branch. */
async function getRemoteHeadSha(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string | null> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    { headers: githubHeaders(token) }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ref lookup failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { object: { sha: string } };
  return data.object.sha;
}

/** Create a blob on GitHub. Returns the blob SHA. */
async function createBlob(
  token: string,
  owner: string,
  repo: string,
  content: string,
  encoding: "base64" | "utf-8"
): Promise<string> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ content, encoding }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub blob creation failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/** Create a tree on GitHub. */
async function createTree(
  token: string,
  owner: string,
  repo: string,
  baseTree: string | null,
  treeEntries: Array<{ path: string; mode: string; type: string; sha: string | null }>
): Promise<string> {
  const body: Record<string, unknown> = { tree: treeEntries };
  if (baseTree) body.base_tree = baseTree;
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub tree creation failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/** Create a commit on GitHub. */
async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parents: string[]
): Promise<string> {
  const res = await fetch(`${GH_API}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ message, tree: treeSha, parents }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub commit creation failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/** Update (or create) a branch ref on GitHub. */
async function updateRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
  force: boolean
): Promise<void> {
  // Try to update existing ref first
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      headers: githubHeaders(token),
      body: JSON.stringify({ sha, force }),
    }
  );
  if (res.status === 422) {
    // Ref doesn't exist — create it
    const createRes = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`GitHub ref creation failed: ${createRes.status} ${text}`);
    }
    return;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ref update failed: ${res.status} ${text}`);
  }
}

/** Initialize an empty GitHub repo by creating a dummy file via Contents API. */
async function initializeEmptyRepo(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  const res = await fetch(
    `${GH_API}/repos/${owner}/${repo}/contents/.coregit-init`,
    {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify({
        message: "Initialize repository for CoreGit sync",
        content: btoa(""),
        branch,
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to initialize GitHub repo: ${res.status} ${text}`);
  }
}

/** Read a blob from CoreGit storage and return base64 content. */
async function readBlobAsBase64(storage: GitR2Storage, sha: string): Promise<string> {
  const raw = await storage.getObject(sha);
  if (!raw) throw new Error(`Blob not found in CoreGit: ${sha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
  return Buffer.from(obj.content).toString("base64");
}

export async function exportToGithub(params: GithubExportParams): Promise<GithubExportResult> {
  const { token, owner, repo, branch, storage, lastSyncedSha, commitMessage } = params;

  // 1. Get current CoreGit tree
  const currentTree = await snapshotBranchTree(storage, branch);
  if (currentTree.size === 0) {
    return { githubSha: "", filesChanged: 0, skipped: true };
  }

  // 2. Get old tree if we have a last synced commit
  let oldTree = new Map<string, { sha: string; mode: string }>();
  if (lastSyncedSha) {
    const raw = await storage.getObject(lastSyncedSha);
    if (raw) {
      const obj = parseGitObject(raw);
      if (obj.type === "commit") {
        const commit = parseCommit(obj.content);
        oldTree = await flattenTreeFromSha(storage, commit.tree);
      }
    }
  }

  // 3. Compute diff
  const changedFiles: Array<{ path: string; sha: string; mode: string }> = [];
  const deletedFiles: string[] = [];

  for (const [path, entry] of currentTree) {
    const old = oldTree.get(path);
    if (!old || old.sha !== entry.sha) {
      changedFiles.push({ path, sha: entry.sha, mode: entry.mode });
    }
  }

  if (lastSyncedSha) {
    for (const path of oldTree.keys()) {
      if (!currentTree.has(path)) {
        deletedFiles.push(path);
      }
    }
  }

  const totalChanges = changedFiles.length + deletedFiles.length;
  if (totalChanges === 0) {
    return { githubSha: "", filesChanged: 0, skipped: true };
  }

  // 4. Get remote HEAD (needed before blob creation — Git Data API requires ≥1 commit)
  let remoteHead = await getRemoteHeadSha(token, owner, repo, branch);

  // If repo is empty, initialize it first
  if (remoteHead === null) {
    await initializeEmptyRepo(token, owner, repo, branch);
    remoteHead = await getRemoteHeadSha(token, owner, repo, branch);
  }

  // 5. Create blobs on GitHub in parallel batches
  const blobMap = new Map<string, string>(); // CoreGit SHA → GitHub blob SHA

  for (let i = 0; i < changedFiles.length; i += BLOB_BATCH_SIZE) {
    const batch = changedFiles.slice(i, i + BLOB_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (file) => {
        // Skip if we already created this blob (same content, different path)
        if (blobMap.has(file.sha)) return { sha: file.sha, ghSha: blobMap.get(file.sha)! };
        const content = await readBlobAsBase64(storage, file.sha);
        const ghSha = await createBlob(token, owner, repo, content, "base64");
        return { sha: file.sha, ghSha };
      })
    );
    for (const r of results) {
      blobMap.set(r.sha, r.ghSha);
    }
  }

  // 6. Build tree entries for GitHub
  const treeEntries: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];

  for (const file of changedFiles) {
    const ghBlobSha = blobMap.get(file.sha)!;
    treeEntries.push({
      path: file.path,
      mode: file.mode === "100755" ? "100755" : "100644",
      type: "blob",
      sha: ghBlobSha,
    });
  }

  for (const path of deletedFiles) {
    treeEntries.push({
      path,
      mode: "100644",
      type: "blob",
      sha: null,
    });
  }

  // 7. Create tree (use base_tree only for incremental exports, not first export)
  const baseTree = lastSyncedSha ? remoteHead : null;
  const ghTreeSha = await createTree(
    token,
    owner,
    repo,
    baseTree,
    treeEntries
  );

  // 8. Create commit
  const message = commitMessage || `Sync from CoreGit`;
  const parents = remoteHead ? [remoteHead] : [];
  const ghCommitSha = await createCommit(token, owner, repo, message, ghTreeSha, parents);

  // 9. Update ref
  await updateRef(token, owner, repo, branch, ghCommitSha, false);

  return {
    githubSha: ghCommitSha,
    filesChanged: totalChanges,
    skipped: false,
  };
}

/** Flatten a tree object recursively by tree SHA (not commit SHA). */
async function flattenTreeFromSha(
  storage: GitR2Storage,
  treeSha: string,
  prefix = ""
): Promise<Map<string, { sha: string; mode: string }>> {
  const raw = await storage.getObject(treeSha);
  if (!raw) return new Map();
  const obj = parseGitObject(raw);
  if (obj.type !== "tree") return new Map();
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
        return flattenTreeFromSha(storage, entry.sha, fullPath);
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
