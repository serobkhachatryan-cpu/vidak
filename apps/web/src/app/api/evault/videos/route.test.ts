import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getCoordinator: vi.fn(),
  getAuthService: vi.fn(),
  getPreviewService: vi.fn(),
}));

vi.mock('../../../../server/video-space/inventory-coordinator', () => ({
  getInventoryCoordinator: mocks.getCoordinator,
}));

vi.mock('../../../../server/video-preview/preview-runtime', () => ({
  getVideoPreviewService: mocks.getPreviewService,
}));

vi.mock('../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { GET } from './route';

describe('eVault video library route', () => {
  beforeEach(() => {
    mocks.getCoordinator.mockReset();
    mocks.getAuthService.mockReset();
    mocks.getPreviewService.mockReset();
    mocks.getPreviewService.mockReturnValue({
      peekLibraryPreview: vi.fn().mockResolvedValue('processing'),
      scheduleLibraryBackfill: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a tab-scoped catalogue with authorized preview metadata', async () => {
    const getSnapshot = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'w3ds-file:@person.w3id/video-1',
          kind: 'file',
          title: 'Video from another app',
          accessScope: 'personal',
          visibility: 'private',
          streamIds: ['opaque-stream-id'],
        },
      ],
      conversations: [],
      messages: [],
      completeness: {
        indexed: 0,
        expected: 0,
        denied: 0,
        missing: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
      },
      discovery: 'complete',
      scope: 'owned',
      metrics: {
        cache: 'miss',
        firstResultMs: 12,
        completionMs: 40,
        sourceCounts: { personalPages: 4, sharedSpaces: 0, failed: 0 },
      },
    });
    mocks.getCoordinator.mockReturnValue({ getSnapshot });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });
    mocks.getPreviewService.mockReturnValue({
      peekLibraryPreview: vi.fn().mockResolvedValue('ready'),
      scheduleLibraryBackfill: vi.fn().mockResolvedValue(undefined),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos?scope=owned', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    const body = await response.json();
    expect(body.discovery).toBe('complete');
    expect(body.scope).toBe('owned');
    expect(body.items[0].previewUrl).toBe('/api/evault/videos/opaque-stream-id/preview');
    expect(body.items[0].previewState).toBe('ready');
    expect(JSON.stringify(body)).not.toMatch(/w3ds:\/\/file|https:\/\/media|Bearer/i);
    expect(getSnapshot).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      { scope: 'owned', refresh: false },
    );
    expect(mocks.getPreviewService).toHaveBeenCalled();
  });

  it('defaults missing scope to all so Home inventories the complete union', async () => {
    const getSnapshot = vi.fn().mockResolvedValue({
      items: [],
      conversations: [],
      messages: [],
      completeness: {
        indexed: 0,
        expected: 0,
        denied: 0,
        missing: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
      },
      discovery: 'complete',
      scope: 'all',
      metrics: {
        cache: 'hit',
        firstResultMs: 0,
        sourceCounts: { personalPages: 0, sharedSpaces: 0, failed: 0 },
      },
    });
    mocks.getCoordinator.mockReturnValue({ getSnapshot });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });

    await GET(
      new NextRequest('https://vidak.example/api/evault/videos', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );
    expect(getSnapshot).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      { scope: 'all', refresh: false },
    );
  });

  it('reuses a refresh scan instead of starting a duplicate', async () => {
    const getSnapshot = vi.fn().mockResolvedValue({
      items: [],
      conversations: [],
      messages: [],
      completeness: {
        indexed: 0,
        expected: 0,
        denied: 0,
        missing: 0,
        complete: false,
        retryNeeded: true,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
      },
      discovery: 'refreshing',
      scope: 'shared',
      metrics: {
        cache: 'coalesced',
        firstResultMs: 5,
        sourceCounts: { personalPages: 1, sharedSpaces: 0, failed: 0 },
      },
    });
    mocks.getCoordinator.mockReturnValue({ getSnapshot });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos?scope=shared&refresh=1', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      discovery: 'refreshing',
      scope: 'shared',
    });
    expect(getSnapshot).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      { scope: 'shared', refresh: true },
    );
  });
});
