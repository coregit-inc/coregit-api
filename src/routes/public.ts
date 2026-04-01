/**
 * Public read-only endpoints for public repositories
 *
 * All endpoints are unauthenticated — only returns repos with visibility="public".
 * Scoped by organization slug (B2B: "show public repos of this developer/project").
 *
 * GET /v1/orgs/:orgSlug/repos                      — List public repos of org
 * GET /v1/orgs/:orgSlug/repos/:slug                — Get public repo details
 * GET /v1/orgs/:orgSlug/repos/:slug/refs           — List branches and tags
 * GET /v1/orgs/:orgSlug/repos/:slug/tree/:ref/*path — Browse directory
 * GET /v1/orgs/:orgSlug/repos/:slug/blob/:ref/*path — Read file content
 * GET /v1/orgs/:orgSlug/repos/:slug/commits        — List commits
 * GET /v1/orgs/:orgSlug/repos/:slug/commits/:sha   — Get single commit
 * GET /v1/orgs/:orgSlug/repos/:slug/diff            — Diff between refs
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { repo, organization } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { parseGitObject, parseCommit, parseTree } from "../git/objects";
import { flattenTree, diffFlattenedTrees, computeDiffStatsFromDiffs } from "../git/cherry-pick";
import { resolveRef, getTreeFromCommit, navigateToPath, isBinaryContent } from "./files";
import { parseAuthorString } from "./commits";
import type { Env, Variables } from "../types";

const publicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

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
): Promise<{ orgId: string; found: typeof repo.$inferSelect; storage: GitR2Storage } | Response> {
  const orgResult = await resolveOrg(c);
  if (orgResult instanceof Response) return orgResult;
  const { orgId } = orgResult;

  const db = c.get("db");
  const slug = c.req.param("slug");

  const [found] = await db
    .select()
    .from(repo)
    .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
    .limit(1);

  // Don't leak existence of private repos
  if (!found || found.visibility !== "public") {
    return c.json({ error: "Repository not found" }, 404);
  }

  const storage = new GitR2Storage(c.env.REPOS_BUCKET, orgId, slug);
  return { orgId, found, storage };
}

// ── List public repos of an org ──

publicRoutes.get("/orgs/:orgSlug/repos", async (c) => {
  const orgResult = await resolveOrg(c);
  if (orgResult instanceof Response) return orgResult;
  const { orgId } = orgResult;

  const db = c.get("db");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);

  try {
    const repoList = await db
      .select()
      .from(repo)
      .where(and(eq(repo.orgId, orgId), eq(repo.visibility, "public")))
      .orderBy(repo.updatedAt)
      .limit(limit)
      .offset(offset);

    return c.json({
      repos: repoList.map((r) => ({
        id: r.id,
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

publicRoutes.get("/orgs/:orgSlug/repos/:slug", async (c) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;

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
      slug: found.slug,
      description: found.description,
      default_branch: found.defaultBranch,
      is_empty: isEmpty,
      git_url: `https://api.coregit.dev/${orgSlug}/${found.slug}.git`,
      created_at: found.createdAt,
      updated_at: found.updatedAt,
    });
  } catch (error) {
    console.error("Failed to get public repo:", error);
    return c.json({ error: "Failed to get repository" }, 500);
  }
});

// ── List refs ──

publicRoutes.get("/orgs/:orgSlug/repos/:slug/refs", async (c) => {
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
});

// ── Browse directory ──

publicRoutes.get("/orgs/:orgSlug/repos/:slug/tree/*", async (c) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;

  const slug = c.req.param("slug");
  const orgSlug = c.req.param("orgSlug");
  const url = new URL(c.req.url);
  const treePrefix = `/v1/orgs/${orgSlug}/repos/${slug}/tree/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(treePrefix) + treePrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathStr = parts.slice(1).join("/");
  const pathParts = pathStr.split("/").filter(Boolean);

  try {
    const commitSha = await resolveRef(storage, ref);
    if (!commitSha) return c.json({ error: "Ref not found" }, 404);

    const rootTreeSha = await getTreeFromCommit(storage, commitSha);
    if (!rootTreeSha) return c.json({ error: "Invalid commit" }, 500);

    const treeResult = await navigateToPath(storage, rootTreeSha, pathParts);
    if (!treeResult) return c.json({ error: "Path not found" }, 404);

    const items = treeResult.entries.map((entry) => ({
      name: entry.name,
      path: pathStr ? `${pathStr}/${entry.name}` : entry.name,
      type: entry.mode === "40000" ? "folder" : "file",
      sha: entry.sha,
      mode: entry.mode,
    }));

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({ items, path: pathStr, ref, sha: treeResult.sha });
  } catch (error) {
    console.error("Failed to fetch tree:", error);
    return c.json({ error: "Failed to fetch tree" }, 500);
  }
});

// ── Read file content ──

publicRoutes.get("/orgs/:orgSlug/repos/:slug/blob/*", async (c) => {
  const result = await resolvePublicRepo(c);
  if (result instanceof Response) return result;
  const { found, storage } = result;

  const slug = c.req.param("slug");
  const orgSlug = c.req.param("orgSlug");
  const url = new URL(c.req.url);
  const blobPrefix = `/v1/orgs/${orgSlug}/repos/${slug}/blob/`;
  const refAndPath = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(blobPrefix) + blobPrefix.length));

  const parts = refAndPath.split("/");
  const ref = parts[0] || found.defaultBranch;
  const pathParts = parts.slice(1);
  const pathStr = pathParts.join("/");

  if (!pathStr) return c.json({ error: "File path is required" }, 400);

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
    });
  } catch (error) {
    console.error("Failed to fetch blob:", error);
    return c.json({ error: "Failed to fetch blob" }, 500);
  }
});

// ── List commits ──

publicRoutes.get("/orgs/:orgSlug/repos/:slug/commits", async (c) => {
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
});

// ── Get single commit ──

publicRoutes.get("/orgs/:orgSlug/repos/:slug/commits/:sha", async (c) => {
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
});

// ── Diff between refs ──

publicRoutes.get("/orgs/:orgSlug/repos/:slug/diff", async (c) => {
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
});

export { publicRoutes };
