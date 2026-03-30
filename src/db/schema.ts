import { pgTable, text, timestamp, index, uniqueIndex, jsonb, bigint, boolean } from "drizzle-orm/pg-core";

// ============================================================
// CoreGit application tables
// Better Auth manages: user, session, account, verification,
//   organization, member, invitation, apikey
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
