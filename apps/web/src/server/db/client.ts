import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { W3dsAuthError } from '../w3ds-auth-errors';
import * as schema from './schema';

export type W3dsDatabase = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: W3dsDatabase | undefined;

/** Returns a shared Drizzle client for W3DS auth persistence. */
export function getW3dsDatabase(databaseUrl = process.env.DATABASE_URL): W3dsDatabase {
  const url = databaseUrl?.trim();
  if (!url) {
    throw new W3dsAuthError(
      'W3DS authentication requires DATABASE_URL for durable session persistence.',
      'configuration_error',
      503,
    );
  }
  if (!db) {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  }
  return db;
}

/** Test helper to dispose the shared pool between cases. */
export async function closeW3dsDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
