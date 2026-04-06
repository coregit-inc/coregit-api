import type { Database } from "../db";

export interface Env {
  DATABASE_URL: string;
  CORS_ORIGIN: string;
  ENVIRONMENT?: string;
  REPOS_BUCKET: R2Bucket;
  LFS_BUCKET: R2Bucket;
  DODO_PAYMENTS_API_KEY: string;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  SYNC_ENCRYPTION_KEY: string;
  WEBHOOK_ENCRYPTION_KEY?: string;
  INTERNAL_SYNC_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  // Semantic search
  PINECONE_API_KEY?: string;
  VOYAGE_API_KEY?: string;
  PINECONE_INDEX_HOST?: string;
  INDEXING_QUEUE?: Queue;
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

