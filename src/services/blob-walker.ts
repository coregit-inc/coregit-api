/**
 * Walk all git objects reachable from a head SHA — commits, trees, and blobs.
 *
 * Used by Instant Fork to materialize `blob_repo` rows for every reachable
 * object at fork-creation time. Idempotent: yields each SHA at most once.
 *
 * For very large repos this becomes IO-bound on R2 reads (one round-trip per
 * commit and tree). Callers above some object-count threshold should run this
 * inside a queue consumer, not in the request handler.
 */
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseTree, parseCommit, type GitObjectType } from "../git/objects";

export interface ReachableObject {
  sha: string;
  type: GitObjectType;
  /** Size of the object content (excludes git's "type size\0" header). */
  size: number;
}

export interface WalkOptions {
  /** Stop after this many objects yielded. Useful for a bounded queue task. */
  maxObjects?: number;
  /** Stop after walking this many commits. Defaults to unbounded. */
  maxCommits?: number;
}

/**
 * Yield every reachable object exactly once. Walks history, trees, blobs.
 * Caller decides whether to actually read blob bytes — we do read them, since
 * we need their sizes for `blob.size_bytes` (billing).
 */
export async function* walkReachable(
  storage: GitR2Storage,
  headSha: string,
  options: WalkOptions = {},
): AsyncIterable<ReachableObject> {
  const seen = new Set<string>();
  const queue: string[] = [headSha];
  let yielded = 0;
  let commitsWalked = 0;

  // Tight predicate — git SHAs are 40 hex chars; anything else is the result
  // of a malformed object header and would crash storage.getObject's SHA
  // validator with "Invalid SHA: ".
  const isSha = (s: string | undefined | null): s is string =>
    typeof s === "string" && /^[0-9a-f]{40}$/i.test(s);

  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (!isSha(sha) || seen.has(sha)) continue;
    seen.add(sha);

    let data: Uint8Array | null;
    try {
      data = await storage.getObject(sha);
    } catch {
      continue; // bad sha or transient storage error — keep walking
    }
    if (!data) continue;

    let parsed;
    try {
      parsed = parseGitObject(data);
    } catch {
      continue; // corrupt object — skip
    }

    yield { sha, type: parsed.type, size: parsed.size };
    yielded++;
    if (options.maxObjects && yielded >= options.maxObjects) return;

    if (parsed.type === "commit") {
      commitsWalked++;
      if (options.maxCommits && commitsWalked > options.maxCommits) continue;
      try {
        const commit = parseCommit(parsed.rawContent);
        if (isSha(commit.tree)) queue.push(commit.tree);
        for (const parentSha of commit.parents) if (isSha(parentSha)) queue.push(parentSha);
      } catch {
        // unparseable commit — skip its descendants
      }
    } else if (parsed.type === "tree") {
      try {
        const entries = parseTree(parsed.rawContent);
        for (const e of entries) if (isSha(e.sha)) queue.push(e.sha);
      } catch {
        // unparseable tree — skip its descendants
      }
    }
    // blob/tag: leaf nodes
  }
}

/**
 * Convenience: collect all reachable objects into an array.
 * Suitable for small repos (sync materialization). Use `walkReachable` directly
 * for streaming/batched processing.
 */
export async function collectReachable(
  storage: GitR2Storage,
  headSha: string,
  options: WalkOptions = {},
): Promise<ReachableObject[] > {
  const out: ReachableObject[] = [];
  for await (const obj of walkReachable(storage, headSha, options)) {
    out.push(obj);
  }
  return out;
}
