/**
 * Better Auth instance factory for Cloudflare Workers.
 *
 * Must be created per-request because Workers have no module-scope env access.
 * Plugins: Organization (multi-tenant) + API Key (programmatic access).
 */

import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { Env } from "../types";

export function createAuth(env: Env) {
  const sql = neon(env.DATABASE_URL);
  const db = drizzle(sql);

  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    baseURL: "https://api.coregit.dev",
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: true },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
    trustedOrigins: [
      "https://app.coregit.dev",
      "http://localhost:3000",
    ],
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: ".coregit.dev",
      },
      cookiePrefix: "coregit",
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24,      // refresh after 1 day
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: "owner",
      }),
      apiKey({
        defaultPrefix: "cgk",
        enableMetadata: true,
        rateLimit: {
          enabled: true,
          maxRequests: 1000,
          timeWindow: 60_000, // 1 minute
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
