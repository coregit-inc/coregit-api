/**
 * API Key authentication middleware.
 *
 * Two modes:
 * 1. x-api-key header — for REST API calls
 * 2. HTTP Basic Auth — for Git Smart HTTP (username=orgSlug, password=apiKey)
 */

import { createMiddleware } from "hono/factory";
import { createAuth } from "../lib/auth";
import type { Env, Variables } from "../types";

/**
 * Middleware for REST API routes.
 * Validates API key from x-api-key header.
 */
export const apiKeyAuth = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const key = c.req.header("x-api-key");
  if (!key) {
    return c.json({ error: "Missing API key. Set x-api-key header." }, 401);
  }

  const auth = createAuth(c.env);
  const result = await auth.api.verifyApiKey({
    body: { key },
  });

  if (!result.valid) {
    const code = (result.error as any)?.code;
    return c.json(
      {
        error: (result.error as any)?.message || "Invalid API key",
        code,
      },
      code === "RATE_LIMITED" ? 429 : 401
    );
  }

  const apiKeyData = result.key as any;
  c.set("orgId", apiKeyData.referenceId);
  c.set("apiKeyPermissions", apiKeyData.permissions || null);
  c.set("apiKeyId", apiKeyData.id);

  await next();
});

/**
 * Parse HTTP Basic Auth for Git Smart HTTP.
 * Returns the API key (password field) or null.
 */
export function parseBasicAuthKey(header: string | undefined): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    return decoded.slice(colonIdx + 1);
  } catch {
    return null;
  }
}

/**
 * Verify an API key and return the org ID, or null if invalid.
 */
export async function verifyApiKeyForGit(
  env: Env,
  apiKeyValue: string
): Promise<{ orgId: string } | null> {
  const auth = createAuth(env);
  const result = await auth.api.verifyApiKey({
    body: { key: apiKeyValue },
  });

  if (!result.valid) return null;

  const apiKeyData = result.key as any;
  return { orgId: apiKeyData.referenceId };
}
