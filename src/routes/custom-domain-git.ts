/**
 * Git Smart HTTP routes for custom domains.
 *
 * On custom domains, the URL is /:repo.git/* (no org prefix — domain IS the org).
 * The org is already resolved by the custom domain middleware in index.ts.
 *
 * Routes:
 *   GET  /:repo/info/refs
 *   POST /:repo/git-upload-pack
 *   POST /:repo/git-receive-pack
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { repo } from "../db/schema";
import { parseBasicAuthKey, verifyCredentialForGit } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
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
import type { Env, Variables } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const customDomainGit = new Hono<{ Bindings: Env; Variables: Variables }>();

function uploadPackCapabilities(defaultBranch: string): string {
  return [
    "multi_ack", "multi_ack_detailed", "thin-pack", "side-band",
    "side-band-64k", "ofs-delta", "shallow", "no-progress", "include-tag",
    `symref=HEAD:refs/heads/${defaultBranch}`,
  ].join(" ");
}

const RECEIVE_PACK_CAPABILITIES = ["report-status", "delete-refs", "ofs-delta"].join(" ");

interface CDGitAuth {
  orgId: string;
  repoSlug: string;
  storage: GitR2Storage;
  defaultBranch: string;
}

/**
 * Auth for custom domain git — org already resolved from domain.
 * For writes (push), API key is still required.
 * For reads (clone), public repos are accessible without auth.
 */
async function authenticateCDGit(c: any, requireAuth: boolean): Promise<CDGitAuth | Response> {
  const customDomain = c.get("customDomain");
  if (!customDomain) return c.text("Not found", 404);

  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const orgId = c.get("orgId");

  const namespace = c.req.param("namespace") ?? null;
  let repoSlug = c.req.param("repo");
  if (!repoSlug) return c.text("Invalid path", 400);
  if (repoSlug.endsWith(".git")) repoSlug = repoSlug.slice(0, -4);

  const requiredAction = requireAuth ? "write" : "read";

  // Try credential auth (API key or scoped token)
  const credentialValue = parseBasicAuthKey(c.req.header("Authorization"));
  if (credentialValue) {
    const authResult = await verifyCredentialForGit(db, credentialValue);
    if (!authResult || authResult.orgId !== orgId) {
      return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
    }
    const resolved = await resolveRepo(db, bucket, { orgId, slug: repoSlug, namespace });
    if (!resolved) return c.text("Repository not found", 404);
    if (!hasRepoAccess(authResult.scopes, resolved.scopeKey, requiredAction)) {
      return c.text(`Token does not have ${requiredAction} access to this repository`, 403);
    }
    return { orgId, repoSlug, storage: resolved.storage, defaultBranch: resolved.repo.defaultBranch };
  } else if (requireAuth) {
    return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
  } else {
    // No auth — only public repos
    const resolved = await resolveRepo(db, bucket, { orgId, slug: repoSlug, namespace });
    if (!resolved || resolved.repo.visibility !== "public") {
      return c.text("", 401, { "WWW-Authenticate": 'Basic realm="CoreGit"' });
    }
    return { orgId, repoSlug, storage: resolved.storage, defaultBranch: resolved.repo.defaultBranch };
  }
}

// ── Routes ──

