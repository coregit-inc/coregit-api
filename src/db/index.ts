import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

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
