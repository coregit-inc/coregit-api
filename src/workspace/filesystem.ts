/**
 * GitR2FileSystem — IFileSystem implementation backed by git objects in R2.
 *
 * Reads lazily from git tree (R2), writes to in-memory overlay (copy-on-write).
 * Designed for stateless per-request use in CF Workers.
 */

import type {
  IFileSystem,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
  FileContent,
} from "just-bash/browser";

// Types not exported from just-bash/browser — defined locally
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseTree, type TreeEntry } from "../git/objects";

// ============ Types ============

interface OverlayFile {
  content: Uint8Array;
  mode: number;
  mtime: Date;
}

interface OverlayDir {
  mtime: Date;
}

export interface FileChange {
  path: string;
  action: "added" | "modified" | "deleted";
}

// ============ Constants ============

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ============ GitR2FileSystem ============

export class GitR2FileSystem implements IFileSystem {
  private storage: GitR2Storage;
  private rootTreeSha: string;

  // Cache for git tree entries (treeSha → entries)
  private treeCache = new Map<string, TreeEntry[]>();
  // Flat path index (populated lazily)
  private pathIndex: Map<string, { sha: string; mode: string }> | null = null;

  // Copy-on-write overlay
  private writtenFiles = new Map<string, OverlayFile>();
  private createdDirs = new Map<string, OverlayDir>();
  private deletedPaths = new Set<string>();

  constructor(storage: GitR2Storage, rootTreeSha: string) {
    this.storage = storage;
    this.rootTreeSha = rootTreeSha;
  }

  // ============ Internal Helpers ============

  private async getPathIndex(): Promise<Map<string, { sha: string; mode: string }>> {
    if (this.pathIndex) return this.pathIndex;
    this.pathIndex = new Map();
    await this.indexTree(this.rootTreeSha, "");
    return this.pathIndex;
  }