// GET /:repo/info/refs  and  GET /:namespace/:repo/info/refs
const cdInfoRefsHandler = async (c: any, next: any) => {
  if (!c.get("customDomain")) return next();

  const service = c.req.query("service");
  if (!service || (service !== "git-upload-pack" && service !== "git-receive-pack")) {
    return c.text("Invalid or missing service parameter", 400);
  }

  const auth = await authenticateCDGit(c, service === "git-receive-pack");
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
customDomainGit.get("/:repo/info/refs", cdInfoRefsHandler);
customDomainGit.get("/:namespace/:repo/info/refs", cdInfoRefsHandler);

// POST /:repo/git-upload-pack
const cdUploadPackHandler = async (c: any, next: any) => {
  if (!c.get("customDomain")) return next();

  const auth = await authenticateCDGit(c, false);
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
  for (const part of responseParts) { responseData.set(part, respOffset); respOffset += part.length; }

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
  for (const part of packParts) { finalResponse.set(part, offset); offset += part.length; }

  const db = c.get("db");
  const dodoCustomerId = await getDodoCustomerId(db, orgId);
  recordUsage(c.executionCtx, db, orgId, "git_transfer_bytes", totalLength, {
    operation: "upload-pack",
  }, c.env.DODO_PAYMENTS_API_KEY, dodoCustomerId);

  return new Response(finalResponse, {
    headers: { "Content-Type": "application/x-git-upload-pack-result" },
  });
};
customDomainGit.post("/:repo/git-upload-pack", cdUploadPackHandler);
customDomainGit.post("/:namespace/:repo/git-upload-pack", cdUploadPackHandler);

// POST /:repo/git-receive-pack
const cdReceivePackHandler = async (c: any, next: any) => {
  if (!c.get("customDomain")) return next();

  const auth = await authenticateCDGit(c, true);
  if (auth instanceof Response) return auth;
  const { orgId, storage } = auth;

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.length > 32 * 1024 * 1024) {
    return c.text("Pack exceeds 32 MB limit", 413);
  }

  let commandsEnd = 0;
  let offsetParse = 0;
  while (offsetParse < body.length) {
    const lengthHex = decoder.decode(body.subarray(offsetParse, offsetParse + 4));
    const length = parseInt(lengthHex, 16);
    if (length === 0) { commandsEnd = offsetParse + 4; break; }
    offsetParse += length;
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

  let packfileParseResult: { success: boolean; error?: string } = { success: true };
  let packOffset = commandsEnd;
  while (packOffset < body.length - 4) {
    if (body[packOffset] === 0x50 && body[packOffset + 1] === 0x41 &&
        body[packOffset + 2] === 0x43 && body[packOffset + 3] === 0x4b) break;
    packOffset++;
  }

  if (packOffset < body.length - 4) {
    try {
      await parsePackfile(body.subarray(packOffset), storage);
    } catch (err) {
      packfileParseResult = {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  const refResults: { refName: string; success: boolean; error?: string }[] = [];
  const zeroSha = "0".repeat(40);

  if (!packfileParseResult.success) {
    for (const update of refUpdates) {
      refResults.push({ refName: update.refName, success: false, error: `unpack failed: ${packfileParseResult.error}` });
    }
  } else {
    for (const update of refUpdates) {
      try {
        if (!isValidRefPath(update.refName)) {
          refResults.push({ refName: update.refName, success: false, error: "invalid ref name" });
          continue;
        }
        if (update.newSha !== zeroSha && !isValidSha(update.newSha)) {
          refResults.push({ refName: update.refName, success: false, error: "invalid SHA" });
          continue;
        }

        if (update.newSha === zeroSha) {
          await storage.deleteRef(update.refName);
          refResults.push({ refName: update.refName, success: true });
        } else {
          if (update.oldSha !== zeroSha) {
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
            await storage.setRef(update.refName, update.newSha);
          }
          refResults.push({ refName: update.refName, success: true });
        }
      } catch (err) {
        refResults.push({ refName: update.refName, success: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  }

  const reportParts: Uint8Array[] = [];
  const createPktLine = (data: string): Uint8Array => {
    const dataBytes = encoder.encode(data);
    const totalLength = 4 + dataBytes.length;
    const hexLen = totalLength.toString(16).padStart(4, "0");
    const result = new Uint8Array(totalLength);
    result.set(encoder.encode(hexLen), 0);
    result.set(dataBytes, 4);
    return result;
  };

  reportParts.push(createPktLine(packfileParseResult.success ? "unpack ok\n" : `unpack ${packfileParseResult.error}\n`));
  for (const result of refResults) {
    reportParts.push(createPktLine(result.success ? `ok ${result.refName}\n` : `ng ${result.refName} ${result.error}\n`));
  }
  reportParts.push(encoder.encode("0000"));

  const totalSize = reportParts.reduce((acc, p) => acc + p.length, 0);
  const responseBytes = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of reportParts) { responseBytes.set(part, pos); pos += part.length; }

  const db = c.get("db");
  const dodoCustomerIdPush = await getDodoCustomerId(db, orgId);
  recordUsage(c.executionCtx, db, orgId, "git_transfer_bytes", body.length, {
    operation: "receive-pack",
  }, c.env.DODO_PAYMENTS_API_KEY, dodoCustomerIdPush);

  return new Response(responseBytes, {
    headers: { "Content-Type": "application/x-git-receive-pack-result" },
  });
};
customDomainGit.post("/:repo/git-receive-pack", cdReceivePackHandler);
customDomainGit.post("/:namespace/:repo/git-receive-pack", cdReceivePackHandler);

export { customDomainGit };
