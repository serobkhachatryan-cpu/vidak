/// <reference path="./server-only-module.d.ts" />
import { createAuthUser } from '@w3ds/auth';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import { ChannelImportError, createInMemoryChannelImportService } from './channel-import-service';

const user = createAuthUser({
  id: 'user-1',
  displayName: 'Creator',
  roles: [],
  eName: 'creator.w3id',
  eVaultId: 'vault-1',
  capabilities: [],
  permissions: {
    canUpload: true,
    canComment: true,
    canManageOwnChannels: true,
    canModerate: false,
    canAccessAdmin: false,
  },
});

const enabledEnv = {
  APP_ORIGIN: 'https://vidak.postplatforms.com',
  CHANNEL_IMPORT_STATE_SECRET: 's'.repeat(32),
  CHANNEL_IMPORT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  YOUTUBE_OAUTH_CLIENT_ID: 'youtube-client',
  YOUTUBE_OAUTH_CLIENT_SECRET: 'youtube-secret',
  VIMEO_OAUTH_CLIENT_ID: 'vimeo-client',
  VIMEO_OAUTH_CLIENT_SECRET: 'vimeo-secret',
};

describe('channel imports', () => {
  it('does not advertise providers before their full server-only configuration exists', () => {
    const { service } = createInMemoryChannelImportService({ env: { APP_ORIGIN: 'https://vidak.test' } });
    expect(service.providerStatuses()).toEqual([
      { provider: 'youtube', label: 'YouTube', available: false },
      { provider: 'vimeo', label: 'Vimeo', available: false },
    ]);
  });

  it('uses a one-time state and connects only channels returned by the approved YouTube account', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'provider-access-token',
          refresh_token: 'provider-refresh-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/youtube.readonly',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              id: 'UC_source',
              snippet: {
                title: 'Creator source channel',
                thumbnails: { high: { url: 'https://img.youtube.test/channel.jpg' } },
              },
            },
          ],
        }),
      );
    const { service } = createInMemoryChannelImportService({
      env: enabledEnv,
      resolveUser: async () => user,
      fetch,
      createId: (() => {
        let index = 0;
        return () => 'id-' + ++index;
      })(),
      createState: () => 'a'.repeat(43),
      now: () => new Date('2026-08-27T10:00:00.000Z'),
    });

    const started = await service.beginAuthorization('session', 'youtube');
    const authorizeUrl = new URL(started.authorizationUrl);
    expect(authorizeUrl.origin).toBe('https://accounts.google.com');
    expect(authorizeUrl.searchParams.get('state')).toBe('a'.repeat(43));
    expect(authorizeUrl.searchParams.get('client_id')).toBe('youtube-client');
    expect(started.authorizationUrl).not.toContain('youtube-secret');

    await expect(
      service.completeAuthorization({
        accessToken: 'session',
        providerInput: 'youtube',
        state: 'a'.repeat(43),
        code: 'provider-code',
      }),
    ).resolves.toEqual({ importedChannels: 1 });

    await expect(service.listImportedChannels('session')).resolves.toEqual([
      {
        id: 'id-3',
        provider: 'youtube',
        sourceChannelId: 'UC_source',
        title: 'Creator source channel',
        sourceUrl: 'https://www.youtube.com/channel/UC_source',
        thumbnailUrl: 'https://img.youtube.test/channel.jpg',
        status: 'connected',
        importedVideoCount: 0,
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);

    await expect(
      service.completeAuthorization({
        accessToken: 'session',
        providerInput: 'youtube',
        state: 'a'.repeat(43),
        code: 'replayed-code',
      }),
    ).rejects.toMatchObject({ code: 'invalid_state', status: 400 });
  });

  it('fails closed when a provider has not been configured', async () => {
    const { service } = createInMemoryChannelImportService({
      env: { APP_ORIGIN: 'https://vidak.test' },
      resolveUser: async () => user,
    });
    await expect(service.beginAuthorization('session', 'vimeo')).rejects.toMatchObject({ code: 'provider_unavailable', status: 503 });
  });
});
