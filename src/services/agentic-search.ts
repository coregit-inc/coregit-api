/**
 * Agentic code search driven by Morph WarpGrep.
 *
 * Materializes a commit-scoped workspace (reusing GitR2FileSystem + just-bash,
 * the same infra as /exec), then drives a multi-turn loop: Morph returns
 * tool_calls → we translate to shell commands → bash.exec() → results go back
 * to Morph until it calls `finish`.
 *
 * Emits structured events via callback for both streaming (SSE) and buffered
 * (JSON) response modes.
 */

import { Bash } from "just-bash/browser";
import { GitR2Storage } from "../git/storage";
import { GitR2FileSystem } from "./../workspace/filesystem";
import { parseGitObject, parseCommit } from "../git/objects";
import {
  morphWarpGrep,
  MorphError,
  type WarpGrepMessage,
  type WarpGrepToolCall,
} from "./morph";

// ============ Constants ============

const DEFAULT_MAX_TURNS = 6;
const HARD_CAP_TURNS = 10;
const DEFAULT_STRUCTURE_DEPTH = 2;
const HARD_CAP_DEPTH = 4;
const MAX_STRUCTURE_ENTRIES = 500;
const TOOL_RESULT_MAX_BYTES = 8 * 1024; // 8 KB per tool result (for Morph + SSE)
const PER_TURN_BASH_TIMEOUT_MS = 10_000;
const PER_TURN_MORPH_TIMEOUT_MS = 15_000;

const EXECUTION_LIMITS = {
  maxCommandCount: 5000,
  maxLoopIterations: 5000,
  maxCallDepth: 50,
  maxAwkIterations: 5000,
  maxSedIterations: 5000,
};

// ============ Types ============

export interface AgenticSearchOptions {
  storage: GitR2Storage;
  ref: string | undefined; // default: "main"
  query: string;
  morphApiKey: string;
  maxTurns?: number;
  structureDepth?: number;
}

export type AgenticSearchEvent =
  | { type: "start"; ref: string; commit_sha: string; workspace_ms: number }
  | { type: "turn_start"; turn: number }
  | {
      type: "tool_call";
      turn: number;
      call_id: string;
      tool: string;
      args: unknown;
    }
  | {
      type: "tool_result";
      turn: number;
      call_id: string;
      content: string;
      truncated: boolean;
    }
  | {
      type: "turn_end";
      turn: number;
      prompt_tokens: number;
      completion_tokens: number;
    }
  | {
      type: "finish";
      answer: string;
      locations: FinishLocation[];
      total_turns: number;
      total_tokens: number;
    }
  | { type: "error"; code: string; message: string; turn?: number };

export interface FinishLocation {
  path: string;
  start_line: number;
  end_line: number;
}

export interface AgenticSearchSummary {
  answer: string;
  locations: FinishLocation[];
  total_turns: number;
  total_tokens: number;
  ref: string;
  commit_sha: string;
}

// ============ Main Runner ============

