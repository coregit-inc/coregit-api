/**
 * Public read-only endpoints for public repositories
 *
 * All endpoints are unauthenticated — only returns repos with visibility="public".
 * Scoped by organization slug (B2B: "show public repos of this developer/project").
 *
 * Each detail route is registered twice (without and with namespace):
 *   /v1/orgs/:orgSlug/repos/:slug/...
 *   /v1/orgs/:orgSlug/repos/:namespace/:slug/...
 *
 * GET /v1/orgs/:orgSlug/repos                              — List public repos of org
 * GET /v1/orgs/:orgSlug/repos/[:namespace/]:slug            — Get public repo details
 * GET /v1/orgs/:orgSlug/repos/[:namespace/]:slug/refs       — List branches and tags
 * GET /v1/orgs/:orgSlug/repos/[:namespace/]:slug/tree/*     — Browse directory
 * GET /v1/orgs/:orgSlug/repos/[:namespace/]:slug/blob/*     — Read file content
 * GET /v1/orgs/:orgSlug/repos/[:namespace/]:slug/commits    — List commits
 * GET /v1/orgs/:orgSlug/repos/[:namespace/]:slug/commits/:sha — Get single commit
 * GET /v1/orgs/:orgSlug/repos/[:namespace/]:slug/diff       — Diff between refs
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { repo, organization } from "../db/schema";
import { resolveRepo, buildGitUrl } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit, parseTree } from "../git/objects";
import { flattenTree, diffFlattenedTrees, computeDiffStatsFromDiffs } from "../git/cherry-pick";
import { resolveRef, getTreeFromCommit, navigateToPath, isBinaryContent, flattenTreeRecursive } from "./files";
import { validateFilePath } from "../git/validation";
import { parseAuthorString } from "./commits";
import { checkIpRateLimit, ipRateLimitHeaders } from "../services/rate-limit";
import type { Env, Variables } from "../types";

const publicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── IP rate limiting for all public routes ──

publicRoutes.use("*", async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  const rl = await checkIpRateLimit(c.env.RATE_LIMITER, ip);
  if (!rl.allowed) {
    const headers = ipRateLimitHeaders(rl);
    for (const [k, v] of Object.entries(headers)) {
      c.header(k, v);
    }
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await next();
  // Attach rate limit headers to successful responses
  const headers = ipRateLimitHeaders(rl);
  for (const [k, v] of Object.entries(headers)) {
    c.header(k, v);
  }
});

// ── Helpers ──

async function resolveOrg(c: any): Promise<{ orgId: string } | Response> {
  const db = c.get("db");
  const orgSlug = c.req.param("orgSlug");

  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, orgSlug))
    .limit(1);

  if (!org) return c.json({ error: "Organization not found" }, 404);
  return { orgId: org.id };
}

async function resolvePublicRepo(
  c: any
): Promise<{ orgId: string; found: typeof repo.$inferSelect; storage: GitR2Storage; namespace: string | null } | Response> {
  const orgResult = await resolveOrg(c);
  if (orgResult instanceof Response) return orgResult;
  const { orgId } = orgResult;

  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });

  // Don't leak existence of private repos
  if (!resolved || resolved.repo.visibility !== "public") {
    return c.json({ error: "Repository not found" }, 404);
  }

  return { orgId, found: resolved.repo, storage: resolved.storage, namespace };
}

// ── List public repos of an org ──

publicRoutes.get("/orgs/:orgSlug/repos", async (c) => {
  const orgResult = await resolveOrg(c);
  if (orgResult instanceof Response) return orgResult;
  const { orgId } = orgResult;

  const db = c.get("db");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const offset = Math.min(Math.max(parseInt(c.req.query("offset") || "0", 10), 0), 10000);
  const nsFilter = c.req.query("namespace");

  try {
    let conditions = and(eq(repo.orgId, orgId), eq(repo.visibility, "public"));
    if (nsFilter) {
      conditions = and(conditions!, eq(repo.namespace, nsFilter));
    }

    const repoList = await db
      .select()
      .from(repo)
      .where(conditions)
      .orderBy(repo.updatedAt)
      .limit(limit)
      .offset(offset);

    return c.json({
      repos: repoList.map((r) => ({
        id: r.id,
        namespace: r.namespace,
        slug: r.slug,
        description: r.description,
        default_branch: r.defaultBranch,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
      limit,
      offset,
    });
  } catch (error) {
    console.error("Failed to list public repos:", error);
    return c.json({ error: "Failed to list repositories" }, 500);
  }
});

// ── Get public repo details ──

const getRepoHandler = async (c: any) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage, namespace } = result;

  try {
    const headSha = await storage.resolveHead();
    let isEmpty = !headSha;

    if (headSha) {
      const raw = await storage.getObject(headSha);
      if (raw) {
        const obj = parseGitObject(raw);
        if (obj.type === "commit") {
          const commit = parseCommit(obj.content);
          const treeRaw = await storage.getObject(commit.tree);
          if (treeRaw) {
            const treeObj = parseGitObject(treeRaw);
            isEmpty = treeObj.content.length === 0;
          }
        }
      }
    }

    const orgSlug = c.req.param("orgSlug");
    return c.json({
      id: found.id,
      namespace: found.namespace,
      slug: found.slug,
      description: found.description,
      default_branch: found.defaultBranch,
      is_empty: isEmpty,
      git_url: buildGitUrl(orgSlug, found.slug, found.namespace, null),
      created_at: found.createdAt,
      updated_at: found.updatedAt,
    });
  } catch (error) {
    console.error("Failed to get public repo:", error);
    return c.json({ error: "Failed to get repository" }, 500);
  }
};
publicRoutes.get("/orgs/:orgSlug/repos/:slug", getRepoHandler);
publicRoutes.get("/orgs/:orgSlug/repos/:namespace/:slug", getRepoHandler);

// ── List refs ──

const listRefsHandler = async (c: any) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;

  try {
    const refs = await storage.listRefs();
    const branchList: { name: string; sha: string; type: string }[] = [];
    const tagList: { name: string; sha: string; type: string }[] = [];

    for (const [refName, sha] of refs) {
      if (refName.startsWith("refs/heads/")) {
        branchList.push({ name: refName.slice(11), sha, type: "branch" });
      } else if (refName.startsWith("refs/tags/")) {
        tagList.push({ name: refName.slice(10), sha, type: "tag" });
      }
    }

    branchList.sort((a, b) => a.name.localeCompare(b.name));
    tagList.sort((a, b) => a.name.localeCompare(b.name));

    return c.json({ branches: branchList, tags: tagList, default_branch: found.defaultBranch });
  } catch (error) {
    console.error("Failed to list refs:", error);
    return c.json({ error: "Failed to list refs" }, 500);
  }
};
publicRoutes.get("/orgs/:orgSlug/repos/:slug/refs", listRefsHandler);
publicRoutes.get("/orgs/:orgSlug/repos/:namespace/:slug/refs", listRefsHandler);

// ── Browse directory ──

const treeHandler = async (c: any) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage, namespace } = result;

  const slug = c.req.param("slug");
  const orgSlug = c.req.param("orgSlug");
  const url = new URL(c.req.url);
  // Build the prefix dynamically based on namespace
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  const treePrefix = `/v1/orgs/${orgSlug}/repos/${repoPath}/tree/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(treePrefix) + treePrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathStr = parts.slice(1).join("/");
  const pathParts = pathStr.split("/").filter(Boolean);

  if (pathStr) {
    const pathError = validateFilePath(pathStr);
    if (pathError) return c.json({ error: pathError }, 400);
  }

  const recursive = c.req.query("recursive") === "true";

  try {
    const commitSha = await resolveRef(storage, ref);
    if (!commitSha) return c.json({ error: "Ref not found" }, 404);

    const rootTreeSha = await getTreeFromCommit(storage, commitSha);
    if (!rootTreeSha) return c.json({ error: "Invalid commit" }, 500);

    const treeResult = await navigateToPath(storage, rootTreeSha, pathParts);
    if (!treeResult) return c.json({ error: "Path not found" }, 404);

    // ETag: tree SHA is content-addressed and immutable
    const etag = `"${treeResult.sha}"`;
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304 });
    }

    const isCommitSha = /^[0-9a-f]{40}$/i.test(ref);
    const cacheControl = isCommitSha
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60";

    let items: { name: string; path: string; type: string; sha: string; mode: string }[];
    let truncated = false;

    if (recursive) {
      const RECURSIVE_LIMIT = 10_000;
      const flatItems: typeof items = [];
      await flattenTreeRecursive(storage, treeResult.entries, pathStr, flatItems, RECURSIVE_LIMIT);
      truncated = flatItems.length >= RECURSIVE_LIMIT;
      items = flatItems;
    } else {
      items = treeResult.entries.map((entry) => ({
        name: entry.name,
        path: pathStr ? `${pathStr}/${entry.name}` : entry.name,
        type: entry.mode === "40000" ? "folder" : "file",
        sha: entry.sha,
        mode: entry.mode,
      }));
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json(
      { items, path: pathStr, ref, sha: treeResult.sha, truncated },
      200,
      { "ETag": etag, "Cache-Control": cacheControl },
    );
  } catch (error) {
    console.error("Failed to fetch tree:", error);
    return c.json({ error: "Failed to fetch tree" }, 500);
  }
};
publicRoutes.get("/orgs/:orgSlug/repos/:slug/tree/*", treeHandler);
publicRoutes.get("/orgs/:orgSlug/repos/:namespace/:slug/tree/*", treeHandler);

// ── Read file content ──

const blobHandler = async (c: any) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage, namespace } = result;

  const slug = c.req.param("slug");
  const orgSlug = c.req.param("orgSlug");
  const url = new URL(c.req.url);
  // Build the prefix dynamically based on namespace
  const repoPath = namespace ? `${namespace}/${slug}` : slug;
  const blobPrefix = `/v1/orgs/${orgSlug}/repos/${repoPath}/blob/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(blobPrefix) + blobPrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathParts = parts.slice(1);
  const pathStr = pathParts.join("/");

  if (!pathStr) return c.json({ error: "File path is required" }, 400);

  const pathError = validateFilePath(pathStr);
  if (pathError) return c.json({ error: pathError }, 400);

  try {
    const commitSha = await resolveRef(storage, ref);
    if (!commitSha) return c.json({ error: "Ref not found" }, 404);

    const rootTreeSha = await getTreeFromCommit(storage, commitSha);
    if (!rootTreeSha) return c.json({ error: "Invalid commit" }, 500);

    // Navigate to parent directory
    const dirParts = pathParts.slice(0, -1);
    const fileName = pathParts[pathParts.length - 1];

    let treeEntries;
    if (dirParts.length === 0) {
      const raw = await storage.getObject(rootTreeSha);
      if (!raw) return c.json({ error: "Tree not found" }, 500);
      const obj = parseGitObject(raw);
      treeEntries = parseTree(obj.content);
    } else {
      const treeResult = await navigateToPath(storage, rootTreeSha, dirParts);
      if (!treeResult) return c.json({ error: "Directory not found" }, 404);
      treeEntries = treeResult.entries;
    }

    const fileEntry = treeEntries.find((e) => e.name === fileName);
    if (!fileEntry) return c.json({ error: "File not found" }, 404);
    if (fileEntry.mode === "40000") return c.json({ error: "Path is a directory" }, 400);

    // ETag: git objects are immutable by SHA — cache forever
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch === `"${fileEntry.sha}"`) {
      return new Response(null, { status: 304 });
    }

    const blobData = await storage.getObject(fileEntry.sha);
    if (!blobData) return c.json({ error: "Blob not found" }, 500);

    const parsed = parseGitObject(blobData);
    if (parsed.type !== "blob") return c.json({ error: "Invalid blob" }, 500);

    const binary = isBinaryContent(parsed.content);
    let content: string;
    let encoding: "utf-8" | "base64";

    if (binary) {
      const chunkSize = 8192;
      let binaryStr = '';
      for (let i = 0; i < parsed.content.length; i += chunkSize) {
        const chunk = parsed.content.subarray(i, Math.min(i + chunkSize, parsed.content.length));
        binaryStr += String.fromCharCode.apply(null, chunk as unknown as number[]);
      }
      content = btoa(binaryStr);
      encoding = "base64";
    } else {
      content = new TextDecoder().decode(parsed.content);
      encoding = "utf-8";
    }

    return c.json({
      content,
      encoding,
      path: pathStr,
      sha: fileEntry.sha,
      size: parsed.content.length,
    }, 200, {
      "ETag": `"${fileEntry.sha}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  } catch (error) {
    console.error("Failed to fetch blob:", error);
    return c.json({ error: "Failed to fetch blob" }, 500);
  }
};
publicRoutes.get("/orgs/:orgSlug/repos/:slug/blob/*", blobHandler);
publicRoutes.get("/orgs/:orgSlug/repos/:namespace/:slug/blob/*", blobHandler);

// ── List commits ──

const listCommitsHandler = async (c: any) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;

  const ref = c.req.query("ref") || c.req.query("branch");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const branchName = ref || found.defaultBranch;

  let commitSha = await storage.getRef(`refs/heads/${branchName}`);
  if (!commitSha && branchName && /^[0-9a-f]{40}$/i.test(branchName)) {
    commitSha = branchName;
  }
  if (!commitSha) return c.json({ error: "Ref not found" }, 404);

  try {
    const commitList: {
      sha: string;
      message: string;
      author_name: string;
      author_email: string;
      timestamp: number;
      parents: string[];
    }[] = [];
    let currentSha: string | null = commitSha;

    while (currentSha && commitList.length < limit) {
      const raw = await storage.getObject(currentSha);
      if (!raw) break;
      const obj = parseGitObject(raw);
      if (obj.type !== "commit") break;
      const commit = parseCommit(obj.content);
      const authorInfo = parseAuthorString(commit.author);

      commitList.push({
        sha: currentSha,
        message: commit.message,
        author_name: authorInfo.name,
        author_email: authorInfo.email,
        timestamp: authorInfo.timestamp,
        parents: commit.parents,
      });

      currentSha = commit.parents[0] || null;
    }

    return c.json({
      commits: commitList,
      ref: branchName,
      has_more: currentSha !== null && commitList.length >= limit,
    });
  } catch (error) {
    console.error("Failed to list commits:", error);
    return c.json({ error: "Failed to list commits" }, 500);
  }
};
publicRoutes.get("/orgs/:orgSlug/repos/:slug/commits", listCommitsHandler);
publicRoutes.get("/orgs/:orgSlug/repos/:namespace/:slug/commits", listCommitsHandler);

// ── Get single commit ──

const getCommitHandler = async (c: any) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { storage } = result;

  const sha = c.req.param("sha");
  const raw = await storage.getObject(sha);
  if (!raw) return c.json({ error: "Commit not found" }, 404);

  const obj = parseGitObject(raw);
  if (obj.type !== "commit") return c.json({ error: "Object is not a commit" }, 400);

  const commit = parseCommit(obj.content);
  const authorInfo = parseAuthorString(commit.author);

  return c.json({
    sha,
    message: commit.message,
    tree: commit.tree,
    author_name: authorInfo.name,
    author_email: authorInfo.email,
    timestamp: authorInfo.timestamp,
    parents: commit.parents,
  });
};
publicRoutes.get("/orgs/:orgSlug/repos/:slug/commits/:sha", getCommitHandler);
publicRoutes.get("/orgs/:orgSlug/repos/:namespace/:slug/commits/:sha", getCommitHandler);

// ── Diff between refs ──

const diffHandler = async (c: any) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { storage } = result;

  const baseRef = c.req.query("base");
  const headRef = c.req.query("head");
  if (!baseRef || !headRef) {
    return c.json({ error: "base and head query parameters are required" }, 400);
  }

  try {
    const [baseSha, headSha] = await Promise.all([
      resolveRef(storage, baseRef),
      resolveRef(storage, headRef),
    ]);
    if (!baseSha) return c.json({ error: `Base ref '${baseRef}' not found` }, 404);
    if (!headSha) return c.json({ error: `Head ref '${headRef}' not found` }, 404);

    const [baseTreeSha, headTreeSha] = await Promise.all([
      getTreeFromCommit(storage, baseSha),
      getTreeFromCommit(storage, headSha),
    ]);
    if (!baseTreeSha) return c.json({ error: "Invalid base commit" }, 500);
    if (!headTreeSha) return c.json({ error: "Invalid head commit" }, 500);

    const [baseFlat, headFlat] = await Promise.all([
      flattenTree(storage, baseTreeSha),
      flattenTree(storage, headTreeSha),
    ]);

    const diffs = diffFlattenedTrees(baseFlat, headFlat);
    const stats = await computeDiffStatsFromDiffs(storage, diffs);

    const fileList = diffs.map((d) => ({
      path: d.path,
      status: d.type === "add" ? "added" : d.type === "delete" ? "removed" : "modified",
      old_sha: d.oldSha || null,
      new_sha: d.newSha || null,
    }));

    return c.json({
      base: baseSha,
      head: headSha,
      files: fileList,
      total_files_changed: stats.filesChanged,
      total_additions: stats.additions,
      total_deletions: stats.deletions,
    });
  } catch (error) {
    console.error("Failed to compute diff:", error);
    return c.json({ error: "Failed to compute diff" }, 500);
  }
};
publicRoutes.get("/orgs/:orgSlug/repos/:slug/diff", diffHandler);
publicRoutes.get("/orgs/:orgSlug/repos/:namespace/:slug/diff", diffHandler);

export { publicRoutes };
