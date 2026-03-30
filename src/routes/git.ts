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
import { eq, and } from "drizzle-orm";
import { repo, organization } from "../db/schema";
import { parseBasicAuthKey, verifyApiKeyForGit } from "../auth/middleware";
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

/**
 * Strict auth — requires valid API key. Used for write operations (receive-pack).
 */
async function authenticateGit(c: any): Promise<GitAuthResult | Response> {
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;

  const orgParam = c.req.param("org");
  let repoSlug = c.req.param("repo");
  if (!orgParam || !repoSlug) return c.text("Invalid path", 400);
  if (repoSlug.endsWith(".git")) repoSlug = repoSlug.slice(0, -4);

  // Verify API key
  const apiKeyValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (!apiKeyValue) {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  }

  const authResult = await verifyApiKeyForGit(db, apiKeyValue);
  if (!authResult) {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  }

  const orgId = authResult.orgId;

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, repoSlug)))
    .limit(1);

  if (!found) return c.text("Repository not found", 404);

  const storage = new GitR2Storage(bucket, orgId, repoSlug);
  return { orgId, repoSlug, storage, defaultBranch: found.defaultBranch };
}

/**
 * Read-only auth — allows unauthenticated access to public repos.
 * Used for clone/fetch (upload-pack).
 */
async function authenticateGitReadOnly(c: any): Promise<GitAuthResult | Response> {
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;

  const orgParam = c.req.param("org");
  let repoSlug = c.req.param("repo");
  if (!orgParam || !repoSlug) return c.text("Invalid path", 400);
  if (repoSlug.endsWith(".git")) repoSlug = repoSlug.slice(0, -4);

  // Try API key auth first
  const apiKeyValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (apiKeyValue) {
    const authResult = await verifyApiKeyForGit(db, apiKeyValue);
    if (authResult) {
      const orgId = authResult.orgId;
      const [found] = await db
        .select()
        .from(repo)
        .where(and(eq(repo.orgId, orgId), eq(repo.slug, repoSlug)))
        .limit(1);
      if (!found) return c.text("Repository not found", 404);
      return { orgId, repoSlug, storage: new GitR2Storage(bucket, orgId, repoSlug), defaultBranch: found.defaultBranch };
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

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, org.id), eq(repo.slug, repoSlug)))
    .limit(1);

  if (!found || found.visibility !== "public") {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  }

  return { orgId: org.id, repoSlug, storage: new GitR2Storage(bucket, org.id, repoSlug), defaultBranch: found.defaultBranch };
}

// ── Routes ──

// GET /:org/:repo.git/info/refs
git.get("/:org/:repo/info/refs", async (c) => {
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
});

// POST /:org/:repo.git/git-upload-pack
git.post("/:org/:repo/git-upload-pack", async (c) => {
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

  // Full packfile generation
  const { packfile, shallowCommits } = await generatePackfile(wantShas, haveShas, storage, depth);

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
  recordUsage(c.executionCtx, db, orgId, "git_transfer_bytes", totalLength, {
    operation: "upload-pack",
  });

  return new Response(finalResponse, {
    headers: { "Content-Type": "application/x-git-upload-pack-result" },
  });
});

// POST /:org/:repo.git/git-receive-pack
git.post("/:org/:repo/git-receive-pack", async (c) => {
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
        if (update.newSha === zeroSha) {
          await storage.deleteRef(update.refName);
          refResults.push({ refName: update.refName, success: true });
        } else {
          if (update.oldSha !== zeroSha) {
            const currentSha = await storage.getRef(update.refName);
            if (currentSha !== update.oldSha) {
              refResults.push({ refName: update.refName, success: false, error: "non-fast-forward" });
              continue;
            }
          }
          await storage.setRef(update.refName, update.newSha);
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
  recordUsage(c.executionCtx, db, orgId, "git_transfer_bytes", body.length, {
    operation: "receive-pack",
  });

  return new Response(responseBytes, {
    headers: { "Content-Type": "application/x-git-receive-pack-result" },
  });
});

export { git };