export async function runAgenticSearch(
  opts: AgenticSearchOptions,
  onEvent: (e: AgenticSearchEvent) => void
): Promise<AgenticSearchSummary> {
  const t0 = Date.now();
  const maxTurns = Math.min(opts.maxTurns ?? DEFAULT_MAX_TURNS, HARD_CAP_TURNS);
  const depth = Math.min(
    opts.structureDepth ?? DEFAULT_STRUCTURE_DEPTH,
    HARD_CAP_DEPTH
  );

  // 1. Resolve ref → commit
  const targetRef = opts.ref || "main";
  const commitSha = await resolveRefToCommit(opts.storage, targetRef);
  if (!commitSha) {
    throw new AgenticSearchError("ref_not_found", `ref '${targetRef}' not found`);
  }

  // 2. Parse commit → tree SHA
  const commitRaw = await opts.storage.getObject(commitSha);
  if (!commitRaw) {
    throw new AgenticSearchError("commit_not_found", `commit ${commitSha} not found`);
  }
  const commitObj = parseGitObject(commitRaw);
  if (commitObj.type !== "commit") {
    throw new AgenticSearchError(
      "invalid_ref",
      `ref '${targetRef}' does not point to a commit`
    );
  }
  const { tree: treeSha } = parseCommit(commitObj.content);

  // 3. Materialize filesystem (same infra as /exec)
  const fs = new GitR2FileSystem(opts.storage, treeSha);
  await fs.preload();

  const workspaceMs = Date.now() - t0;
  onEvent({
    type: "start",
    ref: targetRef,
    commit_sha: commitSha,
    workspace_ms: workspaceMs,
  });

  // 4. Build <repo_structure>
  const repoRoot = "/";
  const allPaths = fs.getAllPaths();
  const structure = buildRepoStructure(allPaths, depth, repoRoot);

  // 5. Create persistent Bash instance (reused across all turns)
  const bash = new Bash({
    fs,
    cwd: "/",
    env: {
      HOME: "/",
      USER: "workspace",
      PATH: "/bin:/usr/bin",
      TERM: "dumb",
    },
    executionLimits: EXECUTION_LIMITS,
  });

  // 6. Seed conversation
  const history: WarpGrepMessage[] = [
    {
      role: "user",
      content: `<repo_structure>\n${structure}\n</repo_structure>\n\n<search_string>\n${opts.query}\n</search_string>`,
    },
  ];

  let totalCompletionTokens = 0;
  let finishPayload: { answer: string; locations: FinishLocation[] } | null = null;

  // 7. Turn loop
  for (let turn = 1; turn <= maxTurns; turn++) {
    onEvent({ type: "turn_start", turn });

    let response;
    try {
      response = await morphWarpGrep(
        opts.morphApiKey,
        history,
        PER_TURN_MORPH_TIMEOUT_MS
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof MorphError ? "morph_error" : "unknown_error";
      onEvent({ type: "error", code, message: msg, turn });
      throw new AgenticSearchError(code, msg);
    }

    totalCompletionTokens += response.usage.completion_tokens;
    onEvent({
      type: "turn_end",
      turn,
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens,
    });

    // Append assistant message to history
    history.push({
      role: "assistant",
      content: response.message.content ?? "",
      tool_calls: response.message.tool_calls,
    });

    const toolCalls = response.message.tool_calls ?? [];

    // No tool calls → model finished silently. Synthesize finish.
    if (toolCalls.length === 0) {
      finishPayload = {
        answer: response.message.content || "",
        locations: [],
      };
      break;
    }

    // Process each tool call
    let sawFinish = false;
    for (const call of toolCalls) {
      const parsed = parseToolCall(call);
      onEvent({
        type: "tool_call",
        turn,
        call_id: call.id,
        tool: parsed.name,
        args: parsed.args,
      });

      if (parsed.name === "finish") {
        finishPayload = extractFinishPayload(parsed.args);
        sawFinish = true;
        break;
      }

      // Translate to bash + execute
      const command = toolCallToCommand(parsed);
      let rawOutput: string;
      if (command === null) {
        rawOutput = `error: unsupported or rejected tool: ${parsed.name}`;
      } else {
        rawOutput = await runBashWithTimeout(
          bash,
          command,
          PER_TURN_BASH_TIMEOUT_MS
        );
      }

      const truncated = rawOutput.length > TOOL_RESULT_MAX_BYTES;
      const content = truncated
        ? rawOutput.slice(0, TOOL_RESULT_MAX_BYTES) + "\n... (truncated)"
        : rawOutput;

      onEvent({
        type: "tool_result",
        turn,
        call_id: call.id,
        content,
        truncated,
      });

      // Feed back to the model for next turn
      history.push({
        role: "tool",
        tool_call_id: call.id,
        content,
      });
    }

    if (sawFinish) break;
  }

  // Fallback: model ran out of turns without calling finish
  if (!finishPayload) {
    finishPayload = {
      answer:
        "Search ended without a final answer (max turns reached). See tool_results above for partial findings.",
      locations: [],
    };
  }

  const summary: AgenticSearchSummary = {
    answer: finishPayload.answer,
    locations: finishPayload.locations,
    total_turns: Math.min(
      history.filter((m) => m.role === "assistant").length,
      maxTurns
    ),
    total_tokens: totalCompletionTokens,
    ref: targetRef,
    commit_sha: commitSha,
  };

  onEvent({
    type: "finish",
    answer: summary.answer,
    locations: summary.locations,
    total_turns: summary.total_turns,
    total_tokens: summary.total_tokens,
  });

  return summary;
}

// ============ Error ============

export class AgenticSearchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgenticSearchError";
  }
}

// ============ Helpers ============

async function resolveRefToCommit(
  storage: GitR2Storage,
  ref: string
): Promise<string | null> {
  if (ref === "HEAD") return storage.resolveHead();
  const [branchSha, tagSha] = await Promise.all([
    storage.getRef(`refs/heads/${ref}`),
    storage.getRef(`refs/tags/${ref}`),
  ]);
  if (branchSha) return branchSha;
  if (tagSha) return tagSha;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const exists = await storage.hasObject(ref);
    if (exists) return ref;
  }
  return null;
}

/**
 * Build a flat absolute-path listing for the WarpGrep <repo_structure> block.
 * Includes the repo root first, then files/dirs up to `depth` levels.
 */
function buildRepoStructure(
  paths: string[],
  depth: number,
  repoRoot: string
): string {
  const lines: string[] = [repoRoot.replace(/\/$/, "")];
  const dirs = new Set<string>();

  for (const p of paths) {
    const segs = p.split("/");
    if (segs.length > depth) continue;
    // Collect intermediate dirs too
    let acc = "";
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i];
      if (acc.split("/").length <= depth) {
        dirs.add(acc);
      }
    }
  }

  const dirList = [...dirs].sort();
  const fileList = paths.filter((p) => p.split("/").length <= depth).sort();

  for (const d of dirList) {
    lines.push(`${repoRoot.replace(/\/$/, "")}/${d}`);
  }
  for (const f of fileList) {
    lines.push(`${repoRoot.replace(/\/$/, "")}/${f}`);
  }

  if (lines.length > MAX_STRUCTURE_ENTRIES) {
    return (
      lines.slice(0, MAX_STRUCTURE_ENTRIES).join("\n") +
      `\n... (${lines.length - MAX_STRUCTURE_ENTRIES} more entries omitted)`
    );
  }
  return lines.join("\n");
}

interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

function parseToolCall(call: WarpGrepToolCall): ParsedToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  return { name: call.function.name, args };
}

interface FinishArgs {
  answer?: string;
  locations?: Array<Record<string, unknown>>;
}

function extractFinishPayload(args: Record<string, unknown>): {
  answer: string;
  locations: FinishLocation[];
} {
  const f = args as FinishArgs;
  const locations: FinishLocation[] = [];
  if (Array.isArray(f.locations)) {
    for (const loc of f.locations) {
      const path = String((loc as Record<string, unknown>).path ?? "");
      const start = Number(
        (loc as Record<string, unknown>).start_line ??
          (loc as Record<string, unknown>).start ??
          0
      );
      const end = Number(
        (loc as Record<string, unknown>).end_line ??
          (loc as Record<string, unknown>).end ??
          start
      );
      if (path) {
        locations.push({
          path,
          start_line: isFinite(start) ? start : 0,
          end_line: isFinite(end) ? end : 0,
        });
      }
    }
  }
  return {
    answer: typeof f.answer === "string" ? f.answer : "",
    locations,
  };
}

/**
 * Translate a WarpGrep tool call to a bash command. Returns null if the tool
 * should not be executed (e.g. unsupported or contains injection attempt).
 */
function toolCallToCommand(call: ParsedToolCall): string | null {
  const { name, args } = call;

  switch (name) {
    case "grep_search": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern || hasShellInjection(pattern)) return null;
      const include =
        typeof args.include_pattern === "string" ? args.include_pattern : null;
      const caseInsensitive = args.case_sensitive === false;
      const flags = `-rnE${caseInsensitive ? "i" : ""}`;
      const inc = include && !hasShellInjection(include)
        ? ` --include=${bashQuote(include)}`
        : "";
      const pathArg = typeof args.path === "string" ? args.path : ".";
      if (hasShellInjection(pathArg)) return null;
      const ctxRaw = args.output_context_lines ?? args.context_lines;
      const ctx = typeof ctxRaw === "number"
        ? ctxRaw
        : typeof ctxRaw === "string" && /^\d{1,2}$/.test(ctxRaw)
        ? parseInt(ctxRaw, 10)
        : 0;
      const ctxFlag = ctx > 0 && ctx <= 10 ? ` -C ${ctx}` : "";
      return `grep ${flags}${inc}${ctxFlag} -- ${bashQuote(pattern)} ${bashQuote(pathArg)}`;
    }
    case "read": {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path || hasShellInjection(path)) return null;
      const start = typeof args.start_line === "number" ? args.start_line : null;
      const end = typeof args.end_line === "number" ? args.end_line : null;
      if (start !== null && end !== null) {
        return `sed -n ${start},${end}p ${bashQuote(path)}`;
      }
      if (start !== null) {
        return `sed -n ${start},$p ${bashQuote(path)}`;
      }
      return `cat ${bashQuote(path)}`;
    }
    case "list_directory": {
      // Morph abuses this field to send arbitrary read-only shell commands
      // (find / ls / tree). Accept anything in our whitelist.
      const cmdArg = typeof args.command === "string" ? args.command : null;
      if (cmdArg) {
        if (hasShellInjection(cmdArg)) return null;
        const head = cmdArg.trim().split(/\s+/)[0];
        if (!["ls", "find", "tree"].includes(head)) return null;
        return cmdArg;
      }
      const path = typeof args.path === "string" ? args.path : ".";
      if (hasShellInjection(path)) return null;
      return `ls -la ${bashQuote(path)}`;
    }
    case "glob": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern || hasShellInjection(pattern)) return null;
      return `find . -name ${bashQuote(pattern)} -type f`;
    }
    default:
      return null;
  }
}

function hasShellInjection(s: string): boolean {
  // Reject obvious command substitution / chaining attempts.
  return /\$\(|`|;\s*\S|&&|\|\||>\s*\S|<\s*\S/.test(s);
}

function bashQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function runBashWithTimeout(
  bash: Bash,
  command: string,
  timeoutMs: number
): Promise<string> {
  const timer = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (_, reject) =>
      setTimeout(() => reject(new Error("bash timeout")), timeoutMs)
  );
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await Promise.race([bash.exec(command), timer]);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  const out = result.stdout || "";
  const err = result.stderr || "";
  if (result.exitCode !== 0) {
    return out
      ? `${out}\n[exit ${result.exitCode}] ${err}`.trim()
      : `[exit ${result.exitCode}] ${err || "(no output)"}`.trim();
  }
  return out.trim() || "(empty)";
}
