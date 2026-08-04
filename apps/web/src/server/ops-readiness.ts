/**
 * Production readiness probes for dependencies required to serve requests.
 * Failures are reported server-side; public responses stay generic.
 */

import { access, constants, mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { type OperationalFailureCategory, reportOperationalFailure } from './ops-observability';
import { loadServerSecurityConfig, type ServerSecurityConfig } from './server-config';

export type ReadinessDependency = 'config' | 'database' | 'media_storage' | 'migrations';

export type ReadinessSuccess = { ready: true };
export type ReadinessFailure = {
  ready: false;
  /** Internal only — never serialize into HTTP responses. */
  failedDependency: ReadinessDependency;
  cause: unknown;
};

export type ReadinessResult = ReadinessSuccess | ReadinessFailure;

export interface ReadinessProbes {
  loadConfig?: (env: Record<string, string | undefined>) => ServerSecurityConfig;
  probeDatabase?: (databaseUrl: string) => Promise<void>;
  probeMediaStorage?: (rootDir: string) => Promise<void>;
  probeMigrations?: (databaseUrl: string) => Promise<void>;
}

const REQUIRED_TABLE = 'w3ds_platform_users';

/**
 * Verifies configuration and runtime dependencies needed to serve traffic.
 * Does not call live W3DS Registry/eVault/ACL services.
 */
export async function checkReadiness(
  env: Record<string, string | undefined> = process.env,
  probes: ReadinessProbes = {},
): Promise<ReadinessResult> {
  const loadConfig = probes.loadConfig ?? loadServerSecurityConfig;
  const probeDatabase = probes.probeDatabase ?? defaultProbeDatabase;
  const probeMediaStorage = probes.probeMediaStorage ?? defaultProbeMediaStorage;
  const probeMigrations = probes.probeMigrations ?? defaultProbeMigrations;

  let config: ServerSecurityConfig;
  try {
    config = loadConfig(env);
  } catch (cause) {
    return { ready: false, failedDependency: 'config', cause };
  }

  try {
    await probeMediaStorage(config.mediaStorageRoot);
  } catch (cause) {
    return { ready: false, failedDependency: 'media_storage', cause };
  }

  if (config.authProvider === 'w3ds') {
    const databaseUrl = config.w3ds?.databaseUrl;
    if (!databaseUrl) {
      return {
        ready: false,
        failedDependency: 'config',
        cause: new Error('W3DS mode requires a configured database.'),
      };
    }
    try {
      await probeDatabase(databaseUrl);
    } catch (cause) {
      return { ready: false, failedDependency: 'database', cause };
    }
    try {
      await probeMigrations(databaseUrl);
    } catch (cause) {
      return { ready: false, failedDependency: 'migrations', cause };
    }
  }

  return { ready: true };
}

/** Maps an internal dependency failure to an operational log category. */
export function readinessFailureCategory(
  dependency: ReadinessDependency,
): OperationalFailureCategory {
  if (dependency === 'media_storage') return 'media_storage';
  if (dependency === 'config') return 'authentication';
  return 'migration_readiness';
}

export function reportReadinessFailure(failure: ReadinessFailure, correlationId: string): void {
  reportOperationalFailure({
    category: readinessFailureCategory(failure.failedDependency),
    correlationId,
    error: failure.cause,
    code: 'not_ready',
  });
}

async function defaultProbeDatabase(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 1_000,
  });
  try {
    await pool.query('select 1');
  } finally {
    await pool.end();
  }
}

async function defaultProbeMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 1_000,
  });
  try {
    const result = await pool.query<{ exists: boolean }>(
      `select exists (
         select 1
         from information_schema.tables
         where table_schema = 'public' and table_name = $1
       ) as exists`,
      [REQUIRED_TABLE],
    );
    if (!result.rows[0]?.exists) {
      throw new Error('Required database migrations are not applied.');
    }
  } finally {
    await pool.end();
  }
}

async function defaultProbeMediaStorage(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await access(rootDir, constants.R_OK | constants.W_OK);
}
