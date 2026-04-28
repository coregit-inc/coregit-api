/**
 * CoregitCoreBinding — WorkerEntrypoint for adjacent private Workers.
 *
 * Allows private Workers deployed on the same Cloudflare account (bound via
 * `[[services]] binding = "CORE" entrypoint = "CoregitCoreBinding"`) to
 * perform git operations, search, and API-key resolution over the internal
 * Cloudflare RPC transport — no HTTP hop, no public surface change.
 *
 * Two call shapes are supported:
 *
 *   1. `env.CORE.fetch(request)` — forwards an HTTP request through the Hono
 *      app. Use for any existing public endpoint (search, graph, blob read,
 *      etc.). The calling Worker is responsible for constructing the request
 *      with the correct `x-api-key` header.
 *
 *   2. `env.CORE.someMethod(params)` — typed RPC methods for common
 *      operations that benefit from structured input (commit creation,
 *      ref resolution, API-key lookup). These methods perform their own
 *      authorization via the `orgId` passed in — the caller is expected to
 *      have verified the API key via `resolveApiKey()` first.
 *
 * The Hono app handles custom-domain resolution, CORS, rate limiting, etc.
 * Internal RPC calls from private Workers skip CORS (no browser involved)
 * and generally skip rate limiting (bound to the caller's Worker instead).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { createDb, dbConnectionString } from "./db";
import { app } from "./app";
import { verifyWithCache } from "./auth/middleware";
import {
  resolveRepo,
  setRepoCacheRef,
  setRepoHotDORef,
  setRefCacheKvRef,
  setObjCacheKvRef,
} from "./services/repo-resolver";
import {
  createApiCommit,
  setTreeCacheRef as setCommitTreeCacheRef,
  type FileChange,
  type CommitAuthor,
} from "./services/commit-builder";
import { parseGitObject, parseTree, parseCommit, type TreeEntry } from "./git/objects";
import { GitR2Storage } from "./git/storage";
import { recordUsage, type UsageEventType } from "./services/usage";
import { checkFreeLimits, getOrgPlan, type LimitEventType } from "./services/limits";
import type { IndexFileMessage } from "./services/semantic-index";
import type { GraphIndexFileMessage } from "./services/graph-index";
import type { Env } from "./types";

// ── Types returned across the RPC boundary ──
// All types must be structured-cloneable (no class instances, Dates become ISO strings).

export interface ResolvedApiKey {
  orgId: string;
  apiKeyId: string;
  tier: "free" | "paid";
  orgSlug?: string;
  dodoCustomerId: string | null;
}

export interface RecordUsageParams {
  orgId: string;
  dodoCustomerId: string | null;
  eventType: UsageEventType;
  quantity: number;
  metadata?: Record<string, unknown>;
}

export interface CheckFreeLimitsResult {
  allowed: boolean;
  used?: number;
  limit?: number;
  reason?: string;
}

export interface ApiSubStatusResult {
  subscriptionId: string | null;
  status: string | null;
  syncedAt: string | null;
}

export interface CommitFilesParams {
  orgId: string;
  slug: string;
  namespace?: string | null;
  branch: string;
  message: string;
  author: CommitAuthor;
  files: Array<{
    path: string;
    content?: string;
    encoding?: "utf-8" | "base64";
    action?: "create" | "edit" | "delete" | "rename" | "lazy_edit";
    new_path?: string;
    /** For action: "lazy_edit" — partial-file snippet with `// ... existing code ...` markers around unchanged sections. Morph merges it into the file. */
    edit_snippet?: string;
    /** For action: "lazy_edit" — single-line hint for disambiguating the edit (e.g. which section to update). */
    instruction?: string;
  }>;
  parentSha?: string;
  /** Customer ID used for usage billing on lazy_edit calls. Optional — if
   * omitted, Morph cost is not billed to any specific user (internal use). */
  dodoCustomerId?: string | null;
}

