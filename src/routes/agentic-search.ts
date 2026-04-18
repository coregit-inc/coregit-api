/**
 * Agentic code search endpoint.
 *
 * POST /v1/repos/:slug/agentic-search
 *   { q, ref?, max_turns?, structure_depth?, stream? }
 *
 * - stream: false (default) → application/json with final finish payload
 * - stream: true             → text/event-stream with per-turn events
 *
 * Paid-tier only. Billed per Morph WarpGrep completion token (×2.5 markup via
 * Dodo meter `coregit.v2.agentic_search_tokens`).
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../auth/middleware";
import { hasRepoAccess } from "../auth/scopes";
import { resolveRepo } from "../services/repo-resolver";
import { extractRepoParams } from "./helpers";
import {
  runAgenticSearch,
  AgenticSearchError,
  type AgenticSearchEvent,
} from "../services/agentic-search";
import { recordUsage } from "../services/usage";
import type { Env, Variables } from "../types";

const MAX_QUERY_LENGTH = 4000;

export const agenticSearch = new Hono<{ Bindings: Env; Variables: Variables }>();

const agenticSearchHandler = async (c: any) => {
  const orgId = c.get("orgId");
  const db = c.get("db");
  const bucket = c.env.REPOS_BUCKET;
  const { slug, namespace } = extractRepoParams(c);

  // Paid-tier gate
  if (c.get("orgTier") === "free") {
    return c.json(
      {
        error: "agentic_search requires a paid plan",
        upgrade_url: "https://app.coregit.dev/dashboard/billing",
      },
      402
    );
  }

  if (!c.env.MORPH_API_KEY) {
    return c.json(
      { error: "agentic_search is not configured on this deployment" },
      503
    );
  }

  const resolved = await resolveRepo(db, bucket, { orgId, slug, namespace });
  if (!resolved) return c.json({ error: "Repository not found" }, 404);

  if (!hasRepoAccess(c.get("apiKeyPermissions"), resolved.scopeKey, "read")) {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  // Parse + validate body
  let body: {
    q?: string;
    ref?: string;
    max_turns?: number;
    structure_depth?: number;
    stream?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.q || typeof body.q !== "string" || body.q.trim().length === 0) {
    return c.json({ error: "q (search query) is required" }, 400);
  }
  if (body.q.length > MAX_QUERY_LENGTH) {
    return c.json(
      { error: `q exceeds ${MAX_QUERY_LENGTH} characters` },
      400
    );
  }

  const ref = typeof body.ref === "string" ? body.ref : resolved.repo.defaultBranch ?? "main";
  const maxTurns = typeof body.max_turns === "number" ? body.max_turns : undefined;
  const structureDepth =
    typeof body.structure_depth === "number" ? body.structure_depth : undefined;
  const stream = body.stream === true;

  const opts = {
    storage: resolved.storage,
    ref,
    query: body.q,
    morphApiKey: c.env.MORPH_API_KEY as string,
    maxTurns,
    structureDepth,
  };

  // Billing helper — recorded once after loop with actual token total
  const bill = (totalTokens: number, commitSha: string, turns: number) => {
    if (totalTokens <= 0) return;
    recordUsage(
      c.executionCtx,
      c.env,
      db,
      orgId,
      c.get("dodoCustomerId"),
      "agentic_search_tokens",
      totalTokens,
      {
        turns,
        model: "morph-warp-grep-v2.1",
        ref,
        commit_sha: commitSha,
      }
    );
  };

  if (!stream) {
    // Buffered mode — run the loop, collect events, return final JSON.
    const events: AgenticSearchEvent[] = [];
    try {
      const summary = await runAgenticSearch(opts, (e) => events.push(e));
      bill(summary.total_tokens, summary.commit_sha, summary.total_turns);
      return c.json(summary, 200);
    } catch (err) {
      if (err instanceof AgenticSearchError) {
        const status = err.code === "ref_not_found" || err.code === "invalid_ref" ? 404
          : err.code === "morph_error" ? 502
          : 500;
        return c.json({ error: err.message, code: err.code }, status);
      }
      console.error("[agentic-search] unexpected:", err);
      return c.json({ error: "Agentic search failed" }, 500);
    }
  }

  // Streaming mode — SSE ReadableStream.
  const encoder = new TextEncoder();
  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeEvent = (e: AgenticSearchEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // controller already closed (client disconnected)
        }
      };

      try {
        const summary = await runAgenticSearch(opts, writeEvent);
        bill(summary.total_tokens, summary.commit_sha, summary.total_turns);
      } catch (err) {
        const code =
          err instanceof AgenticSearchError ? err.code : "unknown_error";
        const message = err instanceof Error ? err.message : String(err);
        writeEvent({ type: "error", code, message });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(sseStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
};

agenticSearch.post("/:slug/agentic-search", apiKeyAuth, agenticSearchHandler);
agenticSearch.post("/:namespace/:slug/agentic-search", apiKeyAuth, agenticSearchHandler);
