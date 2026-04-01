import { GitR2Storage } from "../git/storage";
import { createApiCommit, snapshotBranchTree, type CommitAuthor, type FileChange } from "./commit-builder";
import { extractZipArchive } from "./archive";

const GH_API = "https://api.github.com";
const USER_AGENT = "coregit-sync/0.1";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5000;

interface GithubSyncParams {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  storage: GitR2Storage;
  author: CommitAuthor;
  lastSyncedSha?: string | null;
}

interface GithubSyncResult {
  remoteSha: string;
  commitSha?: string;
  skipped: boolean;
  filesChanged: number;
  deleted: number;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
}

function bytesToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

async function fetchLatestCommit(params: GithubSyncParams) {
  const res = await fetch(`${GH_API}/repos/${params.owner}/${params.repo}/commits/${encodeURIComponent(params.branch)}`, {
    headers: githubHeaders(params.token),
  });
  if (res.status === 404) {
    throw new Error(`GitHub branch not found: ${params.branch}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub commit lookup failed: ${res.status} ${text}`);
  }
  return (await res.json()) as { sha: string; commit?: { message?: string } };
}

async function downloadArchive(params: GithubSyncParams, sha: string): Promise<Uint8Array> {
  const res = await fetch(`${GH_API}/repos/${params.owner}/${params.repo}/zipball/${encodeURIComponent(params.branch)}`, {
    headers: githubHeaders(params.token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub archive download failed: ${res.status} ${text}`);
  }
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`);
  }
  return buffer;
}

export async function syncFromGithub(params: GithubSyncParams): Promise<GithubSyncResult> {
  const latest = await fetchLatestCommit(params);
  if (params.lastSyncedSha && latest.sha === params.lastSyncedSha) {
    return { remoteSha: latest.sha, skipped: true, filesChanged: 0, deleted: 0 };
  }
  const archiveBuffer = await downloadArchive(params, latest.sha);
  const files = extractZipArchive(archiveBuffer);
  if (files.length === 0) {
    throw new Error("GitHub archive is empty");
  }
  if (files.length > MAX_FILES) {
    throw new Error(`Archive has too many files (${files.length})`);
  }

  const remotePaths = new Set<string>();
  const changes: FileChange[] = [];
  for (const file of files) {
    if (file.data.byteLength > MAX_FILE_BYTES) {
      throw new Error(`File ${file.path} exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB limit`);
    }
    remotePaths.add(file.path);
    changes.push({
      path: file.path,
      content: bytesToBase64(file.data),
      encoding: "base64",
    });
  }

  const existing = await snapshotBranchTree(params.storage, params.branch);
  let deleted = 0;
  for (const path of existing.keys()) {
    if (!remotePaths.has(path)) {
      changes.push({ path, action: "delete" });
      deleted++;
    }
  }

  const commit = await createApiCommit(
    params.storage,
    params.branch,
    `Sync from GitHub ${params.owner}/${params.repo}@${latest.sha.slice(0, 7)}`,
    params.author,
    changes
  );

  return {
    remoteSha: latest.sha,
    commitSha: commit.sha,
    skipped: false,
    filesChanged: files.length,
    deleted,
  };
}
