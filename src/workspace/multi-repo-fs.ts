/**
 * MultiRepoFileSystem — mounts multiple GitR2FileSystem instances at /{slug}/.
 *
 * Routes all filesystem operations to the correct sub-FS based on path prefix.
 * Tracks changes per-repo for selective commits.
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

import { GitR2FileSystem, type FileChange } from "./filesystem";

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

export interface MountedRepo {
  slug: string;
  fs: GitR2FileSystem;
}

export class MultiRepoFileSystem implements IFileSystem {
  private mounts: Map<string, GitR2FileSystem>;
  private slugs: string[];

  constructor(repos: MountedRepo[]) {
    this.mounts = new Map();
    this.slugs = [];
    for (const r of repos) {
      this.mounts.set(r.slug, r.fs);
      this.slugs.push(r.slug);
    }
  }

  // ── Path routing ──

  private resolve(path: string): { slug: string; fs: GitR2FileSystem; subPath: string } | null {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const slug = parts[0];
    const fs = this.mounts.get(slug);
    if (!fs) return null;
    const subPath = "/" + parts.slice(1).join("/");
    return { slug, fs, subPath };
  }

  // ── IFileSystem ──

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return r.fs.readFile(r.subPath, options);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return r.fs.readFileBuffer(r.subPath);
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: cannot write to root or unknown mount '${path}'`);
    return r.fs.writeFile(r.subPath, content, options);
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: cannot append to root or unknown mount '${path}'`);
    return r.fs.appendFile(r.subPath, content, options);
  }

  async exists(path: string): Promise<boolean> {
    const norm = path.split("/").filter(Boolean);
    if (norm.length === 0) return true; // root
    if (norm.length === 1) return this.mounts.has(norm[0]); // mount point
    const r = this.resolve(path);
    if (!r) return false;
    return r.fs.exists(r.subPath);
  }

  async stat(path: string): Promise<FsStat> {
    const norm = path.split("/").filter(Boolean);
    if (norm.length === 0) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() };
    }
    if (norm.length === 1 && this.mounts.has(norm[0])) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() };
    }
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return r.fs.stat(r.subPath);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const r = this.resolve(path);
    if (!r) {
      if (options?.recursive) return; // root mkdir -p is a no-op
      throw new Error(`ENOENT: cannot mkdir on root or unknown mount '${path}'`);
    }
    return r.fs.mkdir(r.subPath, options);
  }

  async readdir(path: string): Promise<string[]> {
    const norm = path.split("/").filter(Boolean);
    if (norm.length === 0) {
      // Root: list all mount points
      return [...this.slugs].sort();
    }
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: no such file or directory, readdir '${path}'`);
    return r.fs.readdir(r.subPath);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const norm = path.split("/").filter(Boolean);
    if (norm.length === 0) {
      return this.slugs.map((slug) => ({
        name: slug,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }));
    }
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: no such file or directory, readdir '${path}'`);
    return r.fs.readdirWithFileTypes(r.subPath);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const r = this.resolve(path);
    if (!r) throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    return r.fs.rm(r.subPath, options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcR = this.resolve(src);
    const destR = this.resolve(dest);

    if (srcR && destR && srcR.slug === destR.slug) {
      // Same repo — delegate directly
      return srcR.fs.cp(srcR.subPath, destR.subPath, options);
    }

    // Cross-repo copy: read from src, write to dest
    if (!srcR) throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    if (!destR) throw new Error(`ENOENT: cannot copy to root or unknown mount '${dest}'`);

    const srcStat = await srcR.fs.stat(srcR.subPath);
    if (srcStat.isDirectory) {
      if (!options?.recursive) throw new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
      await destR.fs.mkdir(destR.subPath, { recursive: true });
      const entries = await srcR.fs.readdir(srcR.subPath);
      for (const entry of entries) {
        await this.cp(`${src}/${entry}`, `${dest}/${entry}`, options);
      }
    } else {
      const content = await srcR.fs.readFileBuffer(srcR.subPath);
      await destR.fs.writeFile(destR.subPath, content);
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
    const paths = new Set<string>(["/"])
    for (const slug of this.slugs) {
      paths.add(`/${slug}`);
      const subPaths = this.mounts.get(slug)!.getAllPaths();
      for (const p of subPaths) {
        if (p === "/") continue;
        paths.add(`/${slug}${p}`);
      }
    }
    return [...paths];
  }

  async chmod(_path: string, _mode: number): Promise<void> {}

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error("Symlinks not supported");
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const content = await this.readFileBuffer(existingPath);
    await this.writeFile(newPath, content);
  }

  async readlink(_path: string): Promise<string> {
    throw new Error("Symlinks not supported");
  }

  async realpath(path: string): Promise<string> {
    if (await this.exists(path)) return path.startsWith("/") ? path : "/" + path;
    throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {}

  // ── Public API ──

  async preload(): Promise<void> {
    await Promise.all(
      [...this.mounts.values()].map((fs) => fs.preload())
    );
  }

  /** Get changes grouped by repo slug. */
  getChangesByRepo(): Map<string, FileChange[]> {
    const result = new Map<string, FileChange[]>();
    for (const [slug, fs] of this.mounts) {
      const changes = fs.getChanges();
      if (changes.length > 0) {
        result.set(slug, changes);
      }
    }
    return result;
  }

  /** Get the GitR2FileSystem for a specific mount. */
  getMount(slug: string): GitR2FileSystem | undefined {
    return this.mounts.get(slug);
  }
}
