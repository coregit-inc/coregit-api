import type { Database } from "../db";

export interface Env {
  DATABASE_URL: string;
  CORS_ORIGIN: string;
  ENVIRONMENT?: string;
  REPOS_BUCKET: R2Bucket;
  DODO_PAYMENTS_API_KEY: string;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  SYNC_ENCRYPTION_KEY: string;
  WEBHOOK_ENCRYPTION_KEY?: string;
  INTERNAL_SYNC_TOKEN?: string;
}

export interface Variables {
  db: Database;
  orgId: string;
  apiKeyPermissions: Record<string, string[]> | null;
  apiKeyId: string;
  orgTier: "free" | "usage";
  dodoCustomerId: string | null;
  customDomain: string | null;
  requestId: string;
}

