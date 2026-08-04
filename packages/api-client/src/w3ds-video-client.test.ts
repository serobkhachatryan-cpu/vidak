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

describe('W3dsVideoApiClient', () => {
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
