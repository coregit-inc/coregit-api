/**
 * Shared ref resolution and tree blob SHA utilities.
 * Used by semantic search, code graph, and hybrid search routes.
 */

import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit } from "../git/objects";
import { flattenTree } from "../git/cherry-pick";

/**
 * Resolve a ref (branch name or commit SHA) to a commit SHA.
 */
export async function resolveRef(storage: GitR2Storage, ref: string): Promise<string | null> {
  // Try as branch first
  const branchSha = await storage.getRef(`refs/heads/${ref}`);
  if (branchSha) return branchSha;

  // Try as raw commit SHA (40 hex chars)
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const raw = await storage.getObject(ref);
    if (raw) {
      const obj = parseGitObject(raw);
      if (obj.type === "commit") return ref;
    }
  }

  return null;
}

/**
 * Get the set of blob SHAs for a commit, with KV caching.
 * Commit SHA → tree is immutable, so cache never invalidates.
 * Returns Map<blobSha, filePath>.
 */
/**
 * SHA-256 hash for cache keys. Shared across semantic-search, graph, hybrid-search.
 */
export async function hashCacheKey(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("|"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getTreeBlobShas(
  storage: GitR2Storage,
  commitSha: string,
  kv?: KVNamespace
): Promise<Map<string, string>> {
  const cacheKey = `tree:${commitSha}`;

  // Try KV cache
  if (kv) {
    const cached = await kv.get(cacheKey, "json") as Array<[string, string]> | null;
    if (cached) {
      return new Map(cached);
    }
  }

  // Cache miss — flatten tree from R2 (pass kv as L2 tree cache)
  const raw = await storage.getObject(commitSha);
  if (!raw) throw new Error(`Commit not found: ${commitSha}`);
  const obj = parseGitObject(raw);
  if (obj.type !== "commit") throw new Error(`Not a commit: ${commitSha}`);
  const commit = parseCommit(obj.content);
  const tree = await flattenTree(storage, commit.tree, "", undefined, kv);

  // Build blobSha → filePath map (skip dirs)
  const blobMap = new Map<string, string>();
  for (const [path, entry] of tree) {
    if (entry.mode === "40000") continue;
    blobMap.set(entry.sha, path);
  }

  // Store in KV (commit SHA is immutable — no TTL needed)
  if (kv) {
    await kv.put(cacheKey, JSON.stringify([...blobMap.entries()])).catch(() => {});
  }

  return blobMap;
}
