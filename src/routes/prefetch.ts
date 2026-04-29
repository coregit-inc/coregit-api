/**
 * POST /v1/repos/:slug/prefetch
 *
 * Body: { ref?, globs: string[], max_bytes?, max_blob_bytes? }
 *
 * Streams NDJSON `{path, sha, size, encoding: "text"|"binary", content_b64}`
 * for blobs whose paths match one of `globs`. Stops when the cumulative
 * payload size exceeds `max_bytes` (default 16 MB, hard cap 32 MB) and
 * emits a final `{done, capped, bytes, entries}` line. Per-blob cap
 * `max_blob_bytes` defaults to 1 MB so prefetch can't be hijacked into
 * a backup endpoint.
 *
 * Reuses `getTreeBlobShas` (KV-cached) so glob filtering happens on the
 * pre-flattened path map without extra R2 reads.
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { resolveRef, isBinaryContent } from "./files";
import { getTreeBlobShas } from "../services/tree-resolver";
import { parseGitObject } from "../git/objects";
import type { Env, Variables } from "../types";

const prefetch = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_MAX_TOTAL = 16 * 1024 * 1024;
const HARD_MAX_TOTAL = 32 * 1024 * 1024;
const DEFAULT_MAX_BLOB = 1 * 1024 * 1024;
const HARD_MAX_BLOB = 4 * 1024 * 1024;
const MAX_GLOBS = 32;

/**
 * Translate a tiny glob subset (` ** `, `*`, `?`) into an anchored RegExp.
 * No brace/extglob/character-class support — keep the surface small so it
 * cannot be DoS'd into pathological backtracking.
 */
function globToRegex(glob: string): RegExp {
  let r = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { r += ".*"; i++; }
      else r += "[^/]*";
    } else if (c === "?") {
      r += "[^/]";
    } else if (/[a-zA-Z0-9_\-/]/.test(c)) {
      r += c;
    } else {
      r += "\\" + c;
    }
  }
  return new RegExp(`^${r}$`);
}

function toBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    s += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(s);
}

const prefetchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);
  if (c.get("sessionStub")) resolved.storage.setSessionStub(c.get("sessionStub") as DurableObjectStub);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  const found = resolved.repo;
  const storage = resolved.storage;

  let body: any = {};
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  const ref: string = typeof body?.ref === "string" && body.ref ? body.ref : found.defaultBranch;
  const rawGlobs = body?.globs;
  if (!Array.isArray(rawGlobs) || rawGlobs.length === 0) {
    return c.json({ error: "globs must be a non-empty array of strings" }, 400);
  }
  if (rawGlobs.length > MAX_GLOBS) {
    return c.json({ error: `globs array exceeds max ${MAX_GLOBS}` }, 400);
  }
  const globs: string[] = [];
  for (const g of rawGlobs) {
    if (typeof g !== "string" || !g) {
      return c.json({ error: "globs must be non-empty strings" }, 400);
    }
    if (g.length > 200) {
      return c.json({ error: "glob too long" }, 400);
    }
    globs.push(g);
  }

  const maxTotal = Math.min(
    typeof body?.max_bytes === "number" && body.max_bytes > 0 ? body.max_bytes : DEFAULT_MAX_TOTAL,
    HARD_MAX_TOTAL,
  );
  const maxBlob = Math.min(
    typeof body?.max_blob_bytes === "number" && body.max_blob_bytes > 0 ? body.max_blob_bytes : DEFAULT_MAX_BLOB,
    HARD_MAX_BLOB,
  );

  const commitSha = await resolveRef(storage, ref);
  if (!commitSha) return c.json({ error: "Ref not found" }, 404);

  const treeBlobMap = await getTreeBlobShas(storage, commitSha, c.env.TREE_CACHE);
  const regexes = globs.map(globToRegex);
  const matched: Array<{ sha: string; path: string }> = [];
  for (const [sha, path] of treeBlobMap) {
    if (regexes.some((r) => r.test(path))) matched.push({ sha, path });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let bytes = 0;
      let entries = 0;
      let capped = false;
      try {
        for (const { sha, path } of matched) {
          const blobData = await storage.getObject(sha);
          if (!blobData) continue;
          const parsed = parseGitObject(blobData);
          if (parsed.type !== "blob") continue;
          if (parsed.content.length > maxBlob) continue;
          const isBin = isBinaryContent(parsed.content);
          const content_b64 = toBase64(parsed.content);
          const line =
            JSON.stringify({
              path,
              sha,
              size: parsed.content.length,
              encoding: isBin ? "binary" : "text",
              content_b64,
            }) + "\n";
          if (bytes + line.length > maxTotal) {
            capped = true;
            break;
          }
          controller.enqueue(encoder.encode(line));
          bytes += line.length;
          entries++;
        }
        controller.enqueue(
          encoder.encode(JSON.stringify({ done: true, entries, bytes, capped, ref, commit_sha: commitSha }) + "\n"),
        );
      } catch (err) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ done: true, error: String(err), entries, bytes }) + "\n"),
        );
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
};

prefetch.post("/:slug/prefetch", apiKeyAuth, prefetchHandler);
prefetch.post("/:namespace/:slug/prefetch", apiKeyAuth, prefetchHandler);

export { prefetch };
