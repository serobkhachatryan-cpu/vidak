/**
 * Production readiness probes for dependencies required to serve requests.
 * Failures are reported server-side; public responses stay generic.
 */

import { execFile } from 'node:child_process';
import { access, constants, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  type MeshengerPlaybackGrantConfig,
  probeMeshengerPlaybackGrant,
  readMeshengerPlaybackGrantConfig,
} from './meshenger-playback-grant';
import { type OperationalFailureCategory, reportOperationalFailure } from './ops-observability';
import {
  loadServerSecurityConfig,
  readW3dsAaasWebhookConfig,
  type ServerSecurityConfig,
} from './server-config';

export type ReadinessDependency =
  | 'config'
  | 'database'
  | 'media_storage'
  | 'migrations'
  | 'awareness_webhook'
  | 'playback_bridge'
  | 'ffmpeg';

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
  probeFfmpeg?: () => Promise<void>;
  probePlaybackBridge?: (config: MeshengerPlaybackGrantConfig) => Promise<void>;
}

const execFileAsync = promisify(execFile);
const ffmpegReadinessTimeoutMs = 3_000;

/**
 * Tables that must exist before this process accepts traffic. Keep the
 * receive-only Awareness receipt table here: without it, a P2 webhook could
 * authenticate successfully but fail only after AaaS has delivered a packet.
 */
export const REQUIRED_READINESS_TABLES = [
  'w3ds_platform_users',
  'w3ds_awareness_receipts',
  // Continuous recording playback must not start with a process-local ticket
  // fallback: browser POST and GET requests can land on different replicas.
  'recording_concat_tickets',
  'recording_concat_ticket_locks',
  // A receipt can cross a load-balancer boundary only if the encrypted
  // resolution handoff is durable; otherwise a configured speedup silently
  // regresses back to remote authorization on another replica.
  'playback_resolution_cache',
] as const;

/**
 * Verifies configuration and runtime dependencies needed to serve traffic.
 * It does not probe general W3DS Registry/eVault/ACL traffic. When the
 * optional Meshenger bridge is configured, it does make one signed empty
 * request so a missing source deployment cannot masquerade as a speedup.
 */
export async function checkReadiness(
  env: Record<string, string | undefined> = process.env,
  probes: ReadinessProbes = {},
): Promise<ReadinessResult> {
  const loadConfig = probes.loadConfig ?? loadServerSecurityConfig;
  const probeDatabase = probes.probeDatabase ?? defaultProbeDatabase;
  const probeMediaStorage = probes.probeMediaStorage ?? defaultProbeMediaStorage;
  const probeMigrations = probes.probeMigrations ?? defaultProbeMigrations;
  const probeFfmpeg = probes.probeFfmpeg ?? defaultProbeFfmpeg;
  const probePlaybackBridge = probes.probePlaybackBridge ?? defaultProbePlaybackBridge;

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

  const awarenessWebhook = readW3dsAaasWebhookConfig(env);
  if (hasAwarenessWebhookConfigInput(env) && !awarenessWebhook) {
    return {
      ready: false,
      failedDependency: 'awareness_webhook',
      cause: new Error('AaaS webhook configuration is incomplete or invalid.'),
    };
  }

  const playbackBridge = readMeshengerPlaybackGrantConfig(env);
  if (hasPlaybackBridgeConfigInput(env) && !playbackBridge) {
    return {
      ready: false,
      failedDependency: 'playback_bridge',
      cause: new Error('Meshenger playback bridge configuration is incomplete or invalid.'),
    };
  }
  if (playbackBridge) {
    try {
      await probePlaybackBridge(playbackBridge);
    } catch (cause) {
      return { ready: false, failedDependency: 'playback_bridge', cause };
    }
  }

  if (config.authProvider === 'w3ds' || awarenessWebhook) {
    const databaseUrl = config.w3ds?.databaseUrl ?? env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      return {
        ready: false,
        failedDependency: awarenessWebhook ? 'awareness_webhook' : 'config',
        cause: new Error(
          awarenessWebhook
            ? 'AaaS webhook ingress requires a configured database.'
            : 'W3DS mode requires a configured database.',
        ),
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

  try {
    await probeFfmpeg();
  } catch (cause) {
    return { ready: false, failedDependency: 'ffmpeg', cause };
  }

  return { ready: true };
}

/** Maps an internal dependency failure to an operational log category. */
export function readinessFailureCategory(
  dependency: ReadinessDependency,
): OperationalFailureCategory {
  if (dependency === 'media_storage') return 'media_storage';
  if (dependency === 'config') return 'authentication';
  if (dependency === 'awareness_webhook') return 'w3ds_sync';
  if (dependency === 'playback_bridge') return 'video_playback';
  if (dependency === 'ffmpeg') return 'video_playback';
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
    const result = await pool.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])`,
      [REQUIRED_READINESS_TABLES],
    );
    const present = new Set(result.rows.map((row) => row.table_name));
    if (REQUIRED_READINESS_TABLES.some((table) => !present.has(table))) {
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

/**
 * The continuous-recording route depends on ffmpeg being executable on every
 * application replica. Exercise the binary itself rather than merely checking
 * a Dockerfile or PATH entry, and bound the probe so a broken binary cannot
 * leave readiness requests hanging.
 */
export async function probeFfmpegExecutable(executable = 'ffmpeg'): Promise<void> {
  await execFileAsync(executable, ['-version'], {
    timeout: ffmpegReadinessTimeoutMs,
    maxBuffer: 32 * 1_024,
    windowsHide: true,
  });
}

async function defaultProbeFfmpeg(): Promise<void> {
  await probeFfmpegExecutable();
}

async function defaultProbePlaybackBridge(config: MeshengerPlaybackGrantConfig): Promise<void> {
  await probeMeshengerPlaybackGrant({ config });
}

/** A configured ingress is a production dependency; an absent one stays optional. */
function hasAwarenessWebhookConfigInput(env: Record<string, string | undefined>): boolean {
  return (
    env.W3DS_AAAS_WEBHOOK_SECRET !== undefined || env.W3DS_AAAS_SIGNATURE_ENCODING !== undefined
  );
}

/** The bridge is optional, but a supplied partial configuration must not silently slow playback. */
function hasPlaybackBridgeConfigInput(env: Record<string, string | undefined>): boolean {
  return (
    env.MESHENGER_PLAYBACK_GRANT_URL !== undefined || env.VIDAK_PLAYBACK_BRIDGE_SECRET !== undefined
  );
}
