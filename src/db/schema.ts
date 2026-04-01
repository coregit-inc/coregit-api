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
    uniqueIndex("repo_org_slug_idx").on(table.orgId, table.slug),
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
