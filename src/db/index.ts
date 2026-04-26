import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

/**
 * Resolve the Postgres connection string from the Worker env. Preview
 * deploys pass DATABASE_URL as a secret (no Hyperdrive in preview because
 * Hyperdrive bindings can't fan out to per-branch Neon clones). Production
 * uses Hyperdrive's pooled connection.
 */
export function dbConnectionString(env: {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
}): string {
  // Falsy → empty string preserves the existing `if (!c.env.HYPERDRIVE.connectionString)`
  // call sites that returned 500 when the DB wasn't wired up.
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.HYPERDRIVE?.connectionString) return env.HYPERDRIVE.connectionString;
  return "";
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
