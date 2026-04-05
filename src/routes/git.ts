/**
 * Git Smart HTTP Protocol endpoints
 *
 * GET  /:org/:repo.git/info/refs?service=git-upload-pack|git-receive-pack
 * POST /:org/:repo.git/git-upload-pack   (clone/fetch)
 * POST /:org/:repo.git/git-receive-pack  (push)
 *
 * Adapted from strayl-api. Key differences:
 * - Auth via API key (Basic auth: username=orgSlug, password=apiKey)
 * - No branch protection, no merge-commit rejection, no deploy hooks
 * - Usage tracking for git transfer bytes
 */

import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { repo, organization, repoSync, repoSyncRun, externalConnection } from "../db/schema";
import { parseBasicAuthKey, verifyCredentialForGit } from "../auth/middleware";
import { hasRepoAccess, type Scopes } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { GitR2Storage } from "../git/storage";
import {
  encodePktLine,
  flushPkt,
  parsePktLines,
  pktLineDataToString,
  buildPktLines,
} from "../git/pkt-line";
import { generatePackfile, parsePackfile, findShallowCommits } from "../git/packfile";
import { parseCommit, parseGitObject } from "../git/objects";
import { recordUsage } from "../services/usage";
import { getDodoCustomerId } from "../services/dodo";
import { isValidSha, isValidRefPath } from "../git/validation";
import { decryptSecret } from "../services/secret-manager";
import { exportToGithub } from "../services/github-export";
import { exportToGitlab } from "../services/gitlab-export";
import { nanoid } from "nanoid";
import type { Env, Variables } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const git = new Hono<{ Bindings: Env; Variables: Variables }>();

function uploadPackCapabilities(defaultBranch: string): string {
  return [
    "multi_ack",
    "multi_ack_detailed",
    "thin-pack",
    "side-band",
    "side-band-64k",
    "ofs-delta",
    "shallow",
    "no-progress",
    "include-tag",
    `symref=HEAD:refs/heads/${defaultBranch}`,
  ].join(" ");
}

const RECEIVE_PACK_CAPABILITIES = [
  "report-status",
  "delete-refs",
  "ofs-delta",
].join(" ");

// ── Auth helpers ──

interface GitAuthResult {
  orgId: string;
  repoSlug: string;
  storage: GitR2Storage;
  defaultBranch: string;
}

/** Extract repo slug and optional namespace from git route params. */
function extractGitRepoParams(c: any): { orgParam: string; repoSlug: string; namespace: string | null } {
  const orgParam = c.req.param("org") || "";
  const namespace = c.req.param("namespace") ?? null;
  let repoSlug = c.req.param("repo") || "";
  if (repoSlug.endsWith(".git")) repoSlug = repoSlug.slice(0, -4);
  return { orgParam, repoSlug, namespace };
}

/**
 * Strict auth — requires valid credential with write access.
 * Used for write operations (receive-pack / push).
 */
async function authenticateGit(c: any): Promise<GitAuthResult | Response> {
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { orgParam, repoSlug, namespace } = extractGitRepoParams(c);
  if (!orgParam || !repoSlug) return c.text("Invalid path", 400);

  const credentialValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (!credentialValue) {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  }

  const authResult = await verifyCredentialForGit(db, credentialValue);
  if (!authResult) {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  }

  const orgId = authResult.orgId;
  const resolved = await resolveRepo(db, bucket, { orgId, slug: repoSlug, namespace });
  if (!resolved) return c.text("Repository not found", 404);

  if (!hasRepoAccess(authResult.scopes, resolved.scopeKey, "write")) {
    return c.text("Token does not have write access to this repository", 403);
  }

  return { orgId, repoSlug, storage: resolved.storage, defaultBranch: resolved.repo.defaultBranch };
}

/**
 * Read-only auth — allows unauthenticated access to public repos.
 * For authenticated requests, checks read scope.
 * Used for clone/fetch (upload-pack).
 */
