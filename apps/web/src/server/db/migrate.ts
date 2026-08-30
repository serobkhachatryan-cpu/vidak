import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { repairPlaceholderCreatorChannelNames } from '../creator-video-store';
import * as schema from './schema';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required to run W3DS auth migrations.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    const repaired = await repairPlaceholderCreatorChannelNames(db);
    console.log(`Applied W3DS auth migrations from ${migrationsFolder}`);
    if (repaired > 0) {
      console.log(`Repaired ${repaired} placeholder creator channel name(s)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
