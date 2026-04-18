/**
 * Morph Fast Apply client — merges a lazy edit snippet into the original file.
 *
 * Used internally by commit-builder when a change has action: "lazy_edit".
 * Pure fetch() — no SDK dependency. Pattern matches voyage.ts / pinecone.ts.
 */

const MORPH_API_URL = "https://api.morphllm.com/v1/chat/completions";
const MORPH_MODEL = "morph-v3-fast";
const MORPH_WARP_GREP_MODEL = "morph-warp-grep-v2.1";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface MorphApplyArgs {
  originalCode: string;
  editSnippet: string;
  instruction?: string;
}

export interface MorphApplyResult {
  mergedCode: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class MorphError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MorphError";
  }
}

interface MorphResponse {
  choices: Array<{ message: { content: string } }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export async function morphApply(
  apiKey: string,
  args: MorphApplyArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<MorphApplyResult> {
  if (!apiKey) {
    throw new MorphError("MORPH_API_KEY not configured");
  }

  const userContent =
    `<instruction>${args.instruction ?? ""}</instruction>\n` +
    `<code>${args.originalCode}</code>\n` +
    `<update>${args.editSnippet}</update>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(MORPH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MORPH_MODEL,
        messages: [{ role: "user", content: userContent }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      throw new MorphError(`Morph request timed out after ${timeoutMs}ms`);
    }
    throw new MorphError(`Morph fetch failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text();
    throw new MorphError(`Morph ${res.status}: ${body}`, res.status);
  }

  let data: MorphResponse;
  try {
    data = (await res.json()) as MorphResponse;
  } catch (err) {
    throw new MorphError(`Morph response parse failed: ${(err as Error).message}`);
  }

  const mergedCode = data.choices?.[0]?.message?.content;
  if (typeof mergedCode !== "string" || mergedCode.length === 0) {
    throw new MorphError("Morph returned empty or malformed content");
  }

  return {
    mergedCode,
    usage: data.usage,
  };
}

// ============ WarpGrep (agentic search) ============

export type WarpGrepRole = "user" | "assistant" | "tool";

export interface WarpGrepMessage {
  role: WarpGrepRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: WarpGrepToolCall[];
}

export interface WarpGrepToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface WarpGrepAssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: WarpGrepToolCall[];
}

export interface WarpGrepResult {
  message: WarpGrepAssistantMessage;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface WarpGrepResponse {
  choices: Array<{
    message: WarpGrepAssistantMessage;
    finish_reason?: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Call Morph WarpGrep (agentic code search). Tools are built-in; do NOT pass a `tools`
 * array. The response includes `tool_calls` that the caller executes locally and
 * returns back as `{role: "tool", tool_call_id, content}` messages in the next turn.
 */
export async function morphWarpGrep(
  apiKey: string,
  messages: WarpGrepMessage[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<WarpGrepResult> {
  if (!apiKey) {
    throw new MorphError("MORPH_API_KEY not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(MORPH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MORPH_WARP_GREP_MODEL,
        messages,
        temperature: 0.0,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      throw new MorphError(`WarpGrep request timed out after ${timeoutMs}ms`);
    }
    throw new MorphError(`WarpGrep fetch failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text();
    throw new MorphError(`WarpGrep ${res.status}: ${body}`, res.status);
  }

  let data: WarpGrepResponse;
  try {
    data = (await res.json()) as WarpGrepResponse;
  } catch (err) {
    throw new MorphError(`WarpGrep response parse failed: ${(err as Error).message}`);
  }

  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new MorphError("WarpGrep returned no message");
  }

  return { message, usage: data.usage };
}