async function authenticateGitReadOnly(c: any): Promise<GitAuthResult | Response> {
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { orgParam, repoSlug, namespace } = extractGitRepoParams(c);
  if (!orgParam || !repoSlug) return c.text("Invalid path", 400);

  // Try credential auth first (API key or scoped token)
  const credentialValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (credentialValue) {
    const authResult = await verifyCredentialForGit(db, credentialValue);
    if (authResult) {
      const orgId = authResult.orgId;
      const resolved = await resolveRepo(db, bucket, { orgId, slug: repoSlug, namespace });
      if (!resolved) return c.text("Repository not found", 404);

      if (!hasRepoAccess(authResult.scopes, resolved.scopeKey, "read")) {
        return c.text("Token does not have read access to this repository", 403);
      }

      return { orgId, repoSlug, storage: resolved.storage, defaultBranch: resolved.repo.defaultBranch };
    }
  }

  // No valid auth — check for public repo via org slug
  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, orgParam))
    .limit(1);

  if (!org) {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  }

  const resolved = await resolveRepo(db, bucket, { orgId: org.id, slug: repoSlug, namespace });
  if (!resolved || resolved.repo.visibility !== "public") {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  }

  return { orgId: org.id, repoSlug, storage: resolved.storage, defaultBranch: resolved.repo.defaultBranch };
}

// ── Auto-export trigger ──

/**
 * After a successful git push, check if this repo has an export sync config
 * with autoSync=true and trigger the export.
 */
async function triggerAutoExport(
  db: any,
  orgId: string,
  repoSlug: string,
  namespace: string | null,
  successfulRefs: string[],
  env: Env,
  storage: GitR2Storage
): Promise<void> {
  if (successfulRefs.length === 0) return;

  // Find repo record
  const condition = namespace
    ? and(eq(repo.orgId, orgId), eq(repo.namespace, namespace), eq(repo.slug, repoSlug))
    : and(eq(repo.orgId, orgId), isNull(repo.namespace), eq(repo.slug, repoSlug));

  let repoRecord;
  try {
    [repoRecord] = await db.select().from(repo).where(condition).limit(1);
  } catch (err) {
    console.error("Auto-export: failed to find repo:", err);
    return;
  }
  if (!repoRecord) return;

  // Find export sync config
  const [syncCfg] = await db
    .select()
    .from(repoSync)
    .where(
      and(
        eq(repoSync.repoId, repoRecord.id),
        eq(repoSync.direction, "export"),
        eq(repoSync.autoSync, true)
      )
    )
    .limit(1);

  if (!syncCfg) return;

  // Check if any of the pushed refs match the sync branch
  const syncBranch = syncCfg.defaultBranch || repoRecord.defaultBranch;
  const matchRef = `refs/heads/${syncBranch}`;
  if (!successfulRefs.includes(matchRef)) return;

  // Compare with lastSyncedSha to avoid infinite loops
  const currentHead = await storage.getRef(matchRef);
  if (currentHead && currentHead === syncCfg.lastSyncedSha) return;

  // Fetch connection
  const [conn] = await db
    .select()
    .from(externalConnection)
    .where(eq(externalConnection.id, syncCfg.connectionId))
    .limit(1);

  if (!conn) return;

  const token = await decryptSecret(env.SYNC_ENCRYPTION_KEY, conn.encryptedAccessToken);

  const runId = nanoid();
  await db.insert(repoSyncRun).values({
    id: runId,
    syncId: syncCfg.id,
    status: "running",
    startedAt: new Date(),
    message: `Auto-export triggered by git push`,
  });

  try {
    let exportResult;
    if (syncCfg.provider === "github") {
      const [owner, ghRepo] = syncCfg.remote.split("/");
      if (!owner || !ghRepo) throw new Error("Invalid remote format");
      exportResult = await exportToGithub({
        token,
        owner,
        repo: ghRepo,
        branch: syncBranch,
        storage,
        lastSyncedSha: syncCfg.lastSyncedSha ?? null,
      });
    } else if (syncCfg.provider === "gitlab") {
      exportResult = await exportToGitlab({
        token,
        projectPath: syncCfg.remote,
        branch: syncBranch,
        storage,
        lastSyncedSha: syncCfg.lastSyncedSha ?? null,
      });
    } else {
      throw new Error(`Unsupported provider: ${syncCfg.provider}`);
    }

    const remoteSha = syncCfg.provider === "github"
      ? (exportResult as { githubSha: string }).githubSha
      : (exportResult as { gitlabSha: string }).gitlabSha;

    await db
      .update(repoSync)
      .set({
        lastSyncedSha: currentHead || syncCfg.lastSyncedSha,
        lastSyncedAt: new Date(),
        lastError: null,
      })
      .where(eq(repoSync.id, syncCfg.id));

    await db
      .update(repoSyncRun)
      .set({
        status: exportResult.skipped ? "skipped" : "success",
        commitSha: currentHead || null,
        remoteSha,
        completedAt: new Date(),
        message: exportResult.skipped
          ? "Already up to date"
          : `Exported ${exportResult.filesChanged} files`,
      })
      .where(eq(repoSyncRun.id, runId));
  } catch (err) {
    console.error("Auto-export failed:", err);
    await db
      .update(repoSyncRun)
      .set({
        status: "error",
        completedAt: new Date(),
        message: err instanceof Error ? err.message : "Export failed",
      })
      .where(eq(repoSyncRun.id, runId));

    await db
      .update(repoSync)
      .set({ lastError: err instanceof Error ? err.message : "Export failed" })
      .where(eq(repoSync.id, syncCfg.id));
  }
}

