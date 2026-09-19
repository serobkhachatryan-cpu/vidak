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
      peekCachedLibraryPreview: vi.fn().mockResolvedValue('processing'),
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
        {
          id: 'w3ds-file:@group.w3id/video-2',
          kind: 'file',
          title: 'Shared video reference',
          accessScope: 'shared',
          visibility: 'shared-with-me',
          streamIds: ['shared-stream-id'],
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
    const scheduleLibraryBackfill = vi.fn().mockResolvedValue(undefined);
    mocks.getPreviewService.mockReturnValue({
      peekLibraryPreview: vi.fn().mockResolvedValue('ready'),
      peekCachedLibraryPreview: vi.fn().mockResolvedValue('ready'),
      scheduleLibraryBackfill,
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
    expect(body.items[1]).toMatchObject({
      id: 'w3ds-file:@group.w3id/video-2',
      previewState: 'ready',
      previewUrl: '/api/evault/videos/shared-stream-id/preview',
    });
    expect(JSON.stringify(body)).not.toMatch(/w3ds:\/\/file|https:\/\/media|Bearer/i);
    expect(getSnapshot).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      { scope: 'owned', refresh: false },
    );
    expect(mocks.getPreviewService).toHaveBeenCalled();
    expect(scheduleLibraryBackfill).toHaveBeenCalledWith({ eName: '@person.w3id' }, [
      expect.objectContaining({
        id: 'w3ds-file:@person.w3id/video-1',
        streamIds: ['opaque-stream-id'],
      }),
      expect.objectContaining({
        id: 'w3ds-file:@group.w3id/video-2',
        streamIds: ['shared-stream-id'],
      }),
    ]);
  });

  it('returns one exact watch item without fanning preview/status work across the library', async () => {
    const items = [
      {
        id: 'w3ds-file:@person.w3id/personal-video',
        kind: 'file',
        title: 'Personal video',
        accessScope: 'personal',
        visibility: 'private',
        streamIds: ['personal-stream'],
      },
      {
        id: 'w3ds-file:@owner.w3id/shared-video',
        kind: 'call-recording',
        title: 'Shared recording',
        accessScope: 'shared',
        visibility: 'shared-with-me',
        streamIds: ['shared-stream'],
      },
      {
        id: 'w3ds-file:@person.w3id/another-video',
        kind: 'file',
        title: 'Another personal video',
        accessScope: 'personal',
        visibility: 'private',
        streamIds: ['another-stream'],
      },
    ];
    const getSnapshot = vi.fn().mockResolvedValue({
      items,
      conversations: [{ id: 'internal-conversation' }],
      messages: [{ id: 'internal-message' }],
      completeness: {
        indexed: 3,
        expected: 3,
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
        firstResultMs: 1,
        completionMs: 1,
        sourceCounts: { personalPages: 1, sharedSpaces: 1, failed: 0 },
      },
    });
    const getItem = vi.fn().mockResolvedValue(items[1]);
    const scheduleLibraryBackfill = vi.fn().mockResolvedValue(undefined);
    mocks.getCoordinator.mockReturnValue({ getItem, getSnapshot });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });
    mocks.getPreviewService.mockReturnValue({
      peekLibraryPreview: vi.fn().mockResolvedValue('ready'),
      peekCachedLibraryPreview: vi.fn().mockResolvedValue('ready'),
      scheduleLibraryBackfill,
    });

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/videos?scope=all&itemId=w3ds-file%3A%40owner.w3id%2Fshared-video',
        { headers: { authorization: 'Bearer access-token' } },
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      items: [
        {
          id: 'w3ds-file:@owner.w3id/shared-video',
          title: 'Shared recording',
          streamIds: ['shared-stream'],
        },
      ],
      conversations: [],
      messages: [],
      scope: 'all',
    });
    expect(body.items[0].previewState).toBeUndefined();
    expect(body.items[0].previewUrl).toBeUndefined();
    expect(mocks.getPreviewService).not.toHaveBeenCalled();
    expect(scheduleLibraryBackfill).not.toHaveBeenCalled();
    expect(getItem).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      {
        itemId: 'w3ds-file:@owner.w3id/shared-video',
        scope: 'all',
        refresh: false,
      },
    );
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('treats an unknown or unsafe itemId as an exact miss without loading previews', async () => {
    const getSnapshot = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'w3ds-file:@person.w3id/video-1',
          kind: 'file',
          title: 'Authorized personal video',
          accessScope: 'personal',
          visibility: 'private',
          streamIds: ['opaque-stream-id'],
        },
      ],
      conversations: [],
      messages: [],
      completeness: {
        indexed: 1,
        expected: 1,
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
        firstResultMs: 1,
        sourceCounts: { personalPages: 1, sharedSpaces: 0, failed: 0 },
      },
    });
    const getItem = vi.fn();
    mocks.getCoordinator.mockReturnValue({ getItem, getSnapshot });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos?itemId=%00', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ items: [] });
    expect(mocks.getPreviewService).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
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

  it('queues every eligible shared card for bounded preview repair', async () => {
    const sharedItems = Array.from({ length: 9 }, (_, index) => ({
      id: `w3ds-file:@owner.w3id/shared-${index}`,
      kind: 'file' as const,
      title: `Shared recording ${index + 1}`,
      accessScope: 'shared' as const,
      visibility: 'shared-with-me' as const,
      streamIds: [`shared-stream-${index}`],
    }));
    const getSnapshot = vi.fn().mockResolvedValue({
      items: sharedItems,
      conversations: [],
      messages: [],
      completeness: {
        indexed: 9,
        expected: 9,
        denied: 0,
        missing: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
      },
      discovery: 'complete',
      scope: 'shared',
      metrics: {
        cache: 'hit',
        firstResultMs: 1,
        completionMs: 1,
        sourceCounts: { personalPages: 0, sharedSpaces: 1, failed: 0 },
      },
    });
    const scheduleLibraryBackfill = vi.fn().mockResolvedValue(undefined);
    mocks.getCoordinator.mockReturnValue({ getSnapshot });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });
    mocks.getPreviewService.mockReturnValue({
      peekLibraryPreview: vi.fn().mockResolvedValue('processing'),
      peekCachedLibraryPreview: vi.fn().mockResolvedValue('processing'),
      scheduleLibraryBackfill,
    });

    await GET(
      new NextRequest('https://vidak.example/api/evault/videos?scope=shared', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );

    expect(scheduleLibraryBackfill).toHaveBeenCalledWith({ eName: '@person.w3id' }, sharedItems);
  });

  it('keeps the catalogue available when one card preview cannot be inspected', async () => {
    const getSnapshot = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'w3ds-file:@person.w3id/video-1',
          kind: 'file',
          title: 'Authorized personal video',
          accessScope: 'personal',
          visibility: 'private',
          streamIds: ['opaque-stream-id'],
        },
      ],
      conversations: [],
      messages: [],
      completeness: {
        indexed: 1,
        expected: 1,
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
        sourceCounts: { personalPages: 1, sharedSpaces: 0, failed: 0 },
      },
    });
    mocks.getCoordinator.mockReturnValue({ getSnapshot });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });
    mocks.getPreviewService.mockReturnValue({
      peekLibraryPreview: vi.fn().mockRejectedValue(new Error('preview store unavailable')),
      peekCachedLibraryPreview: vi.fn().mockResolvedValue('processing'),
      scheduleLibraryBackfill: vi.fn().mockResolvedValue(undefined),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos?scope=all', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          id: 'w3ds-file:@person.w3id/video-1',
          previewState: 'unavailable',
          previewUrl: '/api/evault/videos/opaque-stream-id/preview',
        },
      ],
    });
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
