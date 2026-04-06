import { pgTable, text, timestamp, index, uniqueIndex, jsonb, bigint, boolean } from "drizzle-orm/pg-core";

// ============================================================
// Better Auth managed table (read-only reference for queries)
// ============================================================

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ============================================================
// CoreGit application tables
// ============================================================

// Repositories
export const repo = pgTable(
  "repo",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),           // references Better Auth organization.id
    namespace: text("namespace"),               // optional user namespace (e.g. "alice")
    slug: text("slug").notNull(),
    description: text("description"),
    defaultBranch: text("default_branch").notNull().default("main"),
    visibility: text("visibility").notNull().default("private"), // "public" | "private"
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("repo_org_idx").on(table.orgId),
    index("repo_namespace_idx").on(table.orgId, table.namespace),
    // Uniqueness enforced via partial indexes in migration SQL:
    //   (org_id, slug) WHERE namespace IS NULL
    //   (org_id, namespace, slug) WHERE namespace IS NOT NULL
  ]
);

export type Repo = typeof repo.$inferSelect;
export type NewRepo = typeof repo.$inferInsert;

// Snapshots (named restore points)
export const snapshot = pgTable(
  "snapshot",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    branch: text("branch").notNull(),
    commitSha: text("commit_sha").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("snapshot_repo_idx").on(table.repoId),
    uniqueIndex("snapshot_repo_name_idx").on(table.repoId, table.name),
  ]
);

export type Snapshot = typeof snapshot.$inferSelect;
export type NewSnapshot = typeof snapshot.$inferInsert;

// Usage events (for billing)
export const usageEvent = pgTable(
  "usage_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull(),
    eventType: text("event_type").notNull(),     // 'api_call' | 'storage_bytes' | 'git_transfer_bytes' | 'repo_created'
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    metadata: jsonb("metadata"),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  },
  (table) => [
    index("usage_event_org_idx").on(table.orgId, table.recordedAt),
  ]
);

export type UsageEvent = typeof usageEvent.$inferSelect;
export type NewUsageEvent = typeof usageEvent.$inferInsert;

// Webhooks (phase 2)
export const webhook = pgTable(
  "webhook",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: text("events").array().notNull(),    // ['push', 'repo.created', 'repo.deleted']
    active: text("active").notNull().default("true"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("webhook_org_idx").on(table.orgId),
  ]
);

export type Webhook = typeof webhook.$inferSelect;
export type NewWebhook = typeof webhook.$inferInsert;

// Scoped tokens (short-lived, repo-scoped credentials for end-users)
export const scopedToken = pgTable(
  "scoped_token",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    createdBy: text("created_by").notNull(),       // api_key id that minted this token
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),        // first 12 chars for display
    keyHash: text("key_hash").notNull().unique(),   // SHA-256
    scopes: jsonb("scopes").notNull(),              // {"repos:slug": ["read"]}
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    lastUsed: timestamp("last_used"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("scoped_token_org_idx").on(table.orgId),
    // key_hash already has a unique index from the .unique() constraint
  ]
);

export type ScopedToken = typeof scopedToken.$inferSelect;
export type NewScopedToken = typeof scopedToken.$inferInsert;

// ── Custom Domain ──

export const customDomain = pgTable(
  "custom_domain",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    domain: text("domain").notNull().unique(),
    cfHostnameId: text("cf_hostname_id"),
    status: text("status").notNull().default("pending"),
    sslStatus: text("ssl_status").default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("custom_domain_org_idx").on(table.orgId),
  ]
);

// External provider connections (GitHub/GitLab)
export const externalConnection = pgTable(
  "external_connection",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    externalUsername: text("external_username"),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    metadata: jsonb("metadata"),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("external_connection_org_idx").on(table.orgId),
    index("external_connection_provider_idx").on(table.provider, table.orgId),
  ]
);

export type ExternalConnection = typeof externalConnection.$inferSelect;
export type NewExternalConnection = typeof externalConnection.$inferInsert;

// Repository sync configuration
export const repoSync = pgTable(
  "repo_sync",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => externalConnection.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    remote: text("remote").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    direction: text("direction").notNull().default("import"),
    autoSync: boolean("auto_sync").default(false),
    lastSyncedSha: text("last_synced_sha"),
    lastSyncedAt: timestamp("last_synced_at"),
    lastError: text("last_error"),
    externalWebhookId: text("external_webhook_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("repo_sync_org_idx").on(table.orgId),
    uniqueIndex("repo_sync_repo_idx").on(table.repoId),
  ]
);

export type RepoSync = typeof repoSync.$inferSelect;
export type NewRepoSync = typeof repoSync.$inferInsert;

// Sync run history
export const repoSyncRun = pgTable(
  "repo_sync_run",
  {
    id: text("id").primaryKey(),
    syncId: text("sync_id")
      .notNull()
      .references(() => repoSync.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    message: text("message"),
    remoteSha: text("remote_sha"),
    commitSha: text("commit_sha"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("repo_sync_run_sync_idx").on(table.syncId),
  ]
);

export type RepoSyncRun = typeof repoSyncRun.$inferSelect;
export type NewRepoSyncRun = typeof repoSyncRun.$inferInsert;

// Audit log (security events)
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),      // 'master_key' | 'scoped_token' | 'internal'
    action: text("action").notNull(),              // 'repo.create' | 'repo.delete' | 'token.create' | etc.
    resourceType: text("resource_type").notNull(), // 'repo' | 'token' | 'webhook' | 'branch'
    resourceId: text("resource_id"),
    metadata: jsonb("metadata"),
    ipAddress: text("ip_address"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_org_idx").on(table.orgId, table.createdAt),
    index("audit_log_actor_idx").on(table.actorId),
  ]
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;

// LFS objects
export const lfsObject = pgTable(
  "lfs_object",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    oid: text("oid").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  },
  (table) => [
    index("lfs_object_repo_idx").on(table.repoId),
    index("lfs_object_org_idx").on(table.orgId),
    uniqueIndex("lfs_object_repo_oid_idx").on(table.repoId, table.oid),
  ]
);

export type LfsObject = typeof lfsObject.$inferSelect;

// LFS file locks
export const lfsLock = pgTable(
  "lfs_lock",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    ownerId: text("owner_id").notNull(),
    ownerName: text("owner_name").notNull(),
    lockedAt: timestamp("locked_at").defaultNow().notNull(),
    ref: text("ref"),
  },
  (table) => [
    index("lfs_lock_repo_idx").on(table.repoId),
    uniqueIndex("lfs_lock_repo_path_idx").on(table.repoId, table.path),
  ]
);

export type LfsLock = typeof lfsLock.$inferSelect;
