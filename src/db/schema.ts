import { pgTable, text, timestamp, index, uniqueIndex, jsonb, bigint, boolean, integer } from "drizzle-orm/pg-core";

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
    autoIndex: boolean("auto_index").default(false),
    isTemplate: boolean("is_template").default(false),
    forkedFromRepoId: text("forked_from_repo_id"),
    forkedFromOrgId: text("forked_from_org_id"),
    forkedAt: timestamp("forked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    wikiConfig: jsonb("wiki_config"),               // null = regular repo, non-null = LLM Wiki
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("repo_org_idx").on(table.orgId),
    index("repo_namespace_idx").on(table.orgId, table.namespace),
    index("repo_template_idx").on(table.orgId, table.isTemplate),
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

// Org billing plan (Dodo Credit Entitlements model).
// Balance & ledger live in Dodo; this table only holds feature gates and
// the auto-recharge mandate configuration.
export const orgPlan = pgTable(
  "org_plan",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().unique(),
    tier: text("tier").notNull().default("free"),            // 'free' | 'paid'
    dodoCustomerId: text("dodo_customer_id"),
    status: text("status").notNull().default("active"),       // 'active' | 'suspended' | 'frozen'

    // Auto-recharge: our-side config, Dodo executes via subscriptions.charge().
    autoRechargeEnabled: boolean("auto_recharge_enabled").notNull().default(false),
    autoRechargeThresholdCents: integer("auto_recharge_threshold_cents").default(1000),
    autoRechargeAmountCents: integer("auto_recharge_amount_cents").default(5000),
    dodoMandateSubscriptionId: text("dodo_mandate_subscription_id"),
    autoRechargeFailures: integer("auto_recharge_failures").notNull().default(0),
    autoRechargeLastAttemptAt: timestamp("auto_recharge_last_attempt_at"),

    // Our-side $0 subscription on "Coregit API Access" metered product.
    // Required for meter events to deduct credits per Dodo architecture.
    dodoApiSubscriptionId: text("dodo_api_subscription_id"),

    // Legacy subscription columns kept temporarily for migration rollback; drop in Phase 5.
    dodoSubscriptionId: text("dodo_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("org_plan_org_idx").on(t.orgId),
    index("org_plan_dodo_customer_idx").on(t.dodoCustomerId),
  ]
);

export type OrgPlan = typeof orgPlan.$inferSelect;

// Custom domain monthly billing tracker — one row per billable domain
export const customDomainBilling = pgTable(
  "custom_domain_billing",
  {
    id: text("id").primaryKey(),
    domainId: text("domain_id").notNull(),                      // references custom_domain.id (FK in DB)
    orgId: text("org_id").notNull(),
    lastBilledAt: timestamp("last_billed_at").defaultNow().notNull(),
    nextBillingAt: timestamp("next_billing_at").notNull(),
    failures: integer("failures").notNull().default(0),
    status: text("status").notNull().default("active"),          // 'active' | 'suspended'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("custom_domain_billing_next_idx").on(t.nextBillingAt),
    uniqueIndex("custom_domain_billing_domain_idx").on(t.domainId),
  ]
);

export type CustomDomainBilling = typeof customDomainBilling.$inferSelect;

// Usage events (analytics only — billing runs through wallet_transaction)
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

// Semantic search index tracking
export const semanticIndex = pgTable(
  "semantic_index",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    branch: text("branch").notNull(),
    lastCommitSha: text("last_commit_sha"),
    chunksCount: bigint("chunks_count", { mode: "number" }).default(0),
    totalBatches: bigint("total_batches", { mode: "number" }).default(0),
    processedBatches: bigint("processed_batches", { mode: "number" }).default(0),
    status: text("status").notNull().default("pending"), // pending | indexing | ready | failed
    error: text("error"),
    indexedAt: timestamp("indexed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("semantic_index_repo_branch_idx").on(table.repoId, table.branch),
    index("semantic_index_org_idx").on(table.orgId),
  ]
);

export type SemanticIndex = typeof semanticIndex.$inferSelect;

// Code graph nodes (structural code intelligence)
export const codeNode = pgTable(
  "code_node",
  {
    id: text("id").primaryKey(),                    // {repoId}:{blobSha}:{type}:{name}
    type: text("type").notNull(),                   // Function, Class, Interface, Enum, Type, Variable, Module, Decorator, Test, Route, Comment, File
    name: text("name").notNull(),
    filePath: text("file_path").notNull(),
    blobSha: text("blob_sha").notNull(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    signature: text("signature"),
    language: text("language"),
    exported: boolean("exported").default(false),
    complexity: integer("complexity"),
    communityId: text("community_id"),
  },
  (table) => [
    index("code_node_repo_blob_idx").on(table.repoId, table.blobSha),
    index("code_node_repo_name_idx").on(table.repoId, table.name),
    index("code_node_repo_type_idx").on(table.repoId, table.type),
    index("code_node_community_idx").on(table.repoId, table.communityId),
    index("code_node_repo_filepath_idx").on(table.repoId, table.filePath),
  ]
);

export type CodeNode = typeof codeNode.$inferSelect;
export type NewCodeNode = typeof codeNode.$inferInsert;

// Code graph edges (relationships between nodes)
export const codeEdge = pgTable(
  "code_edge",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    type: text("type").notNull(),                   // CALLS, IMPORTS, EXTENDS, IMPLEMENTS, EXPORTS, CONTAINS, USES_TYPE, RETURNS_TYPE, OVERRIDES, DECORATES, TESTS, MEMBER_OF, READS, WRITES, THROWS, DOCUMENTS
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("code_edge_source_idx").on(table.sourceId),
    index("code_edge_target_idx").on(table.targetId),
    index("code_edge_repo_type_idx").on(table.repoId, table.type),
  ]
);

export type CodeEdge = typeof codeEdge.$inferSelect;
export type NewCodeEdge = typeof codeEdge.$inferInsert;

// Code graph index tracking (mirrors semanticIndex)
export const codeGraphIndex = pgTable(
  "code_graph_index",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repo.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    branch: text("branch").notNull(),
    lastCommitSha: text("last_commit_sha"),
    nodesCount: bigint("nodes_count", { mode: "number" }).default(0),
    edgesCount: bigint("edges_count", { mode: "number" }).default(0),
    totalBatches: bigint("total_batches", { mode: "number" }).default(0),
    processedBatches: bigint("processed_batches", { mode: "number" }).default(0),
    status: text("status").notNull().default("pending"), // pending | indexing | ready | failed
    error: text("error"),
    indexedAt: timestamp("indexed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("code_graph_index_repo_branch_idx").on(table.repoId, table.branch),
    index("code_graph_index_org_idx").on(table.orgId),
  ]
);

export type CodeGraphIndex = typeof codeGraphIndex.$inferSelect;
