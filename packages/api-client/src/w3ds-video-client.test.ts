import { describe, expect, it, vi } from 'vitest';
import { createVideoApiClient } from './create-video-api-client';
import { MockVideoApiClient } from './mock-video-client';
import { W3dsVideoApiClient } from './w3ds-video-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const publicAsset = {
  id: 'asset-1',
  ownerId: 'user-1',
  videoId: 'draft-1',
  originalFilename: 'clip.mp4',
  contentType: 'video/mp4',
  byteSize: 12,
  uploadState: 'ready' as const,
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
};

class FakeXMLHttpRequest {
  static last: FakeXMLHttpRequest | undefined;
  static responders: Array<(xhr: FakeXMLHttpRequest) => void> = [];

  readonly upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
  };
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  responseType = '';
  method = '';
  url = '';
  readonly headers = new Map<string, string>();
  body: unknown;
  aborted = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  send(body?: unknown) {
    this.body = body;
    FakeXMLHttpRequest.last = this;
    const responder = FakeXMLHttpRequest.responders.shift();
    if (responder) {
      queueMicrotask(() => responder(this));
      return;
    }
    queueMicrotask(() => {
      this.status = 201;
      this.responseText = JSON.stringify(publicAsset);
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: 12,
        total: 12,
      } as ProgressEvent);
      this.onload?.();
    });
  }
}

