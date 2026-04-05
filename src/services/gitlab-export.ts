/**
 * Export CoreGit repository to GitLab via Commits API.
 *
 * GitLab's Repository Commits API is simpler than GitHub's Git Data API:
 *   POST /projects/{id}/repository/commits
 *   { branch, commit_message, actions: [{action, file_path, content, encoding}] }
 *
 * Batched into chunks of 500 actions if there are many files.
 */

import { GitR2Storage } from "../git/storage";
import { snapshotBranchTree } from "./commit-builder";
import { parseGitObject, parseCommit, parseTree } from "../git/objects";

const GL_API = "https://gitlab.com/api/v4";
const ACTION_BATCH_SIZE = 500;

interface GitlabExportParams {
  token: string;
  projectPath: string;
  branch: string;
  storage: GitR2Storage;
  lastSyncedSha: string | null;
  commitMessage?: string;
}

interface GitlabExportResult {
  gitlabSha: string;
  filesChanged: number;
  skipped: boolean;
}

function gitlabHeaders(token: string): HeadersInit {
  return {
    "Private-Token": token,
    "Content-Type": "application/json",
  };
}

function encodeProject(path: string): string {
  return encodeURIComponent(path);
}

/** Read a blob from CoreGit storage and return base64 content. */
async function readBlobAsBase64(storage: GitR2Storage, sha: string): Promise<string> {
  const raw = await storage.getObject(sha);
  if (!raw) throw new Error(`Blob not found in CoreGit: ${sha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
  return Buffer.from(obj.content).toString("base64");
}

/** Check if a branch exists on GitLab. */
async function branchExists(
  token: string,
  projectPath: string,
  branch: string
): Promise<boolean> {
  const res = await fetch(
    `${GL_API}/projects/${encodeProject(projectPath)}/repository/branches/${encodeURIComponent(branch)}`,
    { headers: gitlabHeaders(token) }
  );
  return res.ok;
}

/** Get existing file list from GitLab branch to determine create vs update actions. */
async function getRemoteFileSet(
  token: string,
  projectPath: string,
  branch: string
): Promise<Set<string>> {
  const files = new Set<string>();
  let page = 1;
  const perPage = 100;

  while (true) {
    const res = await fetch(
      `${GL_API}/projects/${encodeProject(projectPath)}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=${perPage}&page=${page}`,
      { headers: gitlabHeaders(token) }
    );
    if (!res.ok) break;
    const items = (await res.json()) as Array<{ path: string; type: string }>;
    if (items.length === 0) break;
    for (const item of items) {
      if (item.type === "blob") files.add(item.path);
    }
    if (items.length < perPage) break;
    page++;
  }

  return files;
}

/** Flatten a tree object recursively by tree SHA. */
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

export async function exportToGitlab(params: GitlabExportParams): Promise<GitlabExportResult> {
  const { token, projectPath, branch, storage, lastSyncedSha, commitMessage } = params;

  // 1. Get current CoreGit tree
  const currentTree = await snapshotBranchTree(storage, branch);
  if (currentTree.size === 0) {
    return { gitlabSha: "", filesChanged: 0, skipped: true };
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
  interface GitlabAction {
    action: "create" | "update" | "delete";
    file_path: string;
    content?: string;
    encoding?: "base64";
  }

  const actions: GitlabAction[] = [];

  // Determine which files exist remotely for create vs update
  const remoteBranchExists = await branchExists(token, projectPath, branch);
  let remoteFiles = new Set<string>();
  if (remoteBranchExists) {
    remoteFiles = await getRemoteFileSet(token, projectPath, branch);
  }

  // Changed / new files
  for (const [path, entry] of currentTree) {
    const old = oldTree.get(path);
    if (!old || old.sha !== entry.sha) {
      const content = await readBlobAsBase64(storage, entry.sha);
      const action = remoteFiles.has(path) ? "update" : "create";
      actions.push({ action, file_path: path, content, encoding: "base64" });
    }
  }

  // Deleted files
  if (lastSyncedSha) {
    for (const path of oldTree.keys()) {
      if (!currentTree.has(path) && remoteFiles.has(path)) {
        actions.push({ action: "delete", file_path: path });
      }
    }
  }

  if (actions.length === 0) {
    return { gitlabSha: "", filesChanged: 0, skipped: true };
  }

  // 4. Send commits in batches
  const message = commitMessage || "Sync from CoreGit";
  let lastSha = "";

  for (let i = 0; i < actions.length; i += ACTION_BATCH_SIZE) {
    const batch = actions.slice(i, i + ACTION_BATCH_SIZE);
    const batchNum = Math.floor(i / ACTION_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(actions.length / ACTION_BATCH_SIZE);
    const batchMessage = totalBatches > 1
      ? `${message} (batch ${batchNum}/${totalBatches})`
      : message;

    const res = await fetch(
      `${GL_API}/projects/${encodeProject(projectPath)}/repository/commits`,
      {
        method: "POST",
        headers: gitlabHeaders(token),
        body: JSON.stringify({
          branch,
          commit_message: batchMessage,
          actions: batch,
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab commit failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { id: string };
    lastSha = data.id;
  }

  return {
    gitlabSha: lastSha,
    filesChanged: actions.length,
    skipped: false,
  };
}
