import { GitR2Storage } from "../git/storage";
import { createApiCommit, snapshotBranchTree, type CommitAuthor, type FileChange } from "./commit-builder";
import { extractZipArchive } from "./archive";

const GL_API = "https://gitlab.com/api/v4";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5000;

interface GitlabSyncParams {
  token: string;
  projectPath: string;
  branch: string;
  storage: GitR2Storage;
  author: CommitAuthor;
  lastSyncedSha?: string | null;
}

interface GitlabSyncResult {
  remoteSha: string;
  commitSha?: string;
  skipped: boolean;
  filesChanged: number;
  deleted: number;
}

function gitlabHeaders(token: string): HeadersInit {
  return {
    "Private-Token": token,
  };
}

function encodeProject(path: string): string {
  return encodeURIComponent(path);
}

function bytesToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

async function fetchLatestCommit(params: GitlabSyncParams) {
  const res = await fetch(
    `${GL_API}/projects/${encodeProject(params.projectPath)}/repository/commits/${encodeURIComponent(params.branch)}`,
    { headers: gitlabHeaders(params.token) }
  );
  if (res.status === 404) {
    throw new Error(`GitLab branch not found: ${params.branch}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab commit lookup failed: ${res.status} ${text}`);
  }
  return (await res.json()) as { id: string };
}

async function downloadArchive(params: GitlabSyncParams): Promise<Uint8Array> {
  const res = await fetch(
    `${GL_API}/projects/${encodeProject(params.projectPath)}/repository/archive.zip?sha=${encodeURIComponent(params.branch)}`,
    { headers: gitlabHeaders(params.token) }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab archive download failed: ${res.status} ${text}`);
  }
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`);
  }
  return buffer;
}

export async function syncFromGitlab(params: GitlabSyncParams): Promise<GitlabSyncResult> {
  const latest = await fetchLatestCommit(params);
  if (params.lastSyncedSha && latest.id === params.lastSyncedSha) {
    return { remoteSha: latest.id, skipped: true, filesChanged: 0, deleted: 0 };
  }
  const archiveBuffer = await downloadArchive(params);
  const files = extractZipArchive(archiveBuffer);
  if (files.length === 0) {
    throw new Error("GitLab archive is empty");
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
    `Sync from GitLab ${params.projectPath}@${latest.id.slice(0, 7)}`,
    params.author,
    changes
  );

  return {
    remoteSha: latest.id,
    commitSha: commit.sha,
    skipped: false,
    filesChanged: files.length,
    deleted,
  };
}