export interface CommitFilesResult {
  version_id: string;
  tree_id: string;
  parent_version_id: string;
}

export interface RepoRef {
  orgId: string;
  slug: string;
  namespace?: string | null;
}

export interface TreeEntryInfo {
  name: string;
  path: string;
  type: "file" | "folder";
  sha: string;
  mode: string;
  size?: number;
}

export interface HistoryEntry {
  version_id: string;
  parent_version_ids: string[];
  author_name: string;
  author_email: string;
  changed_at: string;
  message: string;
}

export class CoregitCoreBinding extends WorkerEntrypoint<Env> {
  /**
   * HTTP forwarder. Use for existing public endpoints — search, graph,
   * blob read, etc. Zero-overhead RPC inside the Cloudflare network.
   *
   * Example:
   *   const res = await env.CORE.fetch(
   *     new Request("https://api.coregit.dev/v1/repos/myrepo/semantic-search", {
   *       method: "POST",
   *       headers: { "x-api-key": apiKey, "content-type": "application/json" },
   *       body: JSON.stringify({ q: "...", top_k: 10 }),
   *     })
   *   );
   */
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /** Resolve an API key to org/tier. Called once per request by the wiki worker middleware. */
  async resolveApiKey(params: { apiKey: string }): Promise<ResolvedApiKey | null> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const verified = await verifyWithCache(
      db,
      params.apiKey,
      this.env.AUTH_CACHE as KVNamespace | undefined,
    );
    if (!verified) return null;
    return {
      orgId: verified.auth.orgId,
      apiKeyId: verified.auth.tokenId,
      tier: verified.auth.tier,
      orgSlug: verified.auth.orgSlug,
      dodoCustomerId: verified.auth.dodoCustomerId,
    };
  }

  /**
   * Record a usage event. Fire-and-forget: writes to usage_event for
   * analytics and posts to Dodo /events/ingest if the event type is
   * billable + the org has a dodoCustomerId.
   *
   * If `dodoCustomerId` is null, we look it up from `org_plan` so queue
   * consumers (which don't have Hono context) can still bill correctly.
   */
  async recordUsage(params: RecordUsageParams): Promise<void> {
    const db = createDb(dbConnectionString(this.env));
    let dodoCustomerId = params.dodoCustomerId;
    if (dodoCustomerId === null) {
      const plan = await getOrgPlan(db, params.orgId).catch(() => null);
      dodoCustomerId = plan?.dodoCustomerId ?? null;
    }
    recordUsage(
      this.ctx,
      this.env,
      db,
      params.orgId,
      dodoCustomerId,
      params.eventType,
      params.quantity,
      params.metadata,
    );
  }

  /**
   * Free-tier gate. Returns { allowed } + reason/used/limit on denial.
   * Safe for paid orgs — always allows.
   */
  async checkFreeLimits(params: {
    orgId: string;
    tier: "free" | "paid";
    eventType: LimitEventType;
  }): Promise<CheckFreeLimitsResult> {
    const db = createDb(dbConnectionString(this.env));
    return checkFreeLimits(db, params.orgId, params.tier, params.eventType);
  }

  /**
   * Read the org's $0 API Access subscription state. Used by coregit-app's
   * payment.succeeded handler + cron fallback debit to detect orgs whose
   * meter ingest is being silently dropped (status != active in Dodo).
   */
  async getApiSubStatus(params: { orgId: string }): Promise<ApiSubStatusResult> {
    const db = createDb(dbConnectionString(this.env));
    const result = await db.execute(sql`
      SELECT dodo_api_subscription_id, dodo_api_subscription_status, dodo_api_subscription_synced_at
      FROM org_plan WHERE org_id = ${params.orgId} LIMIT 1
    `);
    const row = (result.rows as Array<{
      dodo_api_subscription_id: string | null;
      dodo_api_subscription_status: string | null;
      dodo_api_subscription_synced_at: Date | string | null;
    }>)[0];
    return {
      subscriptionId: row?.dodo_api_subscription_id ?? null,
      status: row?.dodo_api_subscription_status ?? null,
      syncedAt: row?.dodo_api_subscription_synced_at
        ? new Date(row.dodo_api_subscription_synced_at).toISOString()
        : null,
    };
  }

  /** Atomic multi-file commit. Used to write `raw/` sources and wiki pages. */
  async commitFiles(params: CommitFilesParams): Promise<CommitFilesResult> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, {
      orgId: params.orgId,
      slug: params.slug,
      namespace: params.namespace ?? undefined,
    });
    if (!resolved) throw new Error("Repository not found");

    const changes: FileChange[] = params.files.map((f) => ({
      path: f.path,
      content: f.content,
      encoding: f.encoding,
      action: f.action ?? "create",
      new_path: f.new_path,
      edit_snippet: f.edit_snippet,
      instruction: f.instruction,
    }));

    const hasLazyEdit = changes.some((c) => c.action === "lazy_edit");
    if (hasLazyEdit && !this.env.MORPH_API_KEY) {
      throw new Error("lazy_edit requires MORPH_API_KEY on the worker");
    }

    const result = await createApiCommit(
      resolved.storage,
      params.branch,
      params.message,
      params.author,
      changes,
      params.parentSha,
      this.env.MORPH_API_KEY,
    );

    // Bill Morph Fast Apply output tokens to the caller's org if a customer
    // ID was supplied. Mirrors the HTTP /commits route's billing — service
    // binding callers (the wiki worker today) opt in by passing
    // params.dodoCustomerId; internal use without a customer just absorbs
    // the cost.
    if (
      result.morphUsage &&
      result.morphUsage.outputTokens > 0 &&
      params.dodoCustomerId
    ) {
      recordUsage(
        this.ctx,
        this.env,
        db,
        params.orgId,
        params.dodoCustomerId,
        "lazy_edit_tokens",
        result.morphUsage.outputTokens,
        {
          call_count: result.morphUsage.callCount,
          model: "morph-v3-fast",
          commit_sha: result.sha,
          source: "service_binding",
        },
      );
    }

    // Trigger delta semantic + graph indexing if auto_index is set on the
    // repo. Mirrors the same fire-and-forget behaviour as POST /commits
    // so Service Binding callers (the wiki worker today, anyone tomorrow)
    // stay consistent with the HTTP route.
    if (resolved.repo.autoIndex && this.env.INDEXING_QUEUE) {
      const indexFiles = changes.map((ch) => {
        const finalPath = ch.action === "rename" ? ch.new_path! : ch.path;
        return {
          path: finalPath,
          action: (ch.action || "create") as "create" | "edit" | "delete" | "rename",
          blobSha: ch.action === "delete" ? undefined : result.changedBlobs.get(finalPath),
          oldPath: ch.action === "rename" ? ch.path : undefined,
        };
      });
      const indexMsg: IndexFileMessage = {
        type: "index_files",
        orgId: params.orgId,
        repoId: resolved.repo.id,
        repoStorageSuffix: resolved.storageSuffix,
        branch: params.branch,
        commitSha: result.sha,
        files: indexFiles,
      };
      const graphMsg: GraphIndexFileMessage = {
        type: "graph_index_files",
        orgId: params.orgId,
        repoId: resolved.repo.id,
        repoStorageSuffix: resolved.storageSuffix,
        branch: params.branch,
        commitSha: result.sha,
        files: indexFiles,
      };
      this.ctx.waitUntil(this.env.INDEXING_QUEUE.send(indexMsg));
      this.ctx.waitUntil(this.env.INDEXING_QUEUE.send(graphMsg));
    }

    return {
      version_id: result.sha,
      tree_id: result.treeSha,
      parent_version_id: result.parentSha,
    };
  }

  /**
   * Resolve a ref string (branch name, tag name, or full SHA) to a commit SHA.
   * Returns null if not found.
   */
  async getRef(params: RepoRef & { ref: string }): Promise<{ sha: string; tree_sha?: string } | null> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, params);
    if (!resolved) return null;

    const branch = await resolved.storage.getRefWithEtag(`refs/heads/${params.ref}`);
    if (branch) return { sha: branch.sha, tree_sha: branch.treeSha };

    const tag = await resolved.storage.getRef(`refs/tags/${params.ref}`);
    if (tag) return { sha: tag };

    if (/^[0-9a-f]{40}$/i.test(params.ref)) {
      const exists = await resolved.storage.hasObject(params.ref);
      if (exists) return { sha: params.ref };
    }
    return null;
  }

  /**
   * Read a single blob's contents at a given ref and path.
   * Returns null if the path does not exist or is not a file.
   */
  async getBlobContent(
    params: RepoRef & { ref: string; path: string }
  ): Promise<{ content: string; sha: string; size: number } | null> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, params);
    if (!resolved) return null;

    const commitSha = await this.resolveRefToCommit(resolved.storage, params.ref);
    if (!commitSha) return null;

    const blobSha = await this.findBlobAtPath(resolved.storage, commitSha, params.path);
    if (!blobSha) return null;

    const raw = await resolved.storage.getObject(blobSha);
    if (!raw) return null;
    const obj = parseGitObject(raw);
    if (obj.type !== "blob") return null;

    return {
      content: new TextDecoder().decode(obj.content),
      sha: blobSha,
      size: obj.content.length,
    };
  }

  /**
   * List tree entries under a path prefix. `recursive: true` walks the full
   * subtree (capped to `limit` entries to bound memory on large repos).
   */
  async listTree(
    params: RepoRef & { ref: string; pathPrefix?: string; recursive?: boolean; limit?: number }
  ): Promise<TreeEntryInfo[]> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, params);
    if (!resolved) return [];

    const commitSha = await this.resolveRefToCommit(resolved.storage, params.ref);
    if (!commitSha) return [];

    const rootTree = await this.getTreeFromCommit(resolved.storage, commitSha);
    if (!rootTree) return [];

    const pathParts = (params.pathPrefix || "").split("/").filter(Boolean);
    const target = await this.navigateToPath(resolved.storage, rootTree, pathParts);
    if (!target) return [];

    const limit = params.limit ?? 1000;
    const out: TreeEntryInfo[] = [];
    const base = params.pathPrefix || "";

    if (params.recursive) {
      await this.flattenTree(resolved.storage, target.entries, base, out, limit);
    } else {
      for (const e of target.entries) {
        if (out.length >= limit) break;
        out.push({
          name: e.name,
          path: base ? `${base}/${e.name}` : e.name,
          type: e.mode === "40000" ? "folder" : "file",
          sha: e.sha,
          mode: e.mode,
        });
      }
    }
    return out;
  }

  /** Create a new branch pointing at an existing ref. Used for sandboxes. */
  async createBranch(params: RepoRef & { name: string; fromRef: string }): Promise<{ version_id: string }> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, params);
    if (!resolved) throw new Error("Repository not found");

    const sourceSha = await this.resolveRefToCommit(resolved.storage, params.fromRef);
    if (!sourceSha) throw new Error(`Source ref not found: ${params.fromRef}`);

    const existing = await resolved.storage.getRef(`refs/heads/${params.name}`);
    if (existing) throw new Error(`Branch already exists: ${params.name}`);

    await resolved.storage.setRef(`refs/heads/${params.name}`, sourceSha);
    return { version_id: sourceSha };
  }

  /** Delete a branch. Used for sandbox cleanup. Refuses to delete the repo's default branch. */
  async deleteBranch(params: RepoRef & { name: string }): Promise<void> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, params);
    if (!resolved) throw new Error("Repository not found");
    if (resolved.repo.defaultBranch === params.name) {
      throw new Error("Cannot delete default branch");
    }
    await resolved.storage.deleteRef(`refs/heads/${params.name}`);
  }

  /**
   * Return commit history for the given ref, optionally filtered to commits
   * that touched a specific path. `limit` caps the walk (default 50).
   */
  async listHistory(
    params: RepoRef & { ref: string; path?: string; limit?: number }
  ): Promise<HistoryEntry[]> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, params);
    if (!resolved) return [];

    const headSha = await this.resolveRefToCommit(resolved.storage, params.ref);
    if (!headSha) return [];

    const limit = params.limit ?? 50;
    const out: HistoryEntry[] = [];
    const seen = new Set<string>();
    const queue: string[] = [headSha];

    while (queue.length > 0 && out.length < limit) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);

      const raw = await resolved.storage.getObject(sha);
      if (!raw) continue;
      const obj = parseGitObject(raw);
      if (obj.type !== "commit") continue;
      const commit = parseCommit(obj.content);

      let touched = true;
      if (params.path) {
        touched = await this.commitTouchesPath(resolved.storage, sha, commit, params.path);
      }

      if (touched) {
        const author = this.parseAuthor(commit.author);
        out.push({
          version_id: sha,
          parent_version_ids: commit.parents,
          author_name: author.name,
          author_email: author.email,
          changed_at: new Date(author.timestamp * 1000).toISOString(),
          message: commit.message.trim(),
        });
      }

      for (const p of commit.parents) {
        if (!seen.has(p)) queue.push(p);
      }
    }
    return out;
  }

  /**
   * Find the most recent commit on `ref` that is ≤ `atDate`. Used for
   * as_of-style historical reads.
   */
  async resolveRefAt(
    params: RepoRef & { ref: string; atDate: string }
  ): Promise<{ sha: string } | null> {
    this.initCaches();
    const db = createDb(dbConnectionString(this.env));
    const resolved = await resolveRepo(db, this.env.REPOS_BUCKET, params);
    if (!resolved) return null;

    const headSha = await this.resolveRefToCommit(resolved.storage, params.ref);
    if (!headSha) return null;

    const cutoff = Math.floor(new Date(params.atDate).getTime() / 1000);
    if (isNaN(cutoff)) throw new Error("Invalid atDate");

    const seen = new Set<string>();
    const queue: string[] = [headSha];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const raw = await resolved.storage.getObject(sha);
      if (!raw) continue;
      const obj = parseGitObject(raw);
      if (obj.type !== "commit") continue;
      const commit = parseCommit(obj.content);
      const author = this.parseAuthor(commit.author);
      if (author.timestamp <= cutoff) return { sha };
      for (const p of commit.parents) {
        if (!seen.has(p)) queue.push(p);
      }
    }
    return null;
  }

  // ── Private helpers ──

  private initCaches() {
    setRepoCacheRef(this.env.AUTH_CACHE as KVNamespace | undefined);
    setRepoHotDORef(this.env.REPO_HOT_DO as DurableObjectNamespace | undefined);
    setRefCacheKvRef(this.env.AUTH_CACHE as KVNamespace | undefined);
    setObjCacheKvRef(this.env.GIT_OBJ_CACHE as KVNamespace | undefined);
    setCommitTreeCacheRef(this.env.TREE_CACHE as KVNamespace | undefined);
  }

  private async resolveRefToCommit(storage: GitR2Storage, ref: string): Promise<string | null> {
    if (ref === "HEAD") return storage.resolveHead();
    const branch = await storage.getRef(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = await storage.getRef(`refs/tags/${ref}`);
    if (tag) return tag;
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const exists = await storage.hasObject(ref);
      if (exists) return ref;
    }
    return null;
  }

  private async getTreeFromCommit(storage: GitR2Storage, commitSha: string): Promise<string | null> {
    const raw = await storage.getObject(commitSha);
    if (!raw) return null;
    const obj = parseGitObject(raw);
    if (obj.type !== "commit") return null;
    return parseCommit(obj.content).tree;
  }

  private async navigateToPath(
    storage: GitR2Storage,
    treeSha: string,
    pathParts: string[],
  ): Promise<{ entries: TreeEntry[]; sha: string } | null> {
    let currentSha = treeSha;
    for (const part of pathParts) {
      if (!part) continue;
      const raw = await storage.getObject(currentSha);
      if (!raw) return null;
      const obj = parseGitObject(raw);
      if (obj.type !== "tree") return null;
      const entries = parseTree(obj.content);
      const entry = entries.find((e) => e.name === part);
      if (!entry || entry.mode !== "40000") return null;
      currentSha = entry.sha;
    }
    const raw = await storage.getObject(currentSha);
    if (!raw) return null;
    const obj = parseGitObject(raw);
    if (obj.type !== "tree") return null;
    return { entries: parseTree(obj.content), sha: currentSha };
  }

  private async findBlobAtPath(
    storage: GitR2Storage,
    commitSha: string,
    path: string,
  ): Promise<string | null> {
    const treeSha = await this.getTreeFromCommit(storage, commitSha);
    if (!treeSha) return null;
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const parentParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];
    const parent = await this.navigateToPath(storage, treeSha, parentParts);
    if (!parent) return null;
    const entry = parent.entries.find((e) => e.name === fileName);
    if (!entry || entry.mode === "40000") return null;
    return entry.sha;
  }

  private async flattenTree(
    storage: GitR2Storage,
    entries: TreeEntry[],
    basePath: string,
    out: TreeEntryInfo[],
    limit: number,
  ): Promise<void> {
    for (const entry of entries) {
      if (out.length >= limit) return;
      const path = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.mode === "40000") {
        out.push({ name: entry.name, path, type: "folder", sha: entry.sha, mode: entry.mode });
        const raw = await storage.getObject(entry.sha);
        if (raw) {
          const obj = parseGitObject(raw);
          if (obj.type === "tree") {
            const subEntries = parseTree(obj.content);
            await this.flattenTree(storage, subEntries, path, out, limit);
          }
        }
      } else {
        out.push({ name: entry.name, path, type: "file", sha: entry.sha, mode: entry.mode });
      }
    }
  }

  private async commitTouchesPath(
    storage: GitR2Storage,
    commitSha: string,
    commit: { parents: string[]; tree: string },
    path: string,
  ): Promise<boolean> {
    const currentBlob = await this.findBlobAtPathFromTree(storage, commit.tree, path);
    if (commit.parents.length === 0) return !!currentBlob;
    for (const parentSha of commit.parents) {
      const rawP = await storage.getObject(parentSha);
      if (!rawP) continue;
      const objP = parseGitObject(rawP);
      if (objP.type !== "commit") continue;
      const commitP = parseCommit(objP.content);
      const parentBlob = await this.findBlobAtPathFromTree(storage, commitP.tree, path);
      if (currentBlob !== parentBlob) return true;
    }
    return false;
  }

  private async findBlobAtPathFromTree(
    storage: GitR2Storage,
    treeSha: string,
    path: string,
  ): Promise<string | null> {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const parentParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];
    const parent = await this.navigateToPath(storage, treeSha, parentParts);
    if (!parent) return null;
    const entry = parent.entries.find((e) => e.name === fileName);
    if (!entry || entry.mode === "40000") return null;
    return entry.sha;
  }

  private parseAuthor(author: string): { name: string; email: string; timestamp: number } {
    const match = author.match(/^(.+?)\s+<([^>]+)>\s+(\d+)/);
    if (match) {
      return { name: match[1], email: match[2], timestamp: parseInt(match[3], 10) };
    }
    return { name: author, email: "", timestamp: 0 };
  }
}