describe('W3dsVideoApiClient', () => {
  it('loads the signed-in profile from /api/auth/me instead of a mock catalogue', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) {
        return jsonResponse({
          id: 'w3ds_first-load-user',
          displayName: 'New Vidak member',
          eName: '@ada.w3id',
          eVaultId: 'evault-ada',
          profile: { displayName: 'New Vidak member' },
        });
      }
      if (url.includes('/api/auth/preferences')) {
        return jsonResponse({
          appearance: 'system',
          language: 'en',
          notifications: {
            emailMarketing: false,
            emailProductUpdates: true,
            emailComments: true,
            emailMentions: true,
            pushComments: true,
            pushMentions: true,
            pushSubscriptions: true,
          },
          privacy: {
            showActivityStatus: true,
            allowMentions: true,
            showSubscriptions: true,
            personalizedRecommendations: true,
            searchableByEmail: false,
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    const userId = 'w3ds_first-load-user';

    const [profile, preferences, connectedAccounts] = await Promise.all([
      client.getUserProfile(userId),
      client.getUserPreferences(userId),
      client.listConnectedAccounts(userId),
    ]);

    expect(profile).toMatchObject({ id: userId, displayName: 'New Vidak member' });
    expect(profile?.displayName).not.toBe('Creator');
    expect(profile?.handle.startsWith('w3ds_')).toBe(false);
    expect(preferences.appearance).toBe('system');
    expect(connectedAccounts).toEqual([]);
  });

  it('does not return another person’s profile from the current session', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 'w3ds_signed-in',
        displayName: 'Ada Lovelace',
        profile: { displayName: 'Ada Lovelace' },
      }),
    );
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.getUserProfile('w3ds_someone-else')).resolves.toBeUndefined();
  });

  it('returns empty comments instead of mock catalogue rows', async () => {
    const client = new W3dsVideoApiClient({
      fetch: async () => jsonResponse({ items: [], nextCursor: undefined }),
    });
    await expect(client.listComments('video-1')).resolves.toEqual({ items: [] });
    await expect(client.listPlaylists()).resolves.toEqual({ items: [] });
    await expect(client.createComment('video-1', { body: 'Hi' })).rejects.toMatchObject({
      code: 'feature_unavailable',
      feature: 'comments',
    });
  });

  it('filters public discovery instead of reading mock feed data', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/videos/public');
      return jsonResponse({
        items: [
          {
            id: 'v-ada',
            channelId: 'channel-ada',
            title: 'Ada lecture',
            description: '',
            thumbnailUrl: '/api/videos/public/pub_ada/thumbnail',
            durationSeconds: 12,
            status: 'published',
            visibility: 'public',
            publicVideoId: 'pub_ada',
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            viewCount: 2,
            likeCount: 0,
            commentCount: 0,
            tags: [],
          },
          {
            id: 'v-other',
            channelId: 'channel-other',
            title: 'Other clip',
            description: '',
            thumbnailUrl: '',
            durationSeconds: 8,
            status: 'published',
            visibility: 'public',
            publicVideoId: 'pub_other',
            createdAt: '2026-08-02T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
            viewCount: 9,
            likeCount: 0,
            commentCount: 0,
            tags: [],
          },
        ],
      });
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.listVideos({ search: 'Ada', status: 'published' })).resolves.toMatchObject({
      items: [{ id: 'v-ada' }],
    });
    await expect(client.getVideo('legacy-mock-id')).resolves.toBeUndefined();
  });

  it('sends cookie credentials for draft create/list/read/update/delete', async () => {
    const draft = {
      id: 'draft-1',
      channelId: 'channel-1',
      title: 'Cookie draft',
      description: '',
      thumbnailUrl: '',
      durationSeconds: 0,
      status: 'draft' as const,
      visibility: 'private' as const,
      createdAt: '2026-08-04T10:00:00.000Z',
      updatedAt: '2026-08-04T10:00:00.000Z',
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: [] as string[],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.credentials).toBe('include');
      if (url.endsWith('/api/videos/drafts') && init?.method === 'POST') {
        return jsonResponse(draft, 201);
      }
      if (url.endsWith('/api/videos/drafts') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({ items: [draft] });
      }
      if (url.endsWith('/api/videos/drafts/draft-1') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(draft);
      }
      if (url.endsWith('/api/videos/drafts/draft-1') && init?.method === 'PATCH') {
        return jsonResponse({ ...draft, title: 'Updated' });
      }
      if (url.endsWith('/api/videos/drafts/draft-1') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404);
    });

    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.createDraft({ title: 'Cookie draft' })).resolves.toMatchObject({
      id: 'draft-1',
      status: 'draft',
    });
    await expect(client.listDrafts()).resolves.toEqual([draft]);
    await expect(client.getDraft('draft-1')).resolves.toMatchObject({ id: 'draft-1' });
    await expect(client.updateDraft('draft-1', { title: 'Updated' })).resolves.toMatchObject({
      title: 'Updated',
    });
    await expect(client.deleteDraft('draft-1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('lists the signed-in creator’s videos and draft media through protected routes', async () => {
    const draft = {
      id: 'draft-1',
      channelId: 'channel-1',
      title: 'Owned draft',
      description: '',
      thumbnailUrl: '',
      durationSeconds: 0,
      status: 'draft' as const,
      visibility: 'private' as const,
      createdAt: '2026-08-04T10:00:00.000Z',
      updatedAt: '2026-08-04T10:00:00.000Z',
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: [] as string[],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('include');
      const url = String(input);
      if (url.endsWith('/api/videos/mine')) return jsonResponse({ items: [draft] });
      if (url.endsWith('/api/videos/drafts/draft-1/media')) {
        return jsonResponse({ items: [publicAsset] });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404);
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });

    await expect(client.listOwnedVideos()).resolves.toEqual([draft]);
    await expect(client.listDraftMedia('draft-1')).resolves.toEqual([publicAsset]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('binds globalThis.fetch so unbound window.fetch does not block draft create', async () => {
    const draft = {
      id: 'draft-bound',
      channelId: 'channel-1',
      title: 'Bound fetch',
      description: '',
      thumbnailUrl: '',
      durationSeconds: 0,
      status: 'draft' as const,
      visibility: 'private' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: [] as string[],
    };
    const fetchMock = vi.fn(async () => jsonResponse(draft, 201));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      // Production path: no injected fetch. Must not capture an unbound `fetch` reference.
      const client = new W3dsVideoApiClient();
      await expect(client.createDraft({ title: 'Bound fetch' })).resolves.toMatchObject({
        id: 'draft-bound',
        title: 'Bound fetch',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/videos\/drafts$/),
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not accept browser-readable tokens in the constructor or requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ items: [] }),
    );
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await client.listDrafts();
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(init?.credentials).toBe('include');
  });

  it('uploads draft media with cookie credentials, progress, and public asset metadata only', async () => {
    FakeXMLHttpRequest.responders = [];
    const progress: number[] = [];
    const client = new W3dsVideoApiClient({
      createXHR: () => new FakeXMLHttpRequest() as unknown as XMLHttpRequest,
    });

    const body = new Blob(['hello-video'], { type: 'video/mp4' });
    const uploadPromise = client.uploadDraftMedia(
      'draft-1',
      { name: 'clip.mp4', size: body.size, type: 'video/mp4', body },
      { onProgress: (event) => progress.push(event.percent) },
    );

    await Promise.resolve();
    const xhr = FakeXMLHttpRequest.last;
    expect(xhr).toBeDefined();
    expect(xhr?.method).toBe('POST');
    expect(xhr?.url).toBe('/api/videos/drafts/draft-1/media');
    expect(xhr?.withCredentials).toBe(true);
    expect(xhr?.headers.get('Content-Type')).toBe('video/mp4');
    expect(xhr?.headers.get('X-Original-Filename')).toBe('clip.mp4');
    expect(xhr?.headers.has('Content-Length')).toBe(false);
    expect(xhr?.headers.has('Authorization')).toBe(false);
    expect(xhr?.body).toBe(body);

    const asset = await uploadPromise;
    expect(asset).toEqual(publicAsset);
    expect(asset).not.toHaveProperty('storageKey');
    expect(progress.at(-1)).toBe(100);
    expect(client.draftMediaContentPath('draft-1', 'asset-1')).toBe(
      '/api/videos/drafts/draft-1/media/asset-1/content',
    );
  });

  it('cancels an in-flight media upload when aborted', async () => {
    FakeXMLHttpRequest.responders = [
      (xhr) => {
        // Leave the request hanging until abort.
        void xhr;
      },
    ];
    const controller = new AbortController();
    const client = new W3dsVideoApiClient({
      createXHR: () => new FakeXMLHttpRequest() as unknown as XMLHttpRequest,
    });
    const body = new Blob(['bytes'], { type: 'video/mp4' });
    const uploadPromise = client.uploadDraftMedia(
      'draft-1',
      { name: 'clip.mp4', size: body.size, type: 'video/mp4', body },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(uploadPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXMLHttpRequest.last?.aborted).toBe(true);
  });

  it('surfaces network failures from media upload', async () => {
    FakeXMLHttpRequest.responders = [
      (xhr) => {
        xhr.onerror?.();
      },
    ];
    const client = new W3dsVideoApiClient({
      createXHR: () => new FakeXMLHttpRequest() as unknown as XMLHttpRequest,
    });
    const body = new Blob(['bytes'], { type: 'video/mp4' });
    await expect(
      client.uploadDraftMedia('draft-1', {
        name: 'clip.mp4',
        size: body.size,
        type: 'video/mp4',
        body,
      }),
    ).rejects.toThrow(/network connection lost/i);
  });

  it('reads and deletes draft media through cookie-authenticated routes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.credentials).toBe('include');
      if (url.endsWith('/api/videos/drafts/draft-1/media/asset-1') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api/videos/drafts/draft-1/media/asset-1')) {
        return jsonResponse(publicAsset);
      }
      return jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404);
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.getDraftMedia('draft-1', 'asset-1')).resolves.toEqual(publicAsset);
    await expect(client.deleteDraftMedia('draft-1', 'asset-1')).resolves.toBeUndefined();
  });

  it('publishes, unpublishes, and reads public discovery through platform routes', async () => {
    const published = {
      id: 'draft-1',
      channelId: 'channel-1',
      title: 'Live clip',
      description: '',
      thumbnailUrl: '',
      durationSeconds: 0,
      status: 'published' as const,
      visibility: 'public' as const,
      publicVideoId: 'pub_live',
      publishedAt: '2026-08-04T12:00:00.000Z',
      createdAt: '2026-08-04T10:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: [] as string[],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/videos/draft-1/publish') && init?.method === 'POST') {
        expect(init.credentials).toBe('include');
        return jsonResponse(published);
      }
      if (url.endsWith('/api/videos/draft-1/unpublish') && init?.method === 'POST') {
        return jsonResponse({ ...published, status: 'draft', publishedAt: undefined });
      }
      if (url.includes('/api/videos/public?') || url.endsWith('/api/videos/public')) {
        return jsonResponse({ items: [published], nextCursor: 'offset:1' });
      }
      if (url.endsWith('/api/videos/public/pub_live')) {
        return jsonResponse(published);
      }
      if (url.endsWith('/api/videos/public/pub_missing')) {
        return jsonResponse({ error: { code: 'not_found', message: 'Video was not found.' } }, 404);
      }
      return jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404);
    });

    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.publishVideo('draft-1')).resolves.toMatchObject({
      publicVideoId: 'pub_live',
      status: 'published',
    });
    await expect(client.unpublishVideo('draft-1')).resolves.toMatchObject({ status: 'draft' });
    await expect(client.listPublicVideos({ limit: 2 })).resolves.toMatchObject({
      items: [published],
      nextCursor: 'offset:1',
    });
    await expect(client.getPublicVideo('pub_live')).resolves.toMatchObject({
      publicVideoId: 'pub_live',
    });
    await expect(client.getPublicVideo('pub_missing')).resolves.toBeUndefined();
    expect(client.publicMediaContentPath('pub_live', 'asset-1')).toBe(
      '/api/videos/public/pub_live/media/asset-1/content',
    );
  });

  it('resolves public media paths from the upload-session ready asset cache', async () => {
    FakeXMLHttpRequest.responders = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/videos/public/pub_live')) {
        return jsonResponse({
          id: 'draft-1',
          channelId: 'channel-1',
          title: 'Live clip',
          description: '',
          thumbnailUrl: '',
          durationSeconds: 0,
          status: 'published',
          visibility: 'public',
          publicVideoId: 'pub_live',
          publishedAt: '2026-08-04T12:00:00.000Z',
          createdAt: '2026-08-04T10:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
          viewCount: 0,
          likeCount: 0,
          commentCount: 0,
          tags: [],
        });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404);
    });
    const client = new W3dsVideoApiClient({
      fetch: fetchMock,
      createXHR: () => new FakeXMLHttpRequest() as unknown as XMLHttpRequest,
    });
    const body = new Blob(['bytes'], { type: 'video/mp4' });
    await client.uploadDraftMedia('draft-1', {
      name: 'clip.mp4',
      size: body.size,
      type: 'video/mp4',
      body,
    });
    await expect(client.resolvePublicMediaContentPath('pub_live')).resolves.toBe(
      '/api/videos/public/pub_live/media',
    );
  });

  it('resolves public media paths from mediaContentUrl without an upload-session cache', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/videos/public/pub_cold')) {
        return jsonResponse({
          id: 'draft-cold',
          channelId: 'channel-1',
          title: 'Cold watch',
          description: '',
          thumbnailUrl: '',
          durationSeconds: 0,
          status: 'published',
          visibility: 'public',
          publicVideoId: 'pub_cold',
          mediaContentUrl: '/api/videos/public/pub_cold/media',
          publishedAt: '2026-08-04T12:00:00.000Z',
          createdAt: '2026-08-04T10:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
          viewCount: 0,
          likeCount: 0,
          commentCount: 0,
          tags: [],
        });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404);
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.resolvePublicMediaContentPath('pub_cold')).resolves.toBe(
      '/api/videos/public/pub_cold/media',
    );
  });

  it('rejects media responses that leak storage keys', async () => {
    FakeXMLHttpRequest.responders = [
      (xhr) => {
        xhr.status = 201;
        xhr.responseText = JSON.stringify({ ...publicAsset, storageKey: 'media_secret' });
        xhr.onload?.();
      },
    ];
    const client = new W3dsVideoApiClient({
      createXHR: () => new FakeXMLHttpRequest() as unknown as XMLHttpRequest,
    });
    const body = new Blob(['bytes'], { type: 'video/mp4' });
    await expect(
      client.uploadDraftMedia('draft-1', {
        name: 'clip.mp4',
        size: body.size,
        type: 'video/mp4',
        body,
      }),
    ).rejects.toThrow(/forbidden storage key/i);
  });

  it('loads public channels from the platform API instead of MockVideoApiClient', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/channels/public/channel-real')) {
        return jsonResponse({
          id: 'channel-real',
          ownerId: 'user-ada',
          handle: 'ada',
          name: 'Ada Lovelace',
          subscriberCount: 12,
          videoCount: 3,
          createdAt: '2026-08-01T00:00:00.000Z',
        });
      }
      if (url.endsWith('/api/channels/public/missing')) {
        return jsonResponse({ error: { code: 'not_found' } }, 404);
      }
      return jsonResponse({ error: { code: 'not_found' } }, 404);
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.getChannel('channel-real')).resolves.toMatchObject({
      id: 'channel-real',
      name: 'Ada Lovelace',
    });
    await expect(client.getChannel('missing')).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/channels/public/channel-real');
  });

  it('lists public channels from the platform discovery route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/api/channels/public?q=Ada');
      return jsonResponse({
        items: [
          {
            id: 'channel-ada',
            ownerId: 'user-ada',
            handle: 'ada',
            name: 'Ada Lovelace',
            subscriberCount: 2,
            videoCount: 1,
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    const page = await client.listChannels({ query: 'Ada' });
    expect(page.items).toEqual([
      expect.objectContaining({ id: 'channel-ada', name: 'Ada Lovelace' }),
    ]);
  });

  it('loads and patches preferences through the auth preferences route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/preferences') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({
          appearance: 'system',
          language: 'en',
          notifications: {
            emailMarketing: false,
            emailProductUpdates: true,
            emailComments: true,
            emailMentions: true,
            pushComments: true,
            pushMentions: true,
            pushSubscriptions: true,
          },
          privacy: {
            showActivityStatus: true,
            allowMentions: true,
            showSubscriptions: true,
            personalizedRecommendations: true,
            searchableByEmail: false,
          },
        });
      }
      if (url.endsWith('/api/auth/preferences') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { appearance?: string };
        expect(body.appearance).toBe('dark');
        return jsonResponse({
          appearance: 'dark',
          language: 'en',
          notifications: {
            emailMarketing: false,
            emailProductUpdates: true,
            emailComments: true,
            emailMentions: true,
            pushComments: true,
            pushMentions: true,
            pushSubscriptions: true,
          },
          privacy: {
            showActivityStatus: true,
            allowMentions: true,
            showSubscriptions: true,
            personalizedRecommendations: true,
            searchableByEmail: false,
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.getUserPreferences('user-1')).resolves.toMatchObject({
      appearance: 'system',
    });
    await expect(
      client.updateUserPreferences('user-1', { appearance: 'dark' }),
    ).resolves.toMatchObject({
      appearance: 'dark',
    });
  });

  it('uploads avatar bytes as multipart form data', async () => {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/api/auth/avatar');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      return jsonResponse({
        id: 'user-1',
        displayName: 'Ada Lovelace',
        avatarUrl: '/api/users/user-1/avatar',
        profile: { displayName: 'Ada Lovelace', avatarUrl: '/api/users/user-1/avatar' },
      });
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(
      client.uploadUserAvatar('user-1', {
        name: 'avatar.png',
        size: 3,
        type: 'image/png',
        previewUrl: 'blob:preview',
        file,
      }),
    ).resolves.toMatchObject({
      id: 'user-1',
      avatarUrl: '/api/users/user-1/avatar',
    });
  });

  it('records a public view through the anonymous views route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/videos/public/pub_live/views') && init?.method === 'POST') {
        return jsonResponse({
          counted: true,
          video: {
            id: 'draft-1',
            channelId: 'channel-1',
            channel: { id: 'channel-1', name: 'Ada Lovelace', handle: 'ada' },
            title: 'Live clip',
            description: '',
            thumbnailUrl: '',
            durationSeconds: 0,
            status: 'published',
            visibility: 'public',
            publicVideoId: 'pub_live',
            createdAt: '2026-08-04T10:00:00.000Z',
            updatedAt: '2026-08-04T12:00:00.000Z',
            viewCount: 1,
            likeCount: 0,
            commentCount: 0,
            tags: [],
          },
        });
      }
      return jsonResponse({ error: { code: 'not_found' } }, 404);
    });
    const client = new W3dsVideoApiClient({ fetch: fetchMock });
    await expect(client.recordPublicView('pub_live')).resolves.toMatchObject({
      counted: true,
      video: { viewCount: 1, channel: { name: 'Ada Lovelace' } },
    });
  });
});

describe('createVideoApiClient', () => {
  it('preserves MockVideoApiClient for the development provider', () => {
    const client = createVideoApiClient({ provider: 'dev', dev: { delayMs: 0 } });
    expect(client).toBeInstanceOf(MockVideoApiClient);
  });

  it('selects W3dsVideoApiClient when AUTH_PROVIDER is w3ds', () => {
    const client = createVideoApiClient({ provider: 'w3ds' });
    expect(client).toBeInstanceOf(W3dsVideoApiClient);
  });
});
