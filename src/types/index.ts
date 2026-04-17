import type { Database } from "../db";

export interface Env {
  DATABASE_URL: string;
  CORS_ORIGIN: string;
  ENVIRONMENT?: string;
  REPOS_BUCKET: R2Bucket;
  LFS_BUCKET: R2Bucket;
  DODO_PAYMENTS_API_KEY: string;
  DODO_CREDIT_ENTITLEMENT_ID: string;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  SYNC_ENCRYPTION_KEY: string;
  WEBHOOK_ENCRYPTION_KEY?: string;
  INTERNAL_SYNC_TOKEN?: string;
  CRON_SECRET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  // Semantic search
  PINECONE_API_KEY?: string;
  VOYAGE_API_KEY?: string;
  PINECONE_INDEX_HOST?: string;
  INDEXING_QUEUE?: Queue;
  TREE_CACHE?: KVNamespace;
  SEARCH_CACHE?: KVNamespace;
  EMBEDDING_CACHE?: KVNamespace;
  // Auth + repo cache
  AUTH_CACHE?: KVNamespace;
  // Git object cache (immutable SHA-addressed)
  GIT_OBJ_CACHE?: KVNamespace;
  // Code graph
  GRAPH_CACHE?: KVNamespace;
  HYBRID_CACHE?: KVNamespace;
  // Rate limiting
  RATE_LIMITER: DurableObjectNamespace;
  // Sessions (Zero-Wait Protocol)
  SESSION_DO: DurableObjectNamespace;
  // Per-repo hot layer (Level 1: automatic for all)
  REPO_HOT_DO: DurableObjectNamespace;
  // Hyperdrive (Neon connection pooling)
  HYPERDRIVE: Hyperdrive;
}

export interface Variables {
  db: Database;
  orgId: string;
  apiKeyPermissions: Record<string, string[]> | null;
  apiKeyId: string;
  orgTier: "free" | "paid";
  dodoCustomerId: string | null;
  planStatus: string;
  customDomain: string | null;
  requestId: string;
  sessionId: string | null;
  sessionStub: DurableObjectStub | null;
}

