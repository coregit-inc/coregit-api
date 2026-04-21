/**
 * Cloudflare API client for Custom Hostnames (Cloudflare for SaaS).
 *
 * Used by the custom-domains flow: coregit-app's Next.js routes call
 * `/v1/domains/*` on this Worker (via INTERNAL_SYNC_TOKEN), which in turn
 * talks to the Cloudflare API. Keeps the CF API token in Worker secrets,
 * out of Vercel.
 */

import type { Env } from "../types";

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CFHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status: string };
  ownership_verification?: { type: string; name: string; value: string };
}

function getConfig(env: Env): { zoneId: string; token: string } {
  const zoneId = env.CF_ZONE_ID;
  const token = env.CF_API_TOKEN;
  if (!zoneId || !token) {
    throw new Error("CF_ZONE_ID and CF_API_TOKEN must be set");
  }
  return { zoneId, token };
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function createCustomHostname(env: Env, domain: string): Promise<CFHostname> {
  const { zoneId, token } = getConfig(env);
  const res = await fetch(`${CF_API}/zones/${zoneId}/custom_hostnames`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      hostname: domain,
      ssl: {
        method: "http",
        type: "dv",
        settings: { min_tls_version: "1.2", tls_1_3: "on" },
      },
    }),
  });
  const data = (await res.json()) as {
    success: boolean;
    errors?: Array<{ message?: string }>;
    result?: CFHostname;
  };
  if (!data.success || !data.result) {
    throw new Error(data.errors?.[0]?.message || "Failed to create custom hostname");
  }
  return data.result;
}

export async function getCustomHostname(env: Env, cfHostnameId: string): Promise<CFHostname> {
  const { zoneId, token } = getConfig(env);
  const res = await fetch(`${CF_API}/zones/${zoneId}/custom_hostnames/${cfHostnameId}`, {
    headers: headers(token),
  });
  const data = (await res.json()) as {
    success: boolean;
    errors?: Array<{ message?: string }>;
    result?: CFHostname;
  };
  if (!data.success || !data.result) {
    throw new Error(data.errors?.[0]?.message || "Failed to get custom hostname");
  }
  return data.result;
}

export async function deleteCustomHostname(env: Env, cfHostnameId: string): Promise<void> {
  const { zoneId, token } = getConfig(env);
  const res = await fetch(`${CF_API}/zones/${zoneId}/custom_hostnames/${cfHostnameId}`, {
    method: "DELETE",
    headers: headers(token),
  });
  const data = (await res.json()) as {
    success: boolean;
    errors?: Array<{ message?: string }>;
  };
  if (!data.success) {
    throw new Error(data.errors?.[0]?.message || "Failed to delete custom hostname");
  }
}