// ── Routes ──

// GET /:org/:repo.git/info/refs  and  GET /:org/:namespace/:repo.git/info/refs
const infoRefsHandler = async (c: any) => {
  const service = c.req.query("service");
  if (!service || (service !== "git-upload-pack" && service !== "git-receive-pack")) {
    return c.text("Invalid or missing service parameter", 400);
  }

  // Read operations (clone/fetch) allow public access; write (push) requires auth
  const auth = service === "git-upload-pack"
    ? await authenticateGitReadOnly(c)
    : await authenticateGit(c);
  if (auth instanceof Response) return auth;
  const { storage, defaultBranch } = auth;

  const head = await storage.resolveHead();
  const refs = await storage.listRefs();

  const capabilities =
    service === "git-upload-pack" ? uploadPackCapabilities(defaultBranch) : RECEIVE_PACK_CAPABILITIES;

  let response = encodePktLine(`# service=${service}\n`) + flushPkt();

  if (!head && refs.size === 0) {
    const zeroSha = "0".repeat(40);
    response += encodePktLine(`${zeroSha} capabilities^{}\0${capabilities}\n`);
  } else {
    if (head) {
      response += encodePktLine(`${head} HEAD\0${capabilities}\n`);
    }
    for (const [refName, sha] of refs) {
      response += encodePktLine(`${sha} ${refName}\n`);
    }
  }

  response += flushPkt();

  return new Response(response, {
    headers: {
      "Content-Type": `application/x-${service}-advertisement`,
      "Cache-Control": "no-cache",
    },
  });
};
git.get("/:org/:repo/info/refs", infoRefsHandler);
git.get("/:org/:namespace/:repo/info/refs", infoRefsHandler);

