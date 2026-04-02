/**
 * Shared route helpers.
 */

/**
 * Extract repo params from a Hono context.
 *
 * Works with both route patterns:
 *   /:slug/...           → { slug, namespace: null }
 *   /:namespace/:slug/...  → { slug, namespace }
 *
 * For routes that use :a/:b pattern (dual registration):
 *   /:a/...              → { slug: a, namespace: null }
 *   /:a/:b/...           → { slug: b, namespace: a }
 */
export function extractRepoParams(c: any): { slug: string; namespace: string | null } {
  // Try explicit :namespace and :slug first (namespaced route pattern)
  const namespace = c.req.param("namespace");
  const slug = c.req.param("slug");

  if (namespace && slug) {
    return { slug, namespace };
  }

  // Fallback: only :slug matched (non-namespaced pattern)
  if (slug) {
    return { slug, namespace: null };
  }

  // Should not happen if routes are set up correctly
  return { slug: namespace || "", namespace: null };
}

const NAMESPACE_REGEX = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a namespace string.
 */
export function validateNamespace(ns: string): boolean {
  return NAMESPACE_REGEX.test(ns) && !ns.includes("--");
}
