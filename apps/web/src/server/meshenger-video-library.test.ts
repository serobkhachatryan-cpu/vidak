import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  createMeshengerVideoLibrary,
  createMeshengerVideoStreamId,
  verifyMeshengerVideoStreamId,
} from './meshenger-video-library';

const secret = '12345678901234567890123456789012';
const grant = {
  eName: '@person.w3id',
  fileUri: 'w3ds://file?id=@vault.w3id/file_123',
  expiresAt: Date.now() + 60_000,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function configuredLibrary() {
  return createMeshengerVideoLibrary({
    W3DS_AUTH_PLATFORM_NAME: 'vidak',
    W3DS_REGISTRY_BASE_URL: 'https://registry.example',
    W3DS_AUTH_JWT_SECRET: secret,
  });
}

describe('Meshenger video library', () => {
  it('creates an opaque signed stream id and restores only its validated reference', () => {
    const streamId = createMeshengerVideoStreamId(grant, secret);
    expect(streamId).not.toContain('http');
    expect(verifyMeshengerVideoStreamId(streamId, secret)).toEqual(grant);
  });

  it('rejects forged and expired stream ids', () => {
    const streamId = createMeshengerVideoStreamId(grant, secret);
    expect(() => verifyMeshengerVideoStreamId(`${streamId}x`, secret)).toThrow(
      expect.objectContaining({ code: 'invalid_stream' }),
    );
    expect(() =>
      verifyMeshengerVideoStreamId(
        createMeshengerVideoStreamId({ ...grant, expiresAt: Date.now() - 1 }, secret),
        secret,
      ),
    ).toThrow(expect.objectContaining({ code: 'stream_expired' }));
  });

  it('fails closed when the server-side W3DS registry configuration is missing', () => {
    expect(() =>
      createMeshengerVideoLibrary({
        W3DS_AUTH_JWT_SECRET: secret,
      }),
    ).toThrow(expect.objectContaining({ code: 'not_configured' }));
  });

  it('discovers video messages, application files, and native eVault video blobs without exposing media URLs', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      const body = JSON.parse(String(init.body)) as { variables: { ontologyId: string } };
      if (body.variables.ontologyId === '550e8400-e29b-41d4-a716-446655440004') {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'message-1',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      type: 'video',
                      fileId: 'w3ds://file?id=@person.w3id/message-video',
                      file: { filename: 'Circle update.mp4' },
                      durationSec: 12,
                      shape: 'circle',
                      createdAt: '2026-08-20T10:00:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (body.variables.ontologyId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'loose-video',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'A shared clip.mp4',
                      createdAt: '2026-08-19T10:00:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (body.variables.ontologyId === 'w3ds-file-v1') {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'native-video',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      contentType: 'video/webm',
                      filename: 'Video from another app.webm',
                      uploadedAt: '2026-08-21T10:00:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://vault.example',
      });
      expect(videos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'video-message',
            title: 'Circle update.mp4',
            shape: 'circle',
            durationSeconds: 12,
          }),
          expect.objectContaining({
            kind: 'file',
            title: 'A shared clip.mp4',
            accessScope: 'personal',
            visibility: 'private',
          }),
          expect.objectContaining({
            kind: 'file',
            title: 'Video from another app.webm',
            accessScope: 'personal',
            visibility: 'private',
          }),
        ]),
      );
      expect(JSON.stringify(videos)).not.toContain('https://');
      expect(
        fetcher.mock.calls.some(([, init]) =>
          String((init as RequestInit | undefined)?.body).includes('$ontologyId: ID!'),
        ),
      ).toBe(true);
      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({ pathname: '/platforms/certification' }),
        expect.objectContaining({ body: JSON.stringify({ platform: 'vidak' }) }),
      );
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/platforms/certification'),
      ).toHaveLength(1);
      const authenticatedRequests = fetcher.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return new Headers(init?.headers).get('Authorization') === 'Bearer registry-platform-token';
      });
      expect(authenticatedRequests).toHaveLength(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('discovers group-vault calls through chat references and keeps recording segments ordered', async () => {
    const firstSegment = 'w3ds://file?id=@group.w3id/call-part-1';
    const secondSegment = 'w3ds://file?id=@group.w3id/call-part-2';
    const groupCircle = 'w3ds://file?id=@group.w3id/circle-1';
    const memberCircle = 'w3ds://file?id=@person.w3id/circle-2';
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        if (url.searchParams.get('w3id') === '@person.w3id') {
          return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
        }
        expect(url.searchParams.get('w3id')).toBe('@group.w3id');
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      const body = JSON.parse(String(init.body)) as { variables: { ontologyId: string } };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'chat-reference-1',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-1',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables.ontologyId === 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-1',
                    ontology: body.variables.ontologyId,
                    parsed: { owner: '@group.w3id', members: ['@person.w3id'] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables.ontologyId === 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'group-call-1',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      participants: ['@person.w3id'],
                      startedAt: '2026-08-24T10:00:00.000Z',
                      durationSec: 90,
                      recording: {
                        mediaIsVideo: true,
                        mediaUri: firstSegment,
                        mediaSegments: [firstSegment, secondSegment],
                      },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'person-vault.example' &&
        body.variables.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'member-circle-message',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      type: 'circle',
                      mediaUri: memberCircle,
                      content: 'Member update',
                      createdAt: '2026-08-24T10:30:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'group-circle-message',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      type: 'circle',
                      mediaUri: groupCircle,
                      content: 'Team update',
                      createdAt: '2026-08-24T11:00:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables.ontologyId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'group-shared-video',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'Planning demo.mp4',
                      createdAt: '2026-08-24T12:00:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.hostname === 'group-vault.example' && body.variables.ontologyId === 'w3ds-file-v1') {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'group-native-video',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'Shared raw eVault clip.mp4',
                      uploadedAt: '2026-08-24T12:30:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const workspace = await configuredLibrary().listWithContext({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      const videos = workspace.items;
      expect(videos).toHaveLength(5);
      const call = videos.find((video) => video.kind === 'call-recording');
      expect(call).toEqual(
        expect.objectContaining({
          id: 'call:@group.w3id:group-call-1',
          kind: 'call-recording',
          durationSeconds: 90,
        }),
      );
      expect(
        call?.streamIds.map((streamId) => verifyMeshengerVideoStreamId(streamId, secret)),
      ).toEqual([
        expect.objectContaining({ fileUri: firstSegment, eName: '@person.w3id' }),
        expect.objectContaining({ fileUri: secondSegment, eName: '@person.w3id' }),
      ]);
      expect(videos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'video-message',
            shape: 'circle',
            title: 'Team update',
          }),
          expect.objectContaining({
            kind: 'file',
            title: 'Planning demo.mp4',
            accessScope: 'shared',
            visibility: 'shared-with-me',
          }),
          expect.objectContaining({
            kind: 'file',
            title: 'Shared raw eVault clip.mp4',
            accessScope: 'shared',
            visibility: 'shared-with-me',
          }),
        ]),
      );
      expect(workspace.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'group',
            title: 'Group',
            role: 'participant',
          }),
        ]),
      );
      expect(workspace.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'circle',
            content: 'Team update',
            chatId: 'chat-1',
          }),
        ]),
      );
      expect(
        fetcher.mock.calls.some(([url, init]) => {
          if ((url as URL).hostname !== 'group-vault.example') return false;
          const body = JSON.parse(String((init as RequestInit).body)) as {
            query: string;
            variables: { chatId?: string };
          };
          return body.query.includes('AuthorizedChatMessages') && body.variables.chatId === 'chat-1';
        }),
      ).toBe(true);
      expect(
        fetcher.mock.calls.some(([url, init]) => {
          if ((url as URL).pathname !== '/graphql') return false;
          const body = JSON.parse(String((init as RequestInit).body)) as {
            variables: { ontologyId: string };
          };
          return (
            (url as URL).hostname === 'group-vault.example' &&
            body.variables.ontologyId === 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd' &&
            new Headers((init as RequestInit).headers).get('X-ENAME') === '@group.w3id'
          );
        }),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a private IPv6 media destination before the player can proxy it', async () => {
    const streamId = createMeshengerVideoStreamId(
      { ...grant, fileUri: 'w3ds://file?id=@vault.w3id/file_123' },
      secret,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve')
          return json({ ename: '@vault.w3id', uri: 'https://vault.example' });
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: {
            metaEnvelope: {
              id: 'file_123',
              ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              parsed: { publicUrl: 'https://[::1]/video.mp4' },
            },
          },
        });
      }),
    );

    try {
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId),
      ).rejects.toThrow(expect.objectContaining({ code: 'unsafe_media_url' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reuses a resolved media URL for repeated byte-range requests from the same signed grant', async () => {
    const cachedGrant = {
      eName: '@cache-test.w3id',
      fileUri: 'w3ds://file?id=@vault.w3id/cache-file',
      expiresAt: Date.now() + 60_000,
    };
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve')
        return json({ ename: '@vault.w3id', uri: 'https://vault.example' });
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      return json({
        data: {
          metaEnvelope: {
            id: 'cache-file',
            ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            parsed: { publicUrl: 'https://media.example/video.mp4' },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const library = configuredLibrary();
      const streamId = createMeshengerVideoStreamId(cachedGrant, secret);
      await expect(library.resolveMediaUrl({ eName: cachedGrant.eName }, streamId)).resolves.toBe(
        'https://media.example/video.mp4',
      );
      await expect(library.resolveMediaUrl({ eName: cachedGrant.eName }, streamId)).resolves.toBe(
        'https://media.example/video.mp4',
      );
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refreshes a cached media URL after the source rejects an expired signed URL', async () => {
    const staleGrant = {
      eName: '@cache-reset.w3id',
      fileUri: 'w3ds://file?id=@vault.w3id/reset-file',
      expiresAt: Date.now() + 60_000,
    };
    let readCount = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve')
        return json({ ename: '@vault.w3id', uri: 'https://vault.example' });
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      readCount += 1;
      return json({
        data: {
          metaEnvelope: {
            id: 'reset-file',
            ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            parsed: {
              publicUrl:
                readCount === 1
                  ? 'https://media.example/expired.mp4'
                  : 'https://media.example/refreshed.mp4',
            },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const library = configuredLibrary();
      const streamId = createMeshengerVideoStreamId(staleGrant, secret);
      await expect(library.resolveMediaUrl({ eName: staleGrant.eName }, streamId)).resolves.toBe(
        'https://media.example/expired.mp4',
      );
      library.invalidateMediaUrl({ eName: staleGrant.eName }, streamId);
      await expect(library.resolveMediaUrl({ eName: staleGrant.eName }, streamId)).resolves.toBe(
        'https://media.example/refreshed.mp4',
      );
      expect(readCount).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lists an owned eVault video as a private library card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        if (String(init.body ?? '').includes('w3ds-file-v1')) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'owned-clip',
                      ontology: 'w3ds-file-v1',
                      parsed: {
                        contentType: 'video/mp4',
                        filename: 'Owned studio clip.mp4',
                        uploadedAt: '2026-08-21T10:00:00.000Z',
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (String(_url.pathname) === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://vault.example',
      });
      expect(videos).toEqual([
        expect.objectContaining({
          kind: 'file',
          title: 'Owned studio clip.mp4',
          accessScope: 'personal',
          visibility: 'private',
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never returns a call recording the signed-in person did not join', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        if (String(init.body ?? '').includes('e815ba40-ef85-4a2b-b6cf-e05a86d4afbd')) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'other-call',
                      ontology: 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd',
                      parsed: {
                        participants: ['@someone-else.w3id'],
                        initiator: '@someone-else.w3id',
                        recording: {
                          mediaIsVideo: true,
                          mediaUri: 'w3ds://file?id=@person.w3id/secret-call',
                        },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (String(_url.pathname) === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://vault.example',
      });
      expect(videos).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns one card when the same file is bound as a message and a raw eVault blob', async () => {
    const fileUri = 'w3ds://file?id=@person.w3id/same-clip';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        const body = String(init.body ?? '');
        if (body.includes('550e8400-e29b-41d4-a716-446655440004')) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'message-same',
                      ontology: '550e8400-e29b-41d4-a716-446655440004',
                      parsed: {
                        type: 'video',
                        fileId: fileUri,
                        file: { filename: 'Same clip.mp4' },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (body.includes('w3ds-file-v1')) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'same-clip',
                      ontology: 'w3ds-file-v1',
                      parsed: { contentType: 'video/mp4', filename: 'Same clip.mp4' },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (String(_url.pathname) === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://vault.example',
      });
      expect(videos).toHaveLength(1);
      expect(videos[0]).toEqual(
        expect.objectContaining({
          kind: 'video-message',
          title: 'Same clip.mp4',
          visibility: 'private',
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never returns a group-vault video after membership is gone', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'stale-chat-reference',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-1',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables?.ontologyId === 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-1',
                    ontology: body.variables.ontologyId,
                    parsed: { owner: '@group.w3id', members: ['@someone-else.w3id'] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.hostname === 'group-vault.example') {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'secret-file',
                    ontology: 'w3ds-file-v1',
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'Must not appear.mp4',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      expect(videos).toEqual([]);
      expect(
        fetcher.mock.calls.some(
          ([url, init]) =>
            (url as URL).hostname === 'group-vault.example' &&
            String((init as RequestInit).body ?? '').includes('w3ds-file-v1'),
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('inventories an official type=file attachment when the viewer is authorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        const body = String(init.body ?? '');
        if (body.includes('550e8400-e29b-41d4-a716-446655440004')) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'file-message-1',
                      ontology: '550e8400-e29b-41d4-a716-446655440004',
                      parsed: {
                        type: 'file',
                        mediaUrl: 'w3ds://file?id=@person.w3id/briefing',
                        file: { name: 'Briefing.mp4' },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (String(_url.pathname) === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://vault.example',
      });
      expect(videos).toEqual([
        expect.objectContaining({
          kind: 'video-message',
          title: 'Briefing.mp4',
          accessScope: 'personal',
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps historical group media when current membership is missing', async () => {
    const historicalFile = 'w3ds://file?id=@alumni.w3id/old-clip';
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        const w3id = url.searchParams.get('w3id');
        if (w3id === '@alumni.w3id')
          return json({ ename: '@alumni.w3id', uri: 'https://alumni-vault.example' });
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as {
        query?: string;
        variables?: { ontologyId?: string; chatId?: string };
      };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'historical-chat-reference',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-1',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'kept-message',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      senderEName: '@alumni.w3id',
                      type: 'text',
                      content: 'Earlier note',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables?.ontologyId === 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-1',
                    ontology: body.variables.ontologyId,
                    parsed: { owner: '@group.w3id', members: ['@someone-else.w3id'] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'alumni-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'alumni-file',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      type: 'file',
                      mediaUrl: historicalFile,
                      file: { name: 'Earlier briefing.mp4' },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const workspace = await configuredLibrary().listWithContext({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      expect(workspace.items).toEqual([
        expect.objectContaining({
          kind: 'video-message',
          title: 'Earlier briefing.mp4',
          accessScope: 'shared',
        }),
      ]);
      expect(
        fetcher.mock.calls.some(
          ([url, init]) =>
            (url as URL).hostname === 'group-vault.example' &&
            String((init as RequestInit).body ?? '').includes('w3ds-file-v1'),
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns a partial completeness state when one shared source fails', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        if (url.searchParams.get('w3id') === '@missing.w3id') {
          return new Response('not found', { status: 404 });
        }
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-ok',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-ok',
                      type: 'group',
                    },
                  },
                },
                {
                  node: {
                    id: 'ref-missing',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@missing.w3id',
                      canonicalChatId: 'chat-missing',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables?.ontologyId === 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-ok',
                    ontology: body.variables.ontologyId,
                    parsed: { owner: '@group.w3id', members: ['@person.w3id'] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ok-file',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-ok',
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@group.w3id/ok-clip',
                      file: { name: 'Indexed clip.mp4' },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const workspace = await configuredLibrary().listWithContext({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      expect(workspace.items).toEqual([
        expect.objectContaining({ title: 'Indexed clip.mp4', accessScope: 'shared' }),
      ]);
      expect(workspace.completeness).toEqual({
        indexed: 1,
        expected: 2,
        denied: 0,
        missing: 1,
        complete: true,
        retryNeeded: false,
      });
      const serialized = JSON.stringify(workspace.completeness);
      expect(serialized).not.toMatch(/@missing|@group|chat-ok|Indexed clip/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads every message page instead of treating the first page as the full list', async () => {
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      if (String(_url.pathname) === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      const body = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { ontologyId?: string; after?: string | null };
      };
      if (body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004') {
        if (!body.variables.after) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'page-1',
                      ontology: body.variables.ontologyId,
                      parsed: {
                        type: 'file',
                        mediaUrl: 'w3ds://file?id=@person.w3id/page-1',
                        file: { name: 'First page.mp4' },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
              },
            },
          });
        }
        expect(body.variables.after).toBe('cursor-2');
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'page-2',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@person.w3id/page-2',
                      file: { name: 'Second page.mp4' },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://vault.example',
      });
      expect(videos.map((video) => video.title).sort()).toEqual(['First page.mp4', 'Second page.mp4']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('indexes a group after a GroupManifest read fails if chat messages still return', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve')
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-1',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-1',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (body.variables?.ontologyId === 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e') {
        return json({ errors: [{ message: 'access denied', extensions: { code: 'FORBIDDEN' } }] });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'kept-file',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@group.w3id/kept-clip',
                      file: { name: 'Kept clip.mp4' },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const workspace = await configuredLibrary().listWithContext({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      expect(workspace.items).toEqual([
        expect.objectContaining({ title: 'Kept clip.mp4', accessScope: 'shared' }),
      ]);
      expect(workspace.completeness).toEqual({
        indexed: 1,
        expected: 1,
        denied: 0,
        missing: 0,
        complete: true,
        retryNeeded: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the Registry canonical eName as X-ENAME when resolve returns an alias', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: '@canonical.w3id', uri: 'https://group-vault.example' });
      }
      const headers = new Headers((init as RequestInit).headers);
      if (url.hostname === 'group-vault.example') {
        expect(headers.get('X-ENAME')).toBe('@canonical.w3id');
      }
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-alias',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@alias.w3id',
                      canonicalChatId: 'chat-1',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'alias-file',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@canonical.w3id/alias-clip',
                      file: { name: 'Alias clip.mp4' },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const workspace = await configuredLibrary().listWithContext({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      expect(workspace.items).toEqual([
        expect.objectContaining({ title: 'Alias clip.mp4', accessScope: 'shared' }),
      ]);
      expect(workspace.completeness.indexed).toBe(1);
      expect(workspace.completeness.retryNeeded).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps accessible GraphQL data when errors[] is also present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init: RequestInit) => {
        if (String(_url.pathname) === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        const body = String(init.body ?? '');
        if (body.includes('550e8400-e29b-41d4-a716-446655440004')) {
          return json({
            errors: [{ message: 'one envelope was not visible' }],
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'visible-file',
                      ontology: '550e8400-e29b-41d4-a716-446655440004',
                      parsed: {
                        type: 'file',
                        mediaUrl: 'w3ds://file?id=@person.w3id/visible',
                        file: { name: 'Visible clip.mp4' },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );

    try {
      const videos = await configuredLibrary().list({
        eName: '@person.w3id',
        eVaultUri: 'https://vault.example',
      });
      expect(videos).toEqual([expect.objectContaining({ title: 'Visible clip.mp4' })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('counts a forbidden shared vault as denied, not as a retry', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve')
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-denied',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-1',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.hostname === 'group-vault.example') {
        return new Response('forbidden', { status: 403 });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const workspace = await configuredLibrary().listWithContext({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      expect(workspace.items).toEqual([]);
      expect(workspace.completeness).toEqual({
        indexed: 0,
        expected: 1,
        denied: 1,
        missing: 0,
        complete: true,
        retryNeeded: false,
      });
      expect(
        fetcher.mock.calls.some(
          ([url, init]) =>
            (url as URL).hostname === 'group-vault.example' &&
            String((init as RequestInit).body ?? '').includes('w3ds-file-v1'),
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('indexes a group when a historical author vault is forbidden', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        const w3id = url.searchParams.get('w3id');
        if (w3id === '@alumni.w3id')
          return json({ ename: '@alumni.w3id', uri: 'https://alumni-vault.example' });
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.hostname === 'alumni-vault.example') return new Response('forbidden', { status: 403 });
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-ok',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-1',
                      type: 'group',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'note',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      senderEName: '@alumni.w3id',
                      type: 'text',
                      content: 'Earlier note',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'group-vault.example' &&
        body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'group-file',
                    ontology: body.variables.ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@group.w3id/group-clip',
                      file: { name: 'Group clip.mp4' },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const workspace = await configuredLibrary().listWithContext({
        eName: '@person.w3id',
        eVaultUri: 'https://person-vault.example',
      });
      expect(workspace.items).toEqual([
        expect.objectContaining({ title: 'Group clip.mp4', accessScope: 'shared' }),
      ]);
      expect(workspace.completeness).toEqual({
        indexed: 1,
        expected: 1,
        denied: 0,
        missing: 0,
        complete: true,
        retryNeeded: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