// POST /:org/:repo.git/git-upload-pack
const uploadPackHandler = async (c: any) => {
  // Clone/fetch — allow public access
  const auth = await authenticateGitReadOnly(c);
  if (auth instanceof Response) return auth;
  const { orgId, storage } = auth;

  let body = new Uint8Array(await c.req.arrayBuffer());
  const contentEncoding = c.req.header("content-encoding");
  if (contentEncoding === "gzip") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(body);
    writer.close();
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLen += value.length;
      if (totalLen > 32 * 1024 * 1024) return c.text("Request body too large", 413);
      chunks.push(value);
    }
    body = new Uint8Array(totalLen);
    let off = 0;
    for (const chunk of chunks) { body.set(chunk, off); off += chunk.length; }
  }

  const pktLines = Array.from(parsePktLines(body));
  const wantShas: string[] = [];
  const haveShas: string[] = [];
  let depth: number | undefined;
  let done = false;

  for (const pkt of pktLines) {
    if (pkt.type !== "data" || !pkt.data) continue;
    const line = pktLineDataToString(pkt.data);
    if (line.startsWith("want ")) wantShas.push(line.split(" ")[1]);
    else if (line.startsWith("have ")) haveShas.push(line.slice(5));
    else if (line.startsWith("deepen ")) depth = parseInt(line.slice(7), 10);
    else if (line === "done") done = true;
  }

  if (wantShas.length === 0) {
    return new Response(encoder.encode("0008NAK\n" + flushPkt()), {
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  }

  // Shallow negotiation phase 1
  if (depth !== undefined && !done) {
    const shallowCommits = await findShallowCommits(wantShas, haveShas, storage, depth);
    const parts: Uint8Array[] = [];
    for (const sha of shallowCommits) {
      parts.push(encoder.encode(encodePktLine(`shallow ${sha}\n`)));
    }
    parts.push(encoder.encode(flushPkt()));
    const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) { result.set(p, off); off += p.length; }
    return new Response(result, {
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  }

  // Full packfile generation (with 25s timeout to avoid Worker crash)
  let packfile: Uint8Array;
  let shallowCommits: string[];
  try {
    const result = await generatePackfile(wantShas, haveShas, storage, depth);
    packfile = result.packfile;
    shallowCommits = result.shallowCommits;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "PackfileTimeoutError") {
      return new Response(
        "ERR Repository too large for clone. Use shallow clone: git clone --depth 1\n",
        { status: 504, headers: { "Content-Type": "text/plain" } }
      );
    }
    throw err;
  }

  const responseParts: Uint8Array[] = [];
  if (depth !== undefined) {
    for (const sha of shallowCommits) {
      responseParts.push(encoder.encode(encodePktLine(`shallow ${sha}\n`)));
    }
    responseParts.push(encoder.encode(flushPkt()));
  }
  responseParts.push(encoder.encode(encodePktLine("NAK\n")));

  let responseData = new Uint8Array(responseParts.reduce((acc, p) => acc + p.length, 0));
  let respOffset = 0;
  for (const part of responseParts) {
    responseData.set(part, respOffset);
    respOffset += part.length;
  }

  const SIDE_BAND_CHUNK_SIZE = 65515;
  const packParts: Uint8Array[] = [responseData];

  for (let i = 0; i < packfile.length; i += SIDE_BAND_CHUNK_SIZE) {
    const chunk = packfile.slice(i, i + SIDE_BAND_CHUNK_SIZE);
    const sideBandData = new Uint8Array(1 + chunk.length);
    sideBandData[0] = 1;
    sideBandData.set(chunk, 1);
    packParts.push(buildPktLines([sideBandData]));
  }
  packParts.push(encoder.encode(flushPkt()));

  const totalLength = packParts.reduce((acc, p) => acc + p.length, 0);
  const finalResponse = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of packParts) {
    finalResponse.set(part, offset);
    offset += part.length;
  }

  // Track git transfer
  const db = c.get("db");
  const dodoCustomerId = await getDodoCustomerId(db, orgId);
  recordUsage(c.executionCtx, db, orgId, "git_transfer_bytes", totalLength, {
    operation: "upload-pack",
  }, c.env.DODO_PAYMENTS_API_KEY, dodoCustomerId);

  return new Response(finalResponse, {
    headers: { "Content-Type": "application/x-git-upload-pack-result" },
  });
};
git.post("/:org/:repo/git-upload-pack", uploadPackHandler);
git.post("/:org/:namespace/:repo/git-upload-pack", uploadPackHandler);

