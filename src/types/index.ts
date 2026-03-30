import type { Database } from "../db";

export interface Env {
  DATABASE_URL: string;
  CORS_ORIGIN: string;
  REPOS_BUCKET: R2Bucket;
}

export interface Variables {
  db: Database;
  orgId: string;
  apiKeyPermissions: Record<string, string[]> | null;
  apiKeyId: string;
}
