import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { W3dsAuthError } from '../w3ds-auth-errors';
import * as schema from './schema';

export type W3dsDatabase = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: W3dsDatabase | undefined;
let playbackPool: Pool | undefined;
let playbackDb: W3dsDatabase | undefined;

// Playback cache/epoch operations use a dedicated, short-query pool. A
// route-level Promise.race cannot cancel a PostgreSQL statement, so these
// real connection/query/statement deadlines prevent stalled range requests
// from accumulating live work. Other application workflows keep their normal
// pool and must not inherit this latency-sensitive limit.
const databaseConnectionTimeoutMs = 1_500;
const databaseStatementTimeoutMs = 2_000;

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

/**
 * A separate tiny-latency database boundary for private-media cache and
 * recovery-epoch queries. It deliberately shares the same schema/database,
 * not the long-running application's connection pool or timeout policy.
 */
export function getPlaybackW3dsDatabase(databaseUrl = process.env.DATABASE_URL): W3dsDatabase {
  const url = databaseUrl?.trim();
  if (!url) {
    throw new W3dsAuthError(
      'W3DS authentication requires DATABASE_URL for durable session persistence.',
      'configuration_error',
      503,
    );
  }
  if (!playbackDb) {
    playbackPool = new Pool({
      connectionString: url,
      connectionTimeoutMillis: databaseConnectionTimeoutMs,
      query_timeout: databaseStatementTimeoutMs,
      statement_timeout: databaseStatementTimeoutMs,
    });
    playbackDb = drizzle(playbackPool, { schema });
  }
  return playbackDb;
}

/** Test helper to dispose the shared pool between cases. */
export async function closeW3dsDatabase(): Promise<void> {
  await Promise.all([pool?.end(), playbackPool?.end()]);
  pool = undefined;
  db = undefined;
  playbackPool = undefined;
  playbackDb = undefined;
}
