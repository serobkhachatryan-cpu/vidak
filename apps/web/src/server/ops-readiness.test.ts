import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { GET as liveGet } from '../app/api/health/live/route';
import { GET as readyGet } from '../app/api/health/ready/route';
import { authenticationErrorResponse } from './ops-http';
import {
  CORRELATION_HEADER,
  reportOperationalFailure,
  resolveCorrelationId,
  setOperationalLogSinkForTests,
} from './ops-observability';
import {
  checkReadiness,
  probeFfmpegExecutable,
  REQUIRED_READINESS_TABLES,
  readinessFailureCategory,
  reportReadinessFailure,
} from './ops-readiness';
import { redactSensitiveText } from './ops-redaction';
import { W3dsAuthError } from './w3ds-auth-errors';

const playbackBridgeUrl =
  'https://meshenger.example/api/integrations/vidak/recording-playback-grant';
const playbackBridgeSecret = '0123456789abcdef0123456789abcdef';

describe('ops redaction', () => {
  it('redacts cookies, bearer tokens, credentials, and sensitive configuration', () => {
    const redacted = redactSensitiveText(
      [
        'Cookie: w3ds_access=abc.def.ghi; Path=/',
        'Authorization: Bearer tok_live_123',
        'DATABASE_URL=postgresql://vidak:secret@db.internal:5432/vidak',
        'W3DS_AUTH_JWT_SECRET=super-secret-value-123456789012',
        'MEDIA_STORAGE_ROOT=/var/data/media-private',
        'password=hunter2',
      ].join(' '),
    );

    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('tok_live_123');
    expect(redacted).not.toContain('w3ds_access=abc');
    expect(redacted).not.toContain('postgresql://');
    expect(redacted).not.toContain('super-secret-value');
    expect(redacted).not.toContain('/var/data/media-private');
    expect(redacted).not.toContain('hunter2');
  });
});