  private async indexTree(treeSha: string, prefix: string): Promise<void> {
    const entries = await this.getTreeEntries(treeSha);
    const dirs: { sha: string; fullPath: string }[] = [];

    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === "40000") {
        dirs.push({ sha: entry.sha, fullPath });
      } else {
        this.pathIndex!.set(fullPath, { sha: entry.sha, mode: entry.mode });
      }
    }

    if (dirs.length > 0) {
      await Promise.all(dirs.map((d) => this.indexTree(d.sha, d.fullPath)));
    }
  }

  private async getTreeEntries(treeSha: string): Promise<TreeEntry[]> {
    const cached = this.treeCache.get(treeSha);
    if (cached) return cached;

    const raw = await this.storage.getObject(treeSha);
    if (!raw) throw new Error(`Tree object not found: ${treeSha}`);
    const obj = parseGitObject(raw);
    if (obj.type !== "tree") throw new Error(`Expected tree, got ${obj.type}`);
    const entries = parseTree(obj.content);
    this.treeCache.set(treeSha, entries);
    return entries;
  }

  private async readBlob(sha: string): Promise<Uint8Array> {
    const raw = await this.storage.getObject(sha);
    if (!raw) throw new Error(`Blob object not found: ${sha}`);
    const obj = parseGitObject(raw);
    if (obj.type !== "blob") throw new Error(`Expected blob, got ${obj.type}`);
    if (obj.content.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${obj.content.length} bytes (max ${MAX_FILE_SIZE})`);
    }
    return obj.content;
  }

  private normalizePath(p: string): string {
    return p.split("/").filter(Boolean).join("/");
  }

  private isDeleted(path: string): boolean {
    if (this.deletedPaths.has(path)) return true;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (this.deletedPaths.has(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  }

  private async isGitDirectory(path: string): Promise<boolean> {
    if (path === "") return true;
    const index = await this.getPathIndex();
    const prefix = path + "/";
    for (const key of index.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  // ============ IFileSystem Implementation ============

  async readFile(path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const norm = this.normalizePath(path);

    if (this.isDeleted(norm)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const overlay = this.writtenFiles.get(norm);
    if (overlay) return decoder.decode(overlay.content);

    const index = await this.getPathIndex();
    const entry = index.get(norm);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const content = await this.readBlob(entry.sha);
    return decoder.decode(content);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const norm = this.normalizePath(path);

    if (this.isDeleted(norm)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const overlay = this.writtenFiles.get(norm);
    if (overlay) return overlay.content;

    const index = await this.getPathIndex();
    const entry = index.get(norm);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    return this.readBlob(entry.sha);
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const norm = this.normalizePath(path);
    const data = typeof content === "string" ? encoder.encode(content) : content;

    if (data.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${data.length} bytes (max ${MAX_FILE_SIZE})`);
    }

    // Ensure parent directory chain exists
    const parentDir = norm.includes("/") ? norm.split("/").slice(0, -1).join("/") : "";
    if (parentDir) {
      const parentExists = this.createdDirs.has(parentDir) || await this.isGitDirectory(parentDir);
      if (!parentExists && !this.isDeleted(parentDir)) {
        await this.mkdir("/" + parentDir, { recursive: true });
      }
    }

    this.deletedPaths.delete(norm);
    this.writtenFiles.set(norm, { content: data, mode: 0o644, mtime: new Date() });
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    const norm = this.normalizePath(path);
    let existing: Uint8Array = new Uint8Array(0);

    try {
      existing = new Uint8Array(await this.readFileBuffer("/" + norm));
    } catch {
      // File doesn't exist — append creates it
    }

    const append = typeof content === "string" ? encoder.encode(content) : content;
    const merged = new Uint8Array(existing.length + append.length);
    merged.set(existing, 0);
    merged.set(append, existing.length);

    await this.writeFile(path, merged, options);
  }

  async exists(path: string): Promise<boolean> {
    const norm = this.normalizePath(path);
    if (norm === "") return true;
    if (this.isDeleted(norm)) return false;

    if (this.writtenFiles.has(norm)) return true;
    if (this.createdDirs.has(norm)) return true;

    const index = await this.getPathIndex();
    if (index.has(norm)) return true;

    return this.isGitDirectory(norm);
  }

  async stat(path: string): Promise<FsStat> {
    const norm = this.normalizePath(path);

    if (this.isDeleted(norm)) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    if (norm === "") {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() };
    }

    const overlay = this.writtenFiles.get(norm);
    if (overlay) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: overlay.mode, size: overlay.content.length, mtime: overlay.mtime };
    }

    const dir = this.createdDirs.get(norm);
    if (dir) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: dir.mtime };
    }

    const index = await this.getPathIndex();
    const entry = index.get(norm);
    if (entry) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: parseInt(entry.mode, 8), size: 0, mtime: new Date() };
    }

    if (await this.isGitDirectory(norm)) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() };
    }

    throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const norm = this.normalizePath(path);
    if (norm === "") return;

    if (options?.recursive) {
      const parts = norm.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const partial = parts.slice(0, i).join("/");
        if (!this.createdDirs.has(partial) && !(await this.isGitDirectory(partial))) {
          this.createdDirs.set(partial, { mtime: new Date() });
          this.deletedPaths.delete(partial);
        }
      }
    } else {
      const parentDir = norm.includes("/") ? norm.split("/").slice(0, -1).join("/") : "";
      if (parentDir) {
        const parentExists = this.createdDirs.has(parentDir) || (await this.isGitDirectory(parentDir));
        if (!parentExists) {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      }
      if (this.writtenFiles.has(norm)) {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      this.createdDirs.set(norm, { mtime: new Date() });
      this.deletedPaths.delete(norm);
    }
  }

  async readdir(path: string): Promise<string[]> {
    const norm = this.normalizePath(path);
    const entries = new Set<string>();

    if (this.isDeleted(norm)) {
      throw new Error(`ENOENT: no such file or directory, readdir '${path}'`);
    }

    const prefix = norm === "" ? "" : norm + "/";

    const index = await this.getPathIndex();
    for (const filePath of index.keys()) {
      if (this.isDeleted(filePath)) continue;
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const firstPart = rest.split("/")[0];
      if (firstPart) entries.add(firstPart);
    }

    for (const filePath of this.writtenFiles.keys()) {
      if (this.isDeleted(filePath)) continue;
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const firstPart = rest.split("/")[0];
      if (firstPart) entries.add(firstPart);
    }

    for (const dirPath of this.createdDirs.keys()) {
      if (this.isDeleted(dirPath)) continue;
      if (!dirPath.startsWith(prefix)) continue;
      const rest = dirPath.slice(prefix.length);
      const firstPart = rest.split("/")[0];
      if (firstPart) entries.add(firstPart);
    }

    if (entries.size === 0 && norm !== "") {
      const isDir = this.createdDirs.has(norm) || (await this.isGitDirectory(norm));
      if (!isDir) {
        throw new Error(`ENOENT: no such file or directory, readdir '${path}'`);
      }
    }

    return [...entries].sort();
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const names = await this.readdir(path);
    const norm = this.normalizePath(path);

    return Promise.all(
      names.map(async (name) => {
        const fullPath = norm ? `${norm}/${name}` : name;
        const st = await this.stat("/" + fullPath);
        return { name, isFile: st.isFile, isDirectory: st.isDirectory, isSymbolicLink: false };
      })
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const norm = this.normalizePath(path);

    const fileExists = await this.exists("/" + norm);
    if (!fileExists) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    const st = await this.stat("/" + norm);
    if (st.isDirectory && !options?.recursive) {
      throw new Error(`EISDIR: illegal operation on a directory, rm '${path}'`);
    }

    this.writtenFiles.delete(norm);
    this.createdDirs.delete(norm);

    if (options?.recursive) {
      const prefix = norm + "/";
      for (const key of [...this.writtenFiles.keys()]) {
        if (key.startsWith(prefix)) this.writtenFiles.delete(key);
      }
      for (const key of [...this.createdDirs.keys()]) {
        if (key.startsWith(prefix)) this.createdDirs.delete(key);
      }
    }

    this.deletedPaths.add(norm);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNorm = this.normalizePath(src);
    const destNorm = this.normalizePath(dest);
    const srcStat = await this.stat("/" + srcNorm);

    if (srcStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
      }
      await this.mkdir("/" + destNorm, { recursive: true });
      const entries = await this.readdir("/" + srcNorm);
      for (const entry of entries) {
        await this.cp(`/${srcNorm}/${entry}`, `/${destNorm}/${entry}`, options);
      }
    } else {
      const content = await this.readFileBuffer("/" + srcNorm);
      await this.writeFile("/" + destNorm, content);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: true });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return path;
    const baseParts = base.split("/").filter(Boolean);
    const pathParts = path.split("/").filter(Boolean);
    const result = [...baseParts];
    for (const part of pathParts) {
      if (part === "..") result.pop();
      else if (part !== ".") result.push(part);
    }
    return "/" + result.join("/");
  }

  getAllPaths(): string[] {
    const paths: string[] = ["/"];

    if (this.pathIndex) {
      for (const filePath of this.pathIndex.keys()) {
        if (this.isDeleted(filePath)) continue;
        paths.push("/" + filePath);
        const parts = filePath.split("/");
        for (let i = 1; i < parts.length; i++) {
          paths.push("/" + parts.slice(0, i).join("/"));
        }
      }
    }

    for (const filePath of this.writtenFiles.keys()) {
      if (!this.isDeleted(filePath)) paths.push("/" + filePath);
    }
    for (const dirPath of this.createdDirs.keys()) {
      if (!this.isDeleted(dirPath)) paths.push("/" + dirPath);
    }

    return [...new Set(paths)];
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // No-op — git doesn't track granular permissions
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("Symlinks not supported on git-backed filesystem");
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const content = await this.readFileBuffer(existingPath);
    await this.writeFile(newPath, content);
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("Symlinks not supported on git-backed filesystem");
  }

  async realpath(path: string): Promise<string> {
    const norm = this.normalizePath(path);
    if (norm === "") return "/";
    if (await this.exists("/" + norm)) return "/" + norm;
    throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    // No-op — git doesn't track timestamps
  }

  // ============ Public API ============

  /** Pre-load path index so getAllPaths() works synchronously. */
  async preload(): Promise<void> {
    await this.getPathIndex();
  }

  /** Get list of changed files. */
  getChanges(): FileChange[] {
    const changes: FileChange[] = [];

    for (const [path] of this.writtenFiles) {
      const existedInGit = this.pathIndex?.has(path) ?? false;
      changes.push({ path, action: existedInGit ? "modified" : "added" });
    }

    for (const path of this.deletedPaths) {
      if (this.pathIndex?.has(path)) {
        changes.push({ path, action: "deleted" });
      }
      if (this.pathIndex) {
        const prefix = path + "/";
        for (const gitPath of this.pathIndex.keys()) {
          if (gitPath.startsWith(prefix)) {
            changes.push({ path: gitPath, action: "deleted" });
          }
        }
      }
    }

    return changes;
  }

  /** Get merged overlay for building a new git tree when committing. */
  getMergedFlatTree(): Map<string, { sha: string; mode: string } | { content: Uint8Array; mode: string }> {
    const result = new Map<string, { sha: string; mode: string } | { content: Uint8Array; mode: string }>();

    if (this.pathIndex) {
      for (const [path, entry] of this.pathIndex) {
        if (!this.isDeleted(path)) {
          result.set(path, entry);
        }
      }
    }

    for (const [path, overlay] of this.writtenFiles) {
      result.set(path, {
        content: overlay.content,
        mode: overlay.mode === 0o755 ? "100755" : "100644",
      });
    }

    return result;
  }
}
