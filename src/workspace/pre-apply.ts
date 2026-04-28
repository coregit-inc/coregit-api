/**
 * Pre-apply file changes to a virtual filesystem before bash exec.
 *
 * Used by /v1/repos/:slug/exec and /v1/workspace/exec when the SDK has buffered
 * writes locally (commitMode: "manual" / "on-exec") and flushes them with the
 * next exec call. Applied to the in-memory overlay only — they end up in the
 * commit if the same request also sets commit:true.
 *
 * Supported actions: "create" (full overwrite), "delete", "rename".
 * Surgical edits ("edit", "lazy_edit") are intentionally rejected — they need
 * server-side merge logic that lives in commit-builder.ts; clients should call
 * POST /v1/repos/:slug/commits for those.
 */

import type { IFileSystem } from "just-bash/browser";

export type PreApplyAction = "create" | "delete" | "rename";

export interface PreApplyChange {
  path: string;
  action?: PreApplyAction;
  content?: string;
  encoding?: "utf-8" | "base64";
  new_path?: string;
}

const MAX_PRE_APPLY_CHANGES = 1000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export class PreApplyError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "PreApplyError";
  }
}

export function validatePreApplyChanges(
  raw: unknown,
): asserts raw is PreApplyChange[] {
  if (!Array.isArray(raw)) {
    throw new PreApplyError("pre_apply_changes must be an array");
  }
  if (raw.length > MAX_PRE_APPLY_CHANGES) {
    throw new PreApplyError(
      `pre_apply_changes exceeds max ${MAX_PRE_APPLY_CHANGES} entries`,
    );
  }
  for (const ch of raw) {
    if (!ch || typeof ch !== "object") {
      throw new PreApplyError("each change must be an object");
    }
    const c = ch as Partial<PreApplyChange> & { action?: string };
    if (typeof c.path !== "string" || c.path.length === 0) {
      throw new PreApplyError("change.path must be a non-empty string");
    }
    if (c.path.includes("\0")) {
      throw new PreApplyError("change.path contains null byte", c.path);
    }
    const action: string = c.action ?? "create";
    if (action !== "create" && action !== "delete" && action !== "rename") {
      throw new PreApplyError(
        `change.action must be "create", "delete", or "rename" (got "${action}"). Use POST /commits for surgical edits.`,
        c.path,
      );
    }
    if (action === "create") {
      if (typeof c.content !== "string") {
        throw new PreApplyError(
          `change.content must be a string for action "create"`,
          c.path,
        );
      }
      if (c.content.length > MAX_FILE_SIZE) {
        throw new PreApplyError(
          `change.content exceeds 10 MB`,
          c.path,
        );
      }
      if (
        c.encoding !== undefined &&
        c.encoding !== "utf-8" &&
        c.encoding !== "base64"
      ) {
        throw new PreApplyError(
          `change.encoding must be "utf-8" or "base64"`,
          c.path,
        );
      }
      if (c.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(c.content)) {
        throw new PreApplyError(`change.content is not valid base64`, c.path);
      }
    }
    if (action === "rename") {
      if (typeof c.new_path !== "string" || c.new_path.length === 0) {
        throw new PreApplyError(
          `change.new_path required for action "rename"`,
          c.path,
        );
      }
      if (c.new_path.includes("\0")) {
        throw new PreApplyError(`change.new_path contains null byte`, c.path);
      }
    }
  }
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function applyPreApplyChanges(
  fs: IFileSystem,
  changes: PreApplyChange[],
): Promise<void> {
  for (const ch of changes) {
    const action = ch.action ?? "create";
    if (action === "create") {
      const content =
        ch.encoding === "base64" && ch.content !== undefined
          ? decodeBase64(ch.content)
          : (ch.content ?? "");
      await fs.writeFile(ch.path, content);
    } else if (action === "delete") {
      try {
        await fs.rm(ch.path, { recursive: true, force: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("ENOENT")) throw err;
      }
    } else if (action === "rename") {
      await fs.mv(ch.path, ch.new_path!);
    }
  }
}
