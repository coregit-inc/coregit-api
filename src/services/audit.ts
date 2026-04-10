/**
 * Audit logging service.
 *
 * Records security-relevant events to the audit_log table.
 * Fire-and-forget via waitUntil — does not block the request.
 */

import { sql } from "drizzle-orm";
import type { Database } from "../db";

export type AuditAction =
  | "repo.create"
  | "repo.delete"
  | "repo.update"
  | "commit.create"
  | "branch.create"
  | "branch.delete"
  | "branch.merge"
  | "token.create"
  | "token.revoke"
  | "webhook.create"
  | "webhook.update"
  | "webhook.delete"
  | "repo.fork";

export function recordAudit(
  ctx: ExecutionContext,
  db: Database,
  params: {
    orgId: string;
    actorId: string;
    actorType: "master_key" | "scoped_token" | "internal";
    action: AuditAction;
    resourceType: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
    requestId?: string;
  }
): void {
  ctx.waitUntil(
    db
      .execute(
        sql`INSERT INTO audit_log (org_id, actor_id, actor_type, action, resource_type, resource_id, metadata, ip_address, request_id)
            VALUES (${params.orgId}, ${params.actorId}, ${params.actorType}, ${params.action}, ${params.resourceType}, ${params.resourceId || null}, ${params.metadata ? JSON.stringify(params.metadata) : null}::jsonb, ${params.ipAddress || null}, ${params.requestId || null})`
      )
      .catch((err) => {
        console.error("Failed to record audit event:", err);
      })
  );
}