describe('correlation ids', () => {
  it('prefers X-Request-Id and accepts X-Correlation-Id', () => {
    expect(
      resolveCorrelationId(new Headers({ 'X-Request-Id': 'req-1', 'X-Correlation-Id': 'corr-2' })),
    ).toBe('req-1');
    expect(resolveCorrelationId(new Headers({ 'X-Correlation-Id': 'corr-2' }))).toBe('corr-2');
    expect(resolveCorrelationId(new Headers()).length).toBeGreaterThan(8);
  });

  it('reports authentication configuration failures with correlation', () => {
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    const response = authenticationErrorResponse(
      new W3dsAuthError(
        'W3DS authentication requires DATABASE_URL. Got postgresql://vidak:hunter2@db/vidak Bearer tok_live_1',
        'configuration_error',
        503,
      ),
      new Headers({ 'X-Request-Id': 'auth-corr-1' }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get(CORRELATION_HEADER)).toBe('auth-corr-1');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"category":"authentication"');
    expect(logs[0]).not.toContain('hunter2');
    expect(logs[0]).not.toContain('postgresql://');
    expect(logs[0]).not.toContain('tok_live_1');
  });
});

describe('checkReadiness', () => {
  let mediaRoot: string | undefined;

  afterEach(async () => {
    setOperationalLogSinkForTests(undefined);
    if (mediaRoot) {
      await rm(mediaRoot, { recursive: true, force: true });
      mediaRoot = undefined;
    }
  });

  it('requires durable ingress and continuous-recording migrations before accepting traffic', () => {
    expect(REQUIRED_READINESS_TABLES).toEqual([
      'w3ds_platform_users',
      'w3ds_awareness_receipts',
      'recording_concat_tickets',
      'recording_concat_ticket_locks',
      'playback_resolution_cache',
    ]);
  });

  it('succeeds for development config with accessible media storage', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: mediaRoot,
      },
      {
        probeDatabase: async () => {
          throw new Error('database must not be probed in AUTH_PROVIDER=dev');
        },
        probeMigrations: async () => {
          throw new Error('migrations must not be probed in AUTH_PROVIDER=dev');
        },
        probeFfmpeg: async () => undefined,
      },
    );
    expect(result).toEqual({ ready: true });
  });

  it('requires FFmpeg before accepting traffic', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const probeFfmpeg = vi.fn(async () => {
      throw new Error('ffmpeg is not executable');
    });

    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: mediaRoot,
      },
      { probeFfmpeg },
    );

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.failedDependency).toBe('ffmpeg');
    expect(probeFfmpeg).toHaveBeenCalledOnce();
  });

  it('fails closed when a playback bridge is partial or invalid', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const probeFfmpeg = vi.fn(async () => undefined);
    const base = {
      NODE_ENV: 'development',
      AUTH_PROVIDER: 'dev',
      MEDIA_STORAGE_ROOT: mediaRoot,
    };

    for (const bridgeConfig of [
      { MESHENGER_PLAYBACK_GRANT_URL: playbackBridgeUrl },
      {
        MESHENGER_PLAYBACK_GRANT_URL: 'https://meshenger.example/not-the-playback-bridge',
        VIDAK_PLAYBACK_BRIDGE_SECRET: playbackBridgeSecret,
      },
    ]) {
      const result = await checkReadiness({ ...base, ...bridgeConfig }, { probeFfmpeg });
      expect(result.ready).toBe(false);
      if (result.ready) continue;
      expect(result.failedDependency).toBe('playback_bridge');
    }
    expect(probeFfmpeg).not.toHaveBeenCalled();
  });

  it('accepts a complete valid playback bridge configuration', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const probeFfmpeg = vi.fn(async () => undefined);
    const probePlaybackBridge = vi.fn(async () => undefined);

    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: mediaRoot,
        MESHENGER_PLAYBACK_GRANT_URL: playbackBridgeUrl,
        VIDAK_PLAYBACK_BRIDGE_SECRET: playbackBridgeSecret,
      },
      { probeFfmpeg, probePlaybackBridge },
    );

    expect(result).toEqual({ ready: true });
    expect(probeFfmpeg).toHaveBeenCalledOnce();
    expect(probePlaybackBridge).toHaveBeenCalledWith({
      endpoint: playbackBridgeUrl,
      secret: playbackBridgeSecret,
    });
  });

  it('fails readiness when the configured source bridge does not authenticate its empty probe', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const probeFfmpeg = vi.fn(async () => undefined);
    const bridgeFailure = new Error('source bridge returned 404');
    const probePlaybackBridge = vi.fn(async () => {
      throw bridgeFailure;
    });

    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: mediaRoot,
        MESHENGER_PLAYBACK_GRANT_URL: playbackBridgeUrl,
        VIDAK_PLAYBACK_BRIDGE_SECRET: playbackBridgeSecret,
      },
      { probeFfmpeg, probePlaybackBridge },
    );

    expect(result).toEqual({
      ready: false,
      failedDependency: 'playback_bridge',
      cause: bridgeFailure,
    });
    expect(probeFfmpeg).not.toHaveBeenCalled();
  });

  it('fails closed when only part of the AaaS webhook configuration is supplied', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const probeDatabase = vi.fn(async () => undefined);
    const probeMigrations = vi.fn(async () => undefined);
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));

    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: mediaRoot,
        W3DS_AAAS_WEBHOOK_SECRET: 'do-not-log-this-webhook-secret',
      },
      { probeDatabase, probeMigrations },
    );

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.failedDependency).toBe('awareness_webhook');
    expect(probeDatabase).not.toHaveBeenCalled();
    expect(probeMigrations).not.toHaveBeenCalled();

    reportReadinessFailure(result, 'aware-ready-1');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"category":"w3ds_sync"');
    expect(logs[0]).not.toContain('do-not-log-this-webhook-secret');
  });

  it('requires database and receipt-migration probes when AaaS ingress is fully configured', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const databaseUrl = 'postgresql://vidak:secret@db.internal:5432/vidak';
    const probeDatabase = vi.fn(async () => undefined);
    const probeMigrations = vi.fn(async () => undefined);

    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: mediaRoot,
        DATABASE_URL: databaseUrl,
        W3DS_AAAS_WEBHOOK_SECRET: 'configured-webhook-secret',
        W3DS_AAAS_SIGNATURE_ENCODING: 'hex',
      },
      { probeDatabase, probeMigrations, probeFfmpeg: async () => undefined },
    );

    expect(result).toEqual({ ready: true });
    expect(probeDatabase).toHaveBeenCalledWith(databaseUrl);
    expect(probeMigrations).toHaveBeenCalledWith(databaseUrl);
  });

  it('fails readiness when configured AaaS ingress has no database URL', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const probeDatabase = vi.fn(async () => undefined);
    const probeMigrations = vi.fn(async () => undefined);

    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: mediaRoot,
        W3DS_AAAS_WEBHOOK_SECRET: 'configured-webhook-secret',
        W3DS_AAAS_SIGNATURE_ENCODING: 'base64',
      },
      { probeDatabase, probeMigrations },
    );

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.failedDependency).toBe('awareness_webhook');
    expect(probeDatabase).not.toHaveBeenCalled();
    expect(probeMigrations).not.toHaveBeenCalled();
  });

  it('fails closed for W3DS when database probe fails without leaking secrets', async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-'));
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));

    const result = await checkReadiness(
      {
        NODE_ENV: 'production',
        AUTH_PROVIDER: 'w3ds',
        APP_ORIGIN: 'https://vidak.example',
        DATABASE_URL: 'postgresql://vidak:hunter2@db.internal:5432/vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
        W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
        MEDIA_STORAGE_ROOT: mediaRoot,
      },
      {
        probeDatabase: async () => {
          throw new Error(
            'connect failed DATABASE_URL=postgresql://vidak:hunter2@db.internal:5432/vidak',
          );
        },
      },
    );

    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.failedDependency).toBe('database');

    reportReadinessFailure(result, 'corr-db-1');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"category":"migration_readiness"');
    expect(logs[0]).toContain('corr-db-1');
    expect(logs[0]).not.toContain('hunter2');
    expect(logs[0]).not.toContain('postgresql://');
    expect(logs[0]).not.toContain(mediaRoot);
  });

  it('maps dependency failures to operational categories', () => {
    expect(readinessFailureCategory('media_storage')).toBe('media_storage');
    expect(readinessFailureCategory('migrations')).toBe('migration_readiness');
    expect(readinessFailureCategory('database')).toBe('migration_readiness');
    expect(readinessFailureCategory('config')).toBe('authentication');
    expect(readinessFailureCategory('awareness_webhook')).toBe('w3ds_sync');
    expect(readinessFailureCategory('playback_bridge')).toBe('video_playback');
    expect(readinessFailureCategory('ffmpeg')).toBe('video_playback');
  });

  it('fails when media storage is inaccessible', async () => {
    const result = await checkReadiness(
      {
        NODE_ENV: 'development',
        AUTH_PROVIDER: 'dev',
        MEDIA_STORAGE_ROOT: '/definitely/not/writable/vidak-media-root',
      },
      {
        probeMediaStorage: async () => {
          throw new Error('EACCES MEDIA_STORAGE_ROOT=/secret/path');
        },
      },
    );
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.failedDependency).toBe('media_storage');
  });

  it('reports structured w3ds_sync failures through the shared sink', () => {
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    reportOperationalFailure({
      category: 'w3ds_sync',
      correlationId: 'sync-1',
      code: 'sync_failed',
      error: new Error('Bearer tok_live_999 failed against https://user:pass@evault.example'),
    });
    expect(logs[0]).toContain('"category":"w3ds_sync"');
    expect(logs[0]).not.toContain('tok_live_999');
    expect(logs[0]).not.toContain('user:pass@');
  });
});

