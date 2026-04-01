import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { apiKeyAuth } from "../auth/middleware";
import type { Env, Variables } from "../types";
import { repo, repoSync, repoSyncRun, externalConnection } from "../db/schema";
import { GitR2Storage } from "../git/storage";
import { decryptSecret } from "../services/secret-manager";
import { syncFromGithub } from "../services/github-sync";
import { syncFromGitlab } from "../services/gitlab-sync";
import type { CommitAuthor } from "../services/commit-builder";

const syncRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

interface SyncRequestBody {
  sync_id: string;
  branch?: string;
}

function parseGithubRemote(remote: string): { owner: string; repo: string } {
  const [owner, name] = remote.split("/");
  if (!owner || !name) {
    throw new Error("GitHub remote must be in owner/repo format");
  }
  return { owner, repo: name };
}

syncRoutes.post("/:slug/sync", apiKeyAuth, async (c) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const { slug } = c.req.param();

  let body: SyncRequestBody;
  let runId: string | null = null;
  try {
    body = await c.req.json<SyncRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.sync_id) {
    return c.json({ error: "sync_id is required" }, 400);
  }

  try {
    const [repoRecord] = await db
      .select()
      .from(repo)
      .where(and(eq(repo.orgId, orgId), eq(repo.slug, slug)))
      .limit(1);

    if (!repoRecord) {
      return c.json({ error: "Repository not found" }, 404);
    }

    const [syncConfig] = await db
      .select()
      .from(repoSync)
      .where(and(eq(repoSync.id, body.sync_id), eq(repoSync.orgId, orgId)))
      .limit(1);

    if (!syncConfig) {
      return c.json({ error: "Sync configuration not found" }, 404);
    }

    const [connection] = await db
      .select()
      .from(externalConnection)
      .where(and(eq(externalConnection.id, syncConfig.connectionId), eq(externalConnection.orgId, orgId)))
      .limit(1);

    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }

    const branch = body.branch || syncConfig.defaultBranch || repoRecord.defaultBranch;
    const storage = new GitR2Storage(c.env.REPOS_BUCKET, orgId, slug);
    const token = await decryptSecret(c.env.SYNC_ENCRYPTION_KEY, connection.encryptedAccessToken);
    const author: CommitAuthor = { name: "CoreGit Sync", email: "sync@coregit.dev" };

    runId = nanoid();
    await db.insert(repoSyncRun).values({
      id: runId,
      syncId: syncConfig.id,
      status: "running",
      startedAt: new Date(),
      message: `Sync started for ${syncConfig.provider}`,
    });

    let result;
    if (syncConfig.provider === "github") {
      const { owner, repo: ghRepo } = parseGithubRemote(syncConfig.remote);
      result = await syncFromGithub({
        token,
        owner,
        repo: ghRepo,
        branch,
        storage,
        author,
        lastSyncedSha: syncConfig.lastSyncedSha ?? null,
      });
    } else if (syncConfig.provider === "gitlab") {
      result = await syncFromGitlab({
        token,
        projectPath: syncConfig.remote,
        branch,
        storage,
        author,
        lastSyncedSha: syncConfig.lastSyncedSha ?? null,
      });
    } else {
      throw new Error(`Unsupported provider ${syncConfig.provider}`);
    }

    await db
      .update(repoSync)
      .set({
        lastSyncedSha: result.remoteSha,
        lastSyncedAt: new Date(),
        lastError: null,
        defaultBranch: branch,
        updatedAt: new Date(),
      })
      .where(eq(repoSync.id, syncConfig.id));

    await db
      .update(repoSyncRun)
      .set({
        status: result.skipped ? "skipped" : "success",
        commitSha: result.commitSha || null,
        remoteSha: result.remoteSha,
        completedAt: new Date(),
        message: result.skipped ? "Already up to date" : `Applied ${result.filesChanged} files`,
      })
      .where(eq(repoSyncRun.id, runId));

    return c.json({
      synced: !result.skipped,
      remote_sha: result.remoteSha,
      commit_sha: result.commitSha,
      files_changed: result.filesChanged,
      deleted: result.deleted,
    });
  } catch (error) {
    console.error("Sync failed", error);
    if (runId) {
      await db
        .update(repoSyncRun)
        .set({ status: "error", completedAt: new Date(), message: error instanceof Error ? error.message : "Sync failed" })
        .where(eq(repoSyncRun.id, runId));
    }
    return c.json({ error: error instanceof Error ? error.message : "Sync failed" }, 500);
  }
});

export { syncRoutes as sync };







