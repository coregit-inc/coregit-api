import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

/**
 * Resolve the Postgres connection string from the Worker env.
 *
 * Production: HYPERDRIVE only. The active version is deployed by Workers
 * Builds via `wrangler deploy` (no `--tag`), so `CF_VERSION_METADATA.tag`
 * is undefined → the PREVIEW_DATABASE_URL branch is unreachable, even if
 * that secret somehow leaks to the Worker scope.
 *
 * Preview deploys (openhive workflow): `versions upload --preview-alias
 * <slug> --tag <sha> --secrets-file …` injects PREVIEW_DATABASE_URL
 * pointing at the per-branch Neon clone AND tags the version. The gate
 * below sees both signals and routes the preview alias to its own clone.
 *
 * Why two signals: per-version secrets historically bled to Worker scope
 * on this account (DATABASE_URL stuck around even after the source Neon
 * branch was torn down, taking prod with it). Requiring CF_VERSION_METADATA
 * .tag as a co-signal makes prod immune to a leaked secret.
 */
export function dbConnectionString(env: {
  PREVIEW_DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}): string {
  const isPreviewAlias = !!env.CF_VERSION_METADATA?.tag;
  if (isPreviewAlias && env.PREVIEW_DATABASE_URL) {
    return env.PREVIEW_DATABASE_URL;
  }
  // Falsy → empty string preserves the existing `if (!c.env.HYPERDRIVE.connectionString)`
  // call sites that returned 500 when the DB wasn't wired up.
  return env.HYPERDRIVE?.connectionString ?? "";
}

/**
 * Create a database connection via postgres-js (TCP) for Hyperdrive.
 *
 * postgres-js db.execute() returns a RowList (array-like).
 * 35+ call sites expect result.rows (neon-http format).
 * The wrapper adds .rows for backward compatibility at runtime.
 * TypeScript is satisfied via the type override below.
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  const db = drizzlePostgresCompat(client);
  return db;
}

function drizzlePostgresCompat(client: postgres.Sql) {
  const db = drizzle(client, { schema });

  const originalExecute = db.execute.bind(db);
  const wrappedExecute = async (query: any): Promise<any> => {
    const result = await originalExecute(query);
    // postgres-js returns RowList (array). Add .rows for neon-http compat.
    if (Array.isArray(result) && !(result as any).rows) {
      (result as any).rows = [...result];
    }
    return result;
  };

  return Object.assign(db, { execute: wrappedExecute });
}

export type Database = ReturnType<typeof createDb>;