describe('FFmpeg readiness probe', () => {
  let executableDir: string | undefined;

  afterEach(async () => {
    if (executableDir) {
      await rm(executableDir, { recursive: true, force: true });
      executableDir = undefined;
    }
  });

  it('executes the configured binary and rejects a missing executable', async () => {
    executableDir = await mkdtemp(join(tmpdir(), 'vidak-ffmpeg-ready-'));
    const executable = join(executableDir, 'ffmpeg');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);

    await expect(probeFfmpegExecutable(executable)).resolves.toBeUndefined();
    await expect(probeFfmpegExecutable(join(executableDir, 'missing-ffmpeg'))).rejects.toThrow();
  });
});

describe('health routes', () => {
  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns a minimal liveness payload and echoes correlation ids', async () => {
    const response = await liveGet(
      new NextRequest('http://localhost/api/health/live', {
        headers: { 'X-Request-Id': 'live-corr-1' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(CORRELATION_HEADER)).toBe('live-corr-1');
    const payload = await response.json();
    expect(payload).toEqual({ status: 'ok' });
    expect(JSON.stringify(payload)).not.toMatch(/database|storage|jwt|secret|postgresql|MEDIA_/i);
  });

  it('returns a generic readiness failure without dependency details', async () => {
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));

    const blocker = join(tmpdir(), `vidak-ready-blocker-${Date.now()}`);
    await writeFile(blocker, 'not-a-directory');

    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_PROVIDER', 'dev');
    vi.stubEnv('MEDIA_STORAGE_ROOT', blocker);

    try {
      const response = await readyGet(
        new NextRequest('http://localhost/api/health/ready', {
          headers: { 'X-Correlation-Id': 'ready-corr-9' },
        }),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get(CORRELATION_HEADER)).toBe('ready-corr-9');
      const payload = await response.json();
      expect(payload).toEqual({
        error: { code: 'not_ready', message: 'Service is not ready.' },
      });
      expect(JSON.stringify(payload)).not.toContain(blocker);
      expect(JSON.stringify(payload)).not.toContain('media_storage');
      expect(logs.some((line) => line.includes('ready-corr-9'))).toBe(true);
      expect(logs.join('\n')).not.toContain(blocker);
    } finally {
      await rm(blocker, { force: true });
    }
  });

  it('does not expose partial AaaS webhook configuration through readiness', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-route-'));
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_PROVIDER', 'dev');
    vi.stubEnv('MEDIA_STORAGE_ROOT', mediaRoot);
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', 'do-not-expose-this-webhook-secret');

    try {
      const response = await readyGet(new NextRequest('http://localhost/api/health/ready'));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'not_ready', message: 'Service is not ready.' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('"category":"w3ds_sync"');
      expect(logs[0]).not.toContain('do-not-expose-this-webhook-secret');
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it('does not expose incomplete playback-bridge configuration through readiness', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-route-'));
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_PROVIDER', 'dev');
    vi.stubEnv('MEDIA_STORAGE_ROOT', mediaRoot);
    vi.stubEnv('MESHENGER_PLAYBACK_GRANT_URL', playbackBridgeUrl);

    try {
      const response = await readyGet(new NextRequest('http://localhost/api/health/ready'));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'not_ready', message: 'Service is not ready.' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('"category":"video_playback"');
      expect(logs.join('\n')).not.toContain(playbackBridgeUrl);
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it('returns ready when dependency probes succeed', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-route-'));
    try {
      const ffmpeg = join(mediaRoot, 'ffmpeg');
      await writeFile(ffmpeg, '#!/bin/sh\nexit 0\n');
      await chmod(ffmpeg, 0o755);
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('AUTH_PROVIDER', 'dev');
      vi.stubEnv('MEDIA_STORAGE_ROOT', mediaRoot);
      vi.stubEnv('PATH', mediaRoot);

      const response = await readyGet(new NextRequest('http://localhost/api/health/ready'));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'ready' });
      expect(response.headers.get(CORRELATION_HEADER)).toBeTruthy();
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it('keeps a missing FFmpeg dependency generic to readiness callers', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'vidak-ready-route-'));
    const emptyPath = await mkdtemp(join(tmpdir(), 'vidak-no-ffmpeg-'));
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AUTH_PROVIDER', 'dev');
    vi.stubEnv('MEDIA_STORAGE_ROOT', mediaRoot);
    vi.stubEnv('PATH', emptyPath);

    try {
      const response = await readyGet(new NextRequest('http://localhost/api/health/ready'));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'not_ready', message: 'Service is not ready.' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('"category":"video_playback"');
      expect(JSON.stringify(logs)).not.toContain(emptyPath);
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
      await rm(emptyPath, { recursive: true, force: true });
    }
  });
});