// POST /:org/:repo.git/git-receive-pack
const receivePackHandler = async (c: any) => {
  // Push — always requires auth
  const auth = await authenticateGit(c);
  if (auth instanceof Response) return auth;
  const { orgId, storage } = auth;

  const body = new Uint8Array(await c.req.arrayBuffer());

  // Size limit for pushes
  if (body.length > 32 * 1024 * 1024) {
    return c.text("Pack exceeds 32 MB limit", 413);
  }

  // Find boundary between commands and packfile
  let commandsEnd = 0;
  let offset = 0;
  while (offset < body.length) {
    const lengthHex = decoder.decode(body.subarray(offset, offset + 4));
    const length = parseInt(lengthHex, 16);
    if (length === 0) { commandsEnd = offset + 4; break; }
    offset += length;
  }

  const commandData = body.subarray(0, commandsEnd);
  const pktLines = Array.from(parsePktLines(commandData));

  interface RefUpdate { oldSha: string; newSha: string; refName: string; }
  const refUpdates: RefUpdate[] = [];

  for (const pkt of pktLines) {
    if (pkt.type !== "data" || !pkt.data) continue;
    let line = pktLineDataToString(pkt.data);
    const nullIndex = line.indexOf("\0");
    if (nullIndex !== -1) line = line.slice(0, nullIndex);
    const parts = line.split(" ");
    if (parts.length >= 3) {
      refUpdates.push({ oldSha: parts[0], newSha: parts[1], refName: parts[2] });
    }
  }

  // Find and parse packfile
  let packfileParseResult: { success: boolean; error?: string } = { success: true };

  let packOffset = commandsEnd;
  while (packOffset < body.length - 4) {
    if (body[packOffset] === 0x50 && body[packOffset + 1] === 0x41 &&
        body[packOffset + 2] === 0x43 && body[packOffset + 3] === 0x4b) break;
    packOffset++;
  }

  if (packOffset < body.length - 4) {
    const packData = body.subarray(packOffset);
    try {
      await parsePackfile(packData, storage);
    } catch (err) {
      packfileParseResult = {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  // Update refs — no policies, just CAS
  const refResults: { refName: string; success: boolean; error?: string }[] = [];
  const zeroSha = "0".repeat(40);

  if (!packfileParseResult.success) {
    for (const update of refUpdates) {
      refResults.push({ refName: update.refName, success: false, error: `unpack failed: ${packfileParseResult.error}` });
    }
  } else {
    for (const update of refUpdates) {
      try {
        // Validate ref path (prevent traversal like refs/heads/../../HEAD)
        if (!isValidRefPath(update.refName)) {
          refResults.push({ refName: update.refName, success: false, error: "invalid ref name" });
          continue;
        }
        // Validate SHA format
        if (update.newSha !== zeroSha && !isValidSha(update.newSha)) {
          refResults.push({ refName: update.refName, success: false, error: "invalid SHA" });
          continue;
        }
        if (update.oldSha !== zeroSha && !isValidSha(update.oldSha)) {
          refResults.push({ refName: update.refName, success: false, error: "invalid SHA" });
          continue;
        }

        if (update.newSha === zeroSha) {
          await storage.deleteRef(update.refName);
          refResults.push({ refName: update.refName, success: true });
        } else {
          if (update.oldSha !== zeroSha) {
            // CAS: read current ref with etag, then conditional write
            const current = await storage.getRefWithEtag(update.refName);
            if (!current || current.sha !== update.oldSha) {
              refResults.push({ refName: update.refName, success: false, error: "non-fast-forward" });
              continue;
            }
            const ok = await storage.setRefConditional(update.refName, update.newSha, current.etag);
            if (!ok) {
              refResults.push({ refName: update.refName, success: false, error: "concurrent update, retry push" });
              continue;
            }
          } else {
            // New ref — plain setRef is fine (no race on creation)
            await storage.setRef(update.refName, update.newSha);
          }
          refResults.push({ refName: update.refName, success: true });
        }
      } catch (err) {
        refResults.push({
          refName: update.refName,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  }

  // Build report-status response
  const parts: Uint8Array[] = [];
  const createPktLine = (data: string): Uint8Array => {
    const dataBytes = encoder.encode(data);
    const totalLength = 4 + dataBytes.length;
    const hexLen = totalLength.toString(16).padStart(4, "0");
    const result = new Uint8Array(totalLength);
    result.set(encoder.encode(hexLen), 0);
    result.set(dataBytes, 4);
    return result;
  };

  parts.push(createPktLine(packfileParseResult.success ? "unpack ok\n" : `unpack ${packfileParseResult.error}\n`));
  for (const result of refResults) {
    parts.push(createPktLine(result.success ? `ok ${result.refName}\n` : `ng ${result.refName} ${result.error}\n`));
  }
  parts.push(encoder.encode("0000"));

  const totalSize = parts.reduce((acc, p) => acc + p.length, 0);
  const responseBytes = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of parts) { responseBytes.set(part, pos); pos += part.length; }

  // Track git transfer
  const db = c.get("db");
  const dodoCustomerIdPush = await getDodoCustomerId(db, orgId);
  recordUsage(c.executionCtx, db, orgId, "git_transfer_bytes", body.length, {
    operation: "receive-pack",
  }, c.env.DODO_PAYMENTS_API_KEY, dodoCustomerIdPush);

  // Trigger auto-export if configured
  const successfulRefs = refResults
    .filter((r) => r.success)
    .map((r) => r.refName);

  if (successfulRefs.length > 0) {
    const { repoSlug: pushRepoSlug, namespace: pushNamespace } = extractGitRepoParams(c);
    c.executionCtx.waitUntil(
      triggerAutoExport(db, orgId, pushRepoSlug, pushNamespace, successfulRefs, c.env, storage)
    );
  }

  return new Response(responseBytes, {
    headers: { "Content-Type": "application/x-git-receive-pack-result" },
  });
};
git.post("/:org/:repo/git-receive-pack", receivePackHandler);
git.post("/:org/:namespace/:repo/git-receive-pack", receivePackHandler);

export { git };
