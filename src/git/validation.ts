/**
 * Shared input validators for git operations.
 * Used across routes and storage to prevent path traversal,
 * ref injection, and malformed SHA attacks.
 */

const SHA_RE = /^[0-9a-f]{40}$/;

/** Validate a 40-char lowercase hex SHA. */
export function isValidSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

/** Validate a git ref name per git-check-ref-format rules. */
export function isValidRefName(name: string): boolean {
  if (!name || name.length > 256) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name.includes("\\") || name.includes(" ") || name.includes("~") || name.includes("^") || name.includes(":") || name.includes("?") || name.includes("*") || name.includes("[")) return false;
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

/**
 * Validate a full ref path from git push (e.g. refs/heads/main).
 * Must start with refs/heads/ or refs/tags/ and have a valid name after.
 */
export function isValidRefPath(ref: string): boolean {
  if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) return false;
  const segments = ref.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.startsWith(".") || seg.endsWith(".lock")) return false;
  }
  if (ref.includes("..") || ref.includes("@{")) return false;
  if (/[\x00-\x1f\x7f\\~^:?*\[\s]/.test(ref)) return false;
  return true;
}

/** Validate a file path — returns error string or null if valid. */
export function validateFilePath(path: string): string | null {
  if (!path || typeof path !== "string") return "File path is required";
  if (path.includes("\0")) return `File path contains null byte: ${path}`;
  if (path.startsWith("/")) return `File path must be relative: ${path}`;
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "") return `File path has empty segment: ${path}`;
    if (seg === "." || seg === "..") return `File path contains traversal: ${path}`;
  }
  if (path.length > 4096) return `File path exceeds 4096 char limit: ${path.slice(0, 100)}...`;
  return null;
}
