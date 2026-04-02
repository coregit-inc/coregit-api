/**
 * Scope checking helpers for scoped tokens.
 *
 * Scope format: Record<string, string[]> | null
 *   null                                → master API key, full access
 *   {"repos:*": ["read","write"]}       → all repos, read+write
 *   {"repos:my-app": ["read"]}          → only my-app (no namespace), read-only
 *   {"repos:alice/my-app": ["read"]}    → only alice/my-app (namespaced), read-only
 *
 * The key after "repos:" is the scopeKey: "namespace/slug" or just "slug".
 */

export type Scopes = Record<string, string[]> | null;

/**
 * Check if scopes grant access to a repo for a given action.
 * Returns true for master keys (scopes === null).
 *
 * @param scopeKey — "alice/my-app" (namespaced) or "my-app" (non-namespaced)
 */
export function hasRepoAccess(
  scopes: Scopes,
  scopeKey: string,
  action: "read" | "write"
): boolean {
  if (scopes === null) return true;
  const specific = scopes[`repos:${scopeKey}`];
  const wildcard = scopes["repos:*"];
  const allowed = specific || wildcard;
  if (!allowed) return false;
  return allowed.includes(action);
}

/**
 * Check if credential is a master key (unrestricted).
 */
export function isMasterKey(scopes: Scopes): boolean {
  return scopes === null;
}

/**
 * Get list of repo scope keys this token has access to.
 * Returns null for master keys (= all repos) or wildcard.
 * Keys are "namespace/slug" or "slug".
 */
export function getAccessibleRepoKeys(scopes: Scopes): string[] | null {
  if (scopes === null) return null;
  if (scopes["repos:*"]) return null;
  const keys: string[] = [];
  for (const key of Object.keys(scopes)) {
    if (key.startsWith("repos:")) {
      keys.push(key.slice(6));
    }
  }
  return keys;
}

/**
 * Normalize scopes: ensure write always includes read.
 */
export function normalizeScopes(scopes: Record<string, string[]>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, actions] of Object.entries(scopes)) {
    const set = new Set(actions);
    if (set.has("write")) set.add("read");
    normalized[key] = [...set];
  }
  return normalized;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate scopes structure.
 * Returns error message or null if valid.
 */
export function validateScopes(scopes: unknown): string | null {
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
    return "scopes must be an object";
  }
  const entries = Object.entries(scopes as Record<string, unknown>);
  if (entries.length === 0) {
    return "scopes must have at least one entry";
  }
  const validActions = new Set(["read", "write"]);
  for (const [key, value] of entries) {
    if (!key.startsWith("repos:")) {
      return `Invalid scope key "${key}": must start with "repos:"`;
    }
    const identifier = key.slice(6);
    if (!identifier || identifier.length === 0) {
      return `Invalid scope key "${key}": missing repo identifier`;
    }
    // Validate identifier: "slug", "namespace/slug", or "*"
    if (identifier !== "*") {
      const parts = identifier.split("/");
      if (parts.length > 2) {
        return `Invalid scope key "${key}": too many segments (use "repos:slug" or "repos:namespace/slug")`;
      }
      for (const part of parts) {
        if (!SLUG_REGEX.test(part) || part.includes("--")) {
          return `Invalid scope key "${key}": "${part}" is not a valid slug`;
        }
      }
    }
    if (!Array.isArray(value) || value.length === 0) {
      return `Scope "${key}" must be a non-empty array of actions`;
    }
    for (const action of value) {
      if (!validActions.has(action)) {
        return `Invalid action "${action}" in scope "${key}": must be "read" or "write"`;
      }
    }
  }
  return null;
}
