import type { Database } from "../db";

export interface Env {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
  REPOS_BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export interface Variables {
  db: Database;
  orgId: string;
  apiKeyPermissions: Record<string, string[]> | null;
  apiKeyId: string;
}
