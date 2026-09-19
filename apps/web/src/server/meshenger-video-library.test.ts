import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  type EVaultMediaUrlCache,
  InMemoryEVaultMediaUrlCache,
  setEVaultMediaUrlCacheForTests,
} from './evault-media-url-cache';
import {
  compactMediaSourceMetadata,
  createMeshengerVideoLibrary,
  createMeshengerVideoStreamId,
  type MediaAuthorizationTimingContext,
  MeshengerVideoLibraryError,
  resetMeshengerVideoLibraryCachesForTests,
  verifyMeshengerVideoStreamId,
} from './meshenger-video-library';
import { mintSharedVideoAuthorizationReceipt } from './shared-video-authorization-receipt';
import { backgroundWorkDelayMs, beginBackgroundWork } from './video-space/background-work-priority';
import { VIDEO_SPACE_CATALOGUE_VERSION } from './video-space/catalogue-version';
import {
  completeInventory,
  emptyInventoryCoverage,
  emptyInventoryMediaCounts,
} from './video-space/completeness';
import {
  documentedAuthorizationOntologies,
  documentedOntologyId,
} from './video-space/documented-sources';
import { beginInteractiveEVaultTrafficSession } from './video-space/evault-traffic-governor';
import { createMemoryInventoryJobStore } from './video-space/job-store';
import {
  rememberVerifiedSharedAccess,
  resetSharedAccessCacheForTests,
} from './video-space/shared-access-cache';
import { titleFromFilename } from './video-space/titles';
import { InMemoryViewerChatGrantPointerStore } from './video-space/viewer-chat-grant-pointer-store';

const t = (filename: string) => titleFromFilename(filename) ?? filename;

const secret = '12345678901234567890123456789012';
const grant = {
  eName: '@person.w3id',
  fileUri: 'w3ds://file?id=@person.w3id/file_123',
  accessScope: 'personal' as const,
  expiresAt: Date.now() + 60_000,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rateLimited(retryAfter = '0'): Response {
  return new Response('too many requests', {
    status: 429,
    headers: { 'Retry-After': retryAfter },
  });
}

function configuredLibrary() {
  return createMeshengerVideoLibrary({
    W3DS_AUTH_PLATFORM_NAME: 'vidak',
    W3DS_REGISTRY_BASE_URL: 'https://registry.example',
    W3DS_AUTH_JWT_SECRET: secret,
  });
}

function historySharedStream(fileId: string): string {
  return createMeshengerVideoStreamId(
    {
      ...grant,
      fileUri: `w3ds://file?id=@friend.w3id/${fileId}`,
      accessScope: 'shared',
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'history-chat',
      sourceViewerChatGrantId: 'viewer-history-chat-grant',
      accessBasis: 'history',
    },
    secret,
  );
}

function exactGroupCallHistoryStream(fileId: string, expiresAt = Date.now() + 60_000): string {
  return createMeshengerVideoStreamId(
    {
      ...grant,
      fileUri: `w3ds://file?id=@media.w3id/${fileId}`,
      accessScope: 'shared',
      sourceSpaceKey: '@group.w3id',
      sourceChatId: 'group-chat',
      sourceCallSessionId: 'group-call-1',
      sourceCallSessionVault: '@group.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'group',
      accessBasis: 'history',
      expiresAt,
    },
    secret,
  );
}

function stubInteractivePlatformToken(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) => {
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }),
  );
}

type SharedAccessResult = {
  access: 'ok' | 'denied' | 'missing' | 'retry';
  member: boolean;
};

type DirectProbeInternals = {
  probeDirectSourceChatAccess: (
    user: unknown,
    space: unknown,
    rateLimit: unknown,
    signal?: AbortSignal,
    chatSignal?: AbortSignal,
  ) => Promise<SharedAccessResult>;
  probeViewerChatGrantAccess: (
    user: unknown,
    source: unknown,
    rateLimit: unknown,
    signal?: AbortSignal,
    chatSignal?: AbortSignal,
  ) => Promise<SharedAccessResult>;
  findInteractiveViewerChatGrantAuthorizationEnvelopes: (
    owner: string,
    eVaultUri: string,
    source: { eName: string; chatId: string; viewerChatGrantId: string },
    viewerEName: string,
    rateLimit: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown[]>;
};

type ExactCallProofInternals = {
  resolveExactSharedCallAuthorization: (
    user: { eName: string; eVaultUri?: string },
    grant: unknown,
    priority: 'interactive' | 'warmup' | 'preview' | 'background',
    signal?: AbortSignal,
  ) => Promise<'not_eligible' | 'verified' | 'denied' | 'retry'>;
  resolveViewerEVault: (
    user: unknown,
    rateLimit: unknown,
    signal?: AbortSignal,
  ) => Promise<{ ownerEName: string; eVaultUri: string }>;
  resolveEVault: (
    eName: string,
    rateLimit: unknown,
    signal?: AbortSignal,
  ) => Promise<{ ownerEName: string; eVaultUri: string }>;
  resolveEVaultLookup: (
    eName: string,
    rateLimit: unknown,
    signal?: AbortSignal,
  ) => Promise<{ vault: { ownerEName: string; eVaultUri: string }; cacheHit: boolean }>;
  readEnvelope: (
    owner: string,
    eVaultUri: string,
    id: string,
    rateLimit?: unknown,
    actingEName?: string,
    signal?: AbortSignal,
  ) => Promise<{ id: string; ontology: string; parsed: Record<string, unknown> }>;
  resolveExactUserParticipant: (
    participantId: string,
    expectedEName: string,
    expectedVault: { ownerEName: string; eVaultUri: string },
    rateLimit: unknown,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  graphql: (
    owner: string,
    eVaultUri: string,
    query: string,
    variables: Record<string, unknown>,
    rateLimit?: unknown,
    actingEName?: string,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  tryDereferenceFileMediaUrl: (
    vault: unknown,
    metaEnvelopeId: string,
    policy: unknown,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
};

function directProbeInternals(library: ReturnType<typeof configuredLibrary>): DirectProbeInternals {
  return library as unknown as DirectProbeInternals;
}

function exactCallProofInternals(
  library: ReturnType<typeof configuredLibrary>,
): ExactCallProofInternals {
  return library as unknown as ExactCallProofInternals;
}

describe('Meshenger video library', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setEVaultMediaUrlCacheForTests();
    resetSharedAccessCacheForTests();
    resetMeshengerVideoLibraryCachesForTests();
  });

  it('keeps deferred resolver metadata small while retaining title and media hints', () => {
    const metadata = compactMediaSourceMetadata({
      type: 'file',
      title: 'A useful title',
      chatId: 'chat-1',
      content: 'x'.repeat(5_000),
      file: {
        filename: 'friends-with-hats.mp4',
        mimeType: 'video/mp4',
        opaquePayload: 'x'.repeat(5_000),
      },
      unrelatedHistory: Array.from({ length: 500 }, () => ({ body: 'x'.repeat(500) })),
    });

    expect(metadata).toMatchObject({
      type: 'file',
      title: 'A useful title',
      chatId: 'chat-1',
      file: { filename: 'friends-with-hats.mp4', mimeType: 'video/mp4' },
    });
    expect(metadata.content).toHaveLength(512);
    expect('unrelatedHistory' in metadata).toBe(false);
    expect(JSON.stringify(metadata).length).toBeLessThan(2_000);
  });

  it('creates an opaque signed stream id and restores only its validated reference', () => {
    const streamId = createMeshengerVideoStreamId(grant, secret);
    expect(streamId).not.toContain('http');
    expect(streamId).not.toContain('@person.w3id');
    expect(streamId.split('.')).toHaveLength(4);
    expect(verifyMeshengerVideoStreamId(streamId, secret)).toEqual(grant);
  });

  it('seals a viewer Chat-grant hint inside a shared stream without exposing it', () => {
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@friend.w3id/shared-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@friend.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const streamId = createMeshengerVideoStreamId(sharedGrant, secret);

    expect(streamId).not.toContain('viewer-chat-grant');
    expect(streamId).not.toContain('call-session-1');
    expect(verifyMeshengerVideoStreamId(streamId, secret)).toEqual(sharedGrant);
  });

  it('seals a current GroupManifest pointer only for an eligible group grant', () => {
    const groupGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/shared-recording',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@group.w3id',
      sourceChatId: 'group-chat',
      sourceCallSessionId: 'group-call-1',
      sourceCallSessionVault: '@group.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'group' as const,
      sourceGroupManifestId: 'current-group-manifest',
      accessBasis: 'history' as const,
    };
    const streamId = createMeshengerVideoStreamId(groupGrant, secret);

    expect(streamId).not.toContain('current-group-manifest');
    expect(verifyMeshengerVideoStreamId(streamId, secret)).toEqual(groupGrant);

    const invalidContextStream = createMeshengerVideoStreamId(
      {
        ...groupGrant,
        sourceChatKind: 'direct' as const,
      },
      secret,
    );
    const restoredDirectGrant = verifyMeshengerVideoStreamId(invalidContextStream, secret);
    expect(restoredDirectGrant.sourceChatKind).toBe('direct');
    expect(restoredDirectGrant.sourceGroupManifestId).toBeUndefined();
  });

  it('seals a server-only stale-card binding with a shared stream grant', () => {
    const sharedCardBindingHash = 'a'.repeat(43);
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@friend.w3id/shared-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      accessBasis: 'history' as const,
      sharedCardBindingHash,
    };
    const streamId = createMeshengerVideoStreamId(sharedGrant, secret);

    expect(streamId).not.toContain(sharedCardBindingHash);
    expect(verifyMeshengerVideoStreamId(streamId, secret)).toEqual(sharedGrant);
  });

  it('uses exactly three records for a fully-addressed direct shared CallSession', async () => {
    const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/full-recording',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      // The CallSession/Chat live in the friend's vault while the recording
      // bytes live in a different vault. This must remain a supported shape.
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
      ownerEName: viewer.eName,
      eVaultUri: viewer.eVaultUri,
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@friend.w3id',
      eVaultUri: 'https://friend-vault.example',
    });
    vi.spyOn(internals, 'resolveEVaultLookup').mockResolvedValue({
      vault: { ownerEName: '@media.w3id', eVaultUri: 'https://media-vault.example' },
      cacheHit: false,
    });
    const readEnvelope = vi
      .spyOn(internals, 'readEnvelope')
      .mockImplementation(async (_owner, _vault, id) => {
        if (id === 'viewer-chat-grant') {
          return {
            id,
            ontology: documentedAuthorizationOntologies.chat,
            parsed: {
              isReference: true,
              type: 'direct',
              canonicalOwnerEName: '@friend.w3id',
              canonicalChatId: 'chat-1',
            },
          };
        }
        if (id === 'chat-1') {
          return {
            id,
            ontology: documentedAuthorizationOntologies.chat,
            parsed: {
              type: 'direct',
              participantIds: [viewer.eName, '@friend.w3id'],
            },
          };
        }
        if (id === 'call-session-1') {
          return {
            id,
            ontology: documentedOntologyId('call-recording'),
            parsed: {
              chatId: 'chat-1',
              participants: [viewer.eName, '@friend.w3id'],
              recording: {
                mediaIsVideo: true,
                recordingVault: '@media.w3id',
                mediaUri: sharedGrant.fileUri,
              },
            },
          };
        }
        throw new Error(`Unexpected envelope read: ${id}`);
      });
    const dereference = vi
      .spyOn(internals, 'tryDereferenceFileMediaUrl')
      .mockResolvedValue('https://media.example/full-recording.mp4');
    const legacyProbe = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(
      library.resolveMediaUrl(viewer, createMeshengerVideoStreamId(sharedGrant, secret)),
    ).resolves.toBe('https://media.example/full-recording.mp4');

    expect(readEnvelope).toHaveBeenCalledTimes(3);
    expect(readEnvelope.mock.calls.map((call) => call[2]).sort()).toEqual([
      'call-session-1',
      'chat-1',
      'viewer-chat-grant',
    ]);
    expect(legacyProbe).not.toHaveBeenCalled();
    expect(dereference).toHaveBeenCalledTimes(1);
  });

  it('proves opaque legacy direct participants with only exact User-envelope reads', async () => {
    const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/legacy-identity-recording',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
      ownerEName: viewer.eName,
      eVaultUri: viewer.eVaultUri,
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@friend.w3id',
      eVaultUri: 'https://friend-vault.example',
    });
    const readEnvelope = vi
      .spyOn(internals, 'readEnvelope')
      .mockImplementation(async (_owner, _vault, id) => {
        if (id === 'viewer-chat-grant') {
          return {
            id,
            ontology: documentedAuthorizationOntologies.chat,
            parsed: {
              isReference: true,
              type: 'direct',
              canonicalOwnerEName: '@friend.w3id',
              canonicalChatId: 'chat-1',
            },
          };
        }
        if (id === 'chat-1') {
          return {
            id,
            ontology: documentedAuthorizationOntologies.chat,
            parsed: {
              type: 'direct',
              participantIds: ['viewer-user-envelope', 'friend-user-envelope'],
            },
          };
        }
        if (id === 'call-session-1') {
          return {
            id,
            ontology: documentedOntologyId('call-recording'),
            parsed: {
              chatId: 'chat-1',
              participants: [viewer.eName, '@friend.w3id'],
              recording: {
                mediaIsVideo: true,
                recordingVault: '@media.w3id',
                mediaUri: sharedGrant.fileUri,
              },
            },
          };
        }
        if (id === 'viewer-user-envelope') {
          return {
            id,
            ontology: '550e8400-e29b-41d4-a716-446655440000',
            parsed: { id, eName: viewer.eName },
          };
        }
        if (id === 'friend-user-envelope') {
          return {
            id,
            ontology: '550e8400-e29b-41d4-a716-446655440000',
            parsed: { id, eName: '@friend.w3id' },
          };
        }
        throw new Error(`Unexpected envelope read: ${id}`);
      });
    const legacyProbe = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(
      internals.resolveExactSharedCallAuthorization(viewer, sharedGrant, 'interactive'),
    ).resolves.toBe('verified');

    // Three authorization records plus both possible participant-order
    // assignments: all reads are named exact records, never a Chat history.
    expect(readEnvelope).toHaveBeenCalledTimes(7);
    expect(legacyProbe).not.toHaveBeenCalled();
  });

  it('maps an opaque User envelope id only from the expected owner vault', async () => {
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    const readEnvelope = vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'viewer-user-envelope',
      ontology: '550e8400-e29b-41d4-a716-446655440000',
      parsed: { id: 'viewer-user-envelope' },
    });
    const graphql = vi.spyOn(internals, 'graphql');

    await expect(
      internals.resolveExactUserParticipant(
        'viewer-user-envelope',
        '@person.w3id',
        { ownerEName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' },
        'interactive',
      ),
    ).resolves.toBe(true);

    expect(readEnvelope).toHaveBeenCalledOnce();
    expect(readEnvelope).toHaveBeenCalledWith(
      '@person.w3id',
      'https://viewer-vault.example',
      'viewer-user-envelope',
      'interactive',
      undefined,
      undefined,
    );
    expect(graphql).not.toHaveBeenCalled();
  });

  it('uses one exact User.id lookup when a legacy chat stores the User body id', async () => {
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'readEnvelope').mockRejectedValue(new Error('not an envelope id'));
    const graphql = vi.spyOn(internals, 'graphql').mockResolvedValue({
      metaEnvelopes: {
        edges: [
          {
            node: {
              id: 'viewer-user-envelope',
              ontology: '550e8400-e29b-41d4-a716-446655440000',
              parsed: JSON.stringify({ id: 'viewer-user-body-id', eName: '@person.w3id' }),
              envelopes: [],
            },
          },
        ],
      },
    });

    await expect(
      internals.resolveExactUserParticipant(
        'viewer-user-body-id',
        '@person.w3id',
        { ownerEName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' },
        'interactive',
      ),
    ).resolves.toBe(true);

    expect(graphql).toHaveBeenCalledOnce();
    expect(graphql.mock.calls[0]?.[2]).toContain('ExactUserParticipantIdentity');
    expect(graphql.mock.calls[0]?.[3]).toEqual({
      ontologyId: '550e8400-e29b-41d4-a716-446655440000',
      participantId: 'viewer-user-body-id',
      first: 4,
    });
  });

  it('does not trust a User extension that contradicts the owner eName', async () => {
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'viewer-user-envelope',
      ontology: '550e8400-e29b-41d4-a716-446655440000',
      parsed: { id: 'viewer-user-envelope', eName: '@other.w3id' },
    });
    const graphql = vi.spyOn(internals, 'graphql');

    await expect(
      internals.resolveExactUserParticipant(
        'viewer-user-envelope',
        '@person.w3id',
        { ownerEName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' },
        'interactive',
      ),
    ).resolves.toBe(false);

    expect(graphql).not.toHaveBeenCalled();
  });

  it('keeps opaque legacy direct-chat participant ids on the compatibility path', async () => {
    const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/legacy-identity-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
      ownerEName: viewer.eName,
      eVaultUri: viewer.eVaultUri,
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@friend.w3id',
      eVaultUri: 'https://friend-vault.example',
    });
    vi.spyOn(internals, 'readEnvelope').mockImplementation(async (_owner, _vault, id) => {
      if (id === 'viewer-chat-grant') {
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: {
            isReference: true,
            type: 'direct',
            canonicalOwnerEName: '@friend.w3id',
            canonicalChatId: 'chat-1',
          },
        };
      }
      if (id === 'chat-1') {
        // A User metaId cannot be compared to an eName locally. It is not
        // evidence that the viewer was removed; the legacy proof owns it.
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: {
            type: 'direct',
            participantIds: ['viewer-user-meta-id', 'friend-user-meta-id'],
          },
        };
      }
      return {
        id,
        ontology: documentedOntologyId('call-recording'),
        parsed: {
          chatId: 'chat-1',
          participants: [viewer.eName, '@friend.w3id'],
          recording: {
            mediaIsVideo: true,
            recordingVault: '@media.w3id',
            mediaUri: sharedGrant.fileUri,
          },
        },
      };
    });
    vi.spyOn(internals, 'resolveExactUserParticipant').mockResolvedValue(false);

    await expect(
      internals.resolveExactSharedCallAuthorization(viewer, sharedGrant, 'interactive'),
    ).resolves.toBe('not_eligible');
  });

  it('fails closed on a forged viewer Chat pointer without starting a history scan', async () => {
    const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/forged-pointer-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
      ownerEName: viewer.eName,
      eVaultUri: viewer.eVaultUri,
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@friend.w3id',
      eVaultUri: 'https://friend-vault.example',
    });
    vi.spyOn(internals, 'readEnvelope').mockImplementation(async (_owner, _vault, id) => {
      if (id === 'viewer-chat-grant') {
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: {
            isReference: true,
            type: 'direct',
            canonicalOwnerEName: '@friend.w3id',
            canonicalChatId: 'chat-1',
          },
        };
      }
      if (id === 'chat-1') {
        // A viewer can point at this Chat, but the source has not granted the
        // viewer access. The source record is the decisive evidence.
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: { type: 'direct', participantIds: ['@friend.w3id', '@other.w3id'] },
        };
      }
      return {
        id,
        ontology: documentedOntologyId('call-recording'),
        parsed: {
          chatId: 'chat-1',
          participants: [viewer.eName, '@friend.w3id'],
          recording: {
            mediaIsVideo: true,
            recordingVault: '@media.w3id',
            mediaUri: sharedGrant.fileUri,
          },
        },
      };
    });
    const dereference = vi.spyOn(internals, 'tryDereferenceFileMediaUrl');
    const legacyProbe = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(
      library.resolveMediaUrl(viewer, createMeshengerVideoStreamId(sharedGrant, secret)),
    ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied', status: 403 }));

    expect(legacyProbe).not.toHaveBeenCalled();
    expect(dereference).not.toHaveBeenCalled();
  });

  it('fails closed when a viewer Chat pointer names a different canonical conversation', async () => {
    const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/replaced-viewer-pointer-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'replaced-viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
      ownerEName: viewer.eName,
      eVaultUri: viewer.eVaultUri,
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@friend.w3id',
      eVaultUri: 'https://friend-vault.example',
    });
    vi.spyOn(internals, 'readEnvelope').mockImplementation(async (_owner, _vault, id) => {
      if (id === 'replaced-viewer-chat-grant') {
        // A signed direct-share context cannot be resurrected from an old
        // local Chat replica that names a different canonical conversation.
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: {
            isReference: true,
            type: 'direct',
            canonicalOwnerEName: '@previous-friend.w3id',
            canonicalChatId: 'old-chat',
          },
        };
      }
      if (id === 'chat-1') {
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: { type: 'direct', participantIds: [viewer.eName, '@friend.w3id'] },
        };
      }
      if (id === 'call-session-1') {
        return {
          id,
          ontology: documentedOntologyId('call-recording'),
          parsed: {
            chatId: 'chat-1',
            participants: [viewer.eName, '@friend.w3id'],
            recording: {
              mediaIsVideo: true,
              recordingVault: '@media.w3id',
              mediaUri: sharedGrant.fileUri,
            },
          },
        };
      }
      throw new Error(`Unexpected envelope read: ${id}`);
    });

    const dereference = vi.spyOn(internals, 'tryDereferenceFileMediaUrl');
    const legacyProbe = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(
      library.resolveMediaUrl(viewer, createMeshengerVideoStreamId(sharedGrant, secret)),
    ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied', status: 403 }));

    expect(legacyProbe).not.toHaveBeenCalled();
    expect(dereference).not.toHaveBeenCalled();
  });

  it('fails closed when the signed CallSession no longer matches the requested File', async () => {
    const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/mismatched-call-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
      ownerEName: viewer.eName,
      eVaultUri: viewer.eVaultUri,
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@friend.w3id',
      eVaultUri: 'https://friend-vault.example',
    });
    vi.spyOn(internals, 'readEnvelope').mockImplementation(async (_owner, _vault, id) => {
      if (id === 'viewer-chat-grant') {
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: {
            isReference: true,
            type: 'direct',
            canonicalOwnerEName: '@friend.w3id',
            canonicalChatId: 'chat-1',
          },
        };
      }
      if (id === 'chat-1') {
        return {
          id,
          ontology: documentedAuthorizationOntologies.chat,
          parsed: { type: 'direct', participantIds: [viewer.eName, '@friend.w3id'] },
        };
      }
      return {
        id,
        ontology: documentedOntologyId('call-recording'),
        parsed: {
          chatId: 'chat-1',
          participants: [viewer.eName, '@friend.w3id'],
          recording: {
            mediaIsVideo: true,
            recordingVault: '@media.w3id',
            mediaUri: 'w3ds://file?id=@media.w3id/another-file',
          },
        },
      };
    });
    const dereference = vi.spyOn(internals, 'tryDereferenceFileMediaUrl');
    const legacyProbe = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(
      library.resolveMediaUrl(viewer, createMeshengerVideoStreamId(sharedGrant, secret)),
    ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied', status: 403 }));

    expect(legacyProbe).not.toHaveBeenCalled();
    expect(dereference).not.toHaveBeenCalled();
  });

  it('returns a retryable error on an exact-proof transport failure without a history scan', async () => {
    const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@media.w3id/retry-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
      ownerEName: viewer.eName,
      eVaultUri: viewer.eVaultUri,
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@friend.w3id',
      eVaultUri: 'https://friend-vault.example',
    });
    vi.spyOn(internals, 'readEnvelope').mockRejectedValue(
      new (class extends Error {})('source timeout'),
    );
    const legacyProbe = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(
      library.resolveMediaUrl(viewer, createMeshengerVideoStreamId(sharedGrant, secret)),
    ).rejects.toThrow(expect.objectContaining({ code: 'remote_unavailable', status: 503 }));
    expect(legacyProbe).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a platform authorization rejection',
      new MeshengerVideoLibraryError('denied', 'authorization_denied', 403),
    ],
    ['a missing exact record', new MeshengerVideoLibraryError('missing', 'not_found', 404)],
  ])(
    'keeps %s retryable instead of quarantining or widening through a history scan',
    async (_label, sourceError) => {
      const viewer = { eName: '@person.w3id', eVaultUri: 'https://viewer-vault.example' };
      const sharedGrant = {
        ...grant,
        fileUri: 'w3ds://file?id=@media.w3id/ambiguous-exact-source-file',
        accessScope: 'shared' as const,
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'chat-1',
        sourceViewerChatGrantId: 'viewer-chat-grant',
        sourceCallSessionId: 'call-session-1',
        sourceCallSessionVault: '@friend.w3id',
        sourceChatKind: 'direct' as const,
        accessBasis: 'history' as const,
        sharedCardBindingHash: 'd'.repeat(43),
      };
      const library = configuredLibrary();
      const internals = exactCallProofInternals(library);
      vi.spyOn(internals, 'resolveViewerEVault').mockResolvedValue({
        ownerEName: viewer.eName,
        eVaultUri: viewer.eVaultUri,
      });
      vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
        ownerEName: '@friend.w3id',
        eVaultUri: 'https://friend-vault.example',
      });
      vi.spyOn(internals, 'readEnvelope').mockRejectedValue(sourceError);
      const legacyProbe = vi.spyOn(library, 'probeSharedSpaceAccess');
      const dereference = vi.spyOn(internals, 'tryDereferenceFileMediaUrl');

      await expect(
        library.resolveMediaUrl(viewer, createMeshengerVideoStreamId(sharedGrant, secret)),
      ).rejects.toMatchObject({
        code: 'remote_unavailable',
        status: 503,
        terminalSharedCardBindingHash: undefined,
      });

      expect(legacyProbe).not.toHaveBeenCalled();
      expect(dereference).not.toHaveBeenCalled();
    },
  );

  it('uses the canonical W3DS eVault path even if legacy bridge variables are configured', async () => {
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@friend.w3id/canonical-evault-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-envelope',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@friend.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = createMeshengerVideoLibrary({
      W3DS_AUTH_PLATFORM_NAME: 'vidak',
      W3DS_REGISTRY_BASE_URL: 'https://registry.example',
      W3DS_AUTH_JWT_SECRET: secret,
      MESHENGER_PLAYBACK_GRANT_URL:
        'https://meshenger.example/api/integrations/vidak/recording-playback-grant',
      VIDAK_PLAYBACK_BRIDGE_SECRET: 'bridge-secret-0123456789abcdef012345',
    });
    const internals = exactCallProofInternals(library);
    const exactProof = vi
      .spyOn(internals, 'resolveExactSharedCallAuthorization')
      .mockResolvedValue('verified');
    const lookup = vi.spyOn(internals, 'resolveEVaultLookup').mockResolvedValue({
      vault: { ownerEName: '@friend.w3id', eVaultUri: 'https://friend-vault.example' },
      cacheHit: false,
    });
    const dereference = vi
      .spyOn(internals, 'tryDereferenceFileMediaUrl')
      .mockResolvedValue('https://media.example/canonical-evault-file.mp4');
    const sourceFetch = vi.fn();
    vi.stubGlobal('fetch', sourceFetch);

    try {
      await expect(
        library.resolveMediaUrl(
          { eName: sharedGrant.eName },
          createMeshengerVideoStreamId(sharedGrant, secret),
        ),
      ).resolves.toBe('https://media.example/canonical-evault-file.mp4');
      expect(exactProof).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledOnce();
      expect(dereference).toHaveBeenCalledOnce();
      expect(sourceFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reuses a verified cross-replica shared receipt without repeating source proof work', async () => {
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@friend.w3id/receipt-shared-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      accessBasis: 'membership' as const,
    };
    const library = configuredLibrary();
    const exactProof = vi.spyOn(
      exactCallProofInternals(library),
      'resolveExactSharedCallAuthorization',
    );
    const legacyProof = vi.spyOn(library, 'probeSharedSpaceAccess');
    const sourceFetch = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
      }
      if (
        url.hostname === 'friend-vault.example' &&
        url.pathname === '/files/receipt-shared-file'
      ) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/receipt-shared-file.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', sourceFetch);

    try {
      await expect(
        library.resolveMediaUrl(
          { eName: sharedGrant.eName },
          createMeshengerVideoStreamId(sharedGrant, secret),
          { hasRecentSharedAuthorizationReceipt: true },
        ),
      ).resolves.toBe('https://media.example/receipt-shared-file.mp4');

      // The receipt only replaces the immediately preceding access proof.
      // The signed stream grant and its canonical File dereference still run.
      expect(exactProof).not.toHaveBeenCalled();
      expect(legacyProof).not.toHaveBeenCalled();
      expect(sourceFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not hide a retryable exact source proof behind the slow legacy history scan', async () => {
    const sharedGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@friend.w3id/unavailable-exact-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-session-envelope',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@friend.w3id',
      sourceChatKind: 'direct' as const,
      accessBasis: 'history' as const,
    };
    const library = configuredLibrary();
    vi.spyOn(
      exactCallProofInternals(library),
      'resolveExactSharedCallAuthorization',
    ).mockResolvedValue('retry');
    const probe = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(
      library.resolveMediaUrl(
        { eName: sharedGrant.eName },
        createMeshengerVideoStreamId(sharedGrant, secret),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'remote_unavailable', status: 503 }));
    expect(probe).not.toHaveBeenCalled();
  });

  it('continues to verify a valid legacy personal stream while outstanding links expire', () => {
    const encoded = Buffer.from(JSON.stringify(grant)).toString('base64url');
    const legacy = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;

    expect(verifyMeshengerVideoStreamId(legacy, secret)).toEqual(grant);
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

  it('renews a signed expired personal stream only for its owner', async () => {
    const expired = createMeshengerVideoStreamId({ ...grant, expiresAt: Date.now() - 1 }, secret);
    const renewed = await configuredLibrary().renewPlayableStream({ eName: grant.eName }, expired);

    expect(renewed).not.toBe(expired);
    expect(verifyMeshengerVideoStreamId(renewed, secret)).toMatchObject({
      eName: grant.eName,
      fileUri: grant.fileUri,
      accessScope: 'personal',
    });
    await expect(
      configuredLibrary().renewPlayableStream({ eName: '@other.w3id' }, expired),
    ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied' }));
  });

  it('reuses one renewed grant for repeated ranges on the same expired stream', async () => {
    let now = 1_000;
    const expired = createMeshengerVideoStreamId({ ...grant, expiresAt: now - 1 }, secret);
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { now: () => now },
    );

    const first = await library.renewPlayableStream({ eName: grant.eName }, expired);
    now += 1_000;
    const second = await library.renewPlayableStream({ eName: grant.eName }, expired);

    expect(second).toBe(first);
  });

  it('rejects a shared source without signed source context before contacting an eVault', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(
        configuredLibrary().resolveMediaUrl(
          { eName: '@person.w3id' },
          createMeshengerVideoStreamId(
            {
              ...grant,
              fileUri: 'w3ds://file?id=@friend.w3id/foreign-file',
              accessScope: 'shared',
            },
            secret,
          ),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'invalid_stream', status: 401 }));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a legacy shared W3DS File through the standard owner dereference', async () => {
    const library = configuredLibrary();
    const playbackHeaders: Headers[] = [];
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'denied', member: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/shared-file') {
          playbackHeaders.push(new Headers(init?.headers));
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/shared-video.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/shared-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'chat-1',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(
        library.inspectPlayableStream({ eName: grant.eName }, streamId),
      ).resolves.toEqual({ fileUri: 'w3ds://file?id=@friend.w3id/shared-file' });
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/shared-video.mp4',
      );
      // The source-app Chat mirror is not a prerequisite for a signed legacy
      // W3DS File grant. A stale/missing mirror therefore cannot turn a
      // portable File URI into a dead player.
      expect(probe).not.toHaveBeenCalled();
      expect(playbackHeaders).toHaveLength(1);
      expect(playbackHeaders[0]?.get('X-ENAME')).toBe('@friend.w3id');
      expect(playbackHeaders[0]?.get('X-ON-BEHALF-OF')).toBeNull();
      expect(playbackHeaders[0]?.get('Authorization')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a shared-labelled File from the viewer eVault without a peer Chat proof', async () => {
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'denied', member: false });
    const requests: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        requests.push(url);
        if (url.pathname === '/resolve') {
          return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
        }
        if (url.hostname === 'person-vault.example' && url.pathname === '/files/viewer-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/viewer-file.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        // This is still catalogued as shared because it came from a
        // conversation, but the canonical File belongs to the viewer's own
        // eVault and is therefore opened directly through W3DS File.
        fileUri: 'w3ds://file?id=@person.w3id/viewer-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'historical-share',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: '@person.w3id' }, streamId)).resolves.toBe(
        'https://media.example/viewer-file.mp4',
      );
      expect(probe).not.toHaveBeenCalled();
      expect(requests.map((url) => url.pathname)).toEqual(['/resolve', '/files/viewer-file']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('obtains the W3DS platform credential before a cold canonical shared File redirect', async () => {
    const library = configuredLibrary();
    const playbackHeaders: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') {
          return json({ token: 'registry-platform-token' });
        }
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/authenticated-shared-file') {
          playbackHeaders.push(new Headers(init?.headers));
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/authenticated-shared-file.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/authenticated-shared-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'shared-file-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/authenticated-shared-file.mp4',
      );
      expect(playbackHeaders).toHaveLength(1);
      expect(playbackHeaders[0]?.get('X-ENAME')).toBe('@friend.w3id');
      expect(playbackHeaders[0]?.get('Authorization')).toBe('Bearer registry-platform-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hedges a slow owner eVault File redirect with its canonical metadata read for shared Watch', async () => {
    let directStarted = false;
    let directAborted = false;
    let metadataReads = 0;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/files/hedged-file') {
        directStarted = true;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              directAborted = true;
              reject(new Error('slow File redirect cancelled'));
            },
            { once: true },
          );
        });
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'registry-platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        metadataReads += 1;
        return Promise.resolve(
          json({
            data: {
              metaEnvelope: {
                id: 'hedged-file',
                ontology: 'w3ds-file',
                parsed: { url: 'https://media.example/hedged.mp4' },
                envelopes: [],
              },
            },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/hedged-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'hedged-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      const pending = configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        priority: 'interactive',
      });
      await vi.waitFor(() => expect(directStarted).toBe(true));
      await expect(pending).resolves.toBe('https://media.example/hedged.mp4');
      expect(metadataReads).toBe(1);
      expect(directAborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the hedged metadata fallback alive when a slow File endpoint later returns 429', async () => {
    let directReads = 0;
    let metadataReads = 0;
    let metadataAborted = false;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/files/slow-rate-limited-file') {
        directReads += 1;
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(rateLimited('0')), 350);
        });
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'registry-platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        metadataReads += 1;
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              metadataAborted = true;
              reject(new Error('metadata fallback was cancelled'));
            },
            { once: true },
          );
          // The direct endpoint finishes after the 250ms hedge but before
          // this canonical fallback. The former implementation aborted this
          // useful GraphQL work as soon as it saw the late 429.
          setTimeout(
            () =>
              resolve(
                json({
                  data: {
                    metaEnvelope: {
                      id: 'slow-rate-limited-file',
                      ontology: 'w3ds-file',
                      parsed: { url: 'https://media.example/slow-rate-limited-file.mp4' },
                      envelopes: [],
                    },
                  },
                }),
              ),
            200,
          );
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/slow-rate-limited-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'slow-rate-limited-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toBe('https://media.example/slow-rate-limited-file.mp4');
      expect(directReads).toBe(1);
      expect(metadataReads).toBe(1);
      expect(metadataAborted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives a rate-limited optional File endpoint a short grace before using shared metadata', async () => {
    let directReads = 0;
    let metadataReads = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
      }
      if (url.pathname === '/files/rate-limited-direct-file') {
        directReads += 1;
        return rateLimited('0');
      }
      if (url.pathname === '/platforms/certification') {
        return json({ token: 'registry-platform-token' });
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        metadataReads += 1;
        return json({
          data: {
            metaEnvelope: {
              id: 'rate-limited-direct-file',
              ontology: 'w3ds-file',
              parsed: { url: 'https://media.example/rate-limited-direct-file.mp4' },
              envelopes: [],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/rate-limited-direct-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'rate-limited-direct-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toBe('https://media.example/rate-limited-direct-file.mp4');
      // The old resolver immediately sent both requests while the eVault was
      // throttled. One cooperative grace keeps the fallback compatible without
      // amplifying that source's limiter.
      expect(directReads).toBe(1);
      expect(metadataReads).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries a shared File metadata fallback within its interactive deadline after a 429', async () => {
    let metadataReads = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
      }
      if (url.pathname === '/files/retry-shared-metadata-file') {
        return new Response(null, { status: 404 });
      }
      if (url.pathname === '/platforms/certification') {
        return json({ token: 'registry-platform-token' });
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        metadataReads += 1;
        if (metadataReads === 1) return rateLimited('0');
        return json({
          data: {
            metaEnvelope: {
              id: 'retry-shared-metadata-file',
              ontology: 'w3ds-file',
              parsed: { url: 'https://media.example/retry-shared-metadata-file.mp4' },
              envelopes: [],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/retry-shared-metadata-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'retry-shared-metadata-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toBe('https://media.example/retry-shared-metadata-file.mp4');
      expect(metadataReads).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not bypass an unsafe owner eVault redirect with metadata fallback', async () => {
    let metadataReads = 0;
    const fetcher = vi.fn((url: URL) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/files/unsafe-file') {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
        );
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'registry-platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        metadataReads += 1;
        return Promise.resolve(
          json({
            data: {
              metaEnvelope: {
                id: 'unsafe-file',
                ontology: 'w3ds-file',
                parsed: { url: 'https://media.example/should-not-be-used.mp4' },
                envelopes: [],
              },
            },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/unsafe-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'unsafe-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'unsafe_media_url', status: 502 }));
      expect(metadataReads).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds a cold legacy shared File metadata fallback inside its interactive deadline', async () => {
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) =>
        milliseconds === 5_000 ? deadline.signal : originalTimeout(milliseconds),
      );
    let metadataReads = 0;
    let metadataAborted = false;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/files/slow-legacy-file')
        return Promise.resolve(new Response(null, { status: 404 }));
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'registry-platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        metadataReads += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              metadataAborted = true;
              reject(new Error('metadata read aborted'));
            },
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/slow-legacy-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'legacy-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      const pending = configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        priority: 'interactive',
      });
      await vi.waitFor(() => expect(metadataReads).toBe(1));
      deadline.abort();
      await expect(pending).rejects.toThrow(
        expect.objectContaining({ code: 'remote_unavailable', status: 503 }),
      );
      expect(metadataAborted).toBe(true);
      expect(metadataReads).toBe(1);
      expect(timeout.mock.calls.filter(([milliseconds]) => milliseconds === 5_000)).toHaveLength(1);
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not reopen an expired hedged metadata fallback after a late File 429', async () => {
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) =>
        milliseconds === 5_000 ? deadline.signal : originalTimeout(milliseconds),
      );
    let resolveDirect: ((response: Response) => void) | undefined;
    let metadataReads = 0;
    let metadataAborted = false;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/files/late-rate-limited-file') {
        return new Promise<Response>((resolve) => {
          resolveDirect = resolve;
        });
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'registry-platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        metadataReads += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              metadataAborted = true;
              reject(new Error('metadata read aborted'));
            },
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/late-rate-limited-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'late-rate-limited-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      const pending = configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        priority: 'interactive',
      });
      await vi.waitFor(() => expect(metadataReads).toBe(1));
      resolveDirect?.(rateLimited('0'));
      // Let the late 429 reach the hedged resolver before exhausting the
      // metadata deadline that was already created for this Watch.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      deadline.abort();

      await expect(pending).rejects.toThrow(
        expect.objectContaining({ code: 'remote_unavailable', status: 503 }),
      );
      expect(metadataAborted).toBe(true);
      expect(metadataReads).toBe(1);
      expect(timeout.mock.calls.filter(([milliseconds]) => milliseconds === 5_000)).toHaveLength(1);
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('re-resolves a legacy shared W3DS File after an upstream source refresh', async () => {
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'denied', member: false });
    let fileReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/refreshable-legacy-file') {
          fileReads += 1;
          return new Response(null, {
            status: 302,
            headers: {
              location:
                fileReads === 1
                  ? 'https://media.example/legacy-before-refresh.mp4'
                  : 'https://media.example/legacy-after-refresh.mp4',
            },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/refreshable-legacy-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'legacy-refresh-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/legacy-before-refresh.mp4',
      );
      await expect(
        library.resolveMediaUrl({ eName: grant.eName }, streamId, { forceSourceRefresh: true }),
      ).resolves.toBe('https://media.example/legacy-after-refresh.mp4');
      expect(fileReads).toBe(2);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('mints a refresh capability for a legacy shared W3DS File without a source-app proof', async () => {
    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/legacy-refresh-capability',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'legacy-refresh-capability-chat',
        sourceChatKind: 'direct',
        accessBasis: 'history',
      },
      secret,
    );
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'denied', member: false });

    try {
      const proof = await library.proveCurrentPlayableStreamForSourceRefresh(
        { eName: grant.eName },
        streamId,
      );
      expect(
        library.playbackSourceRefreshReadReceiptAfterCurrentProof(
          { eName: grant.eName },
          streamId,
          proof,
        ),
      ).toEqual(expect.any(String));
      expect(probe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('coalesces the initial byte-range authorization burst for one shared stream', async () => {
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    const fetcher = vi.fn(async (url: URL, _init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@cache-friend.w3id', uri: 'https://cache-friend-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.pathname === '/files/cache-file') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/cache-shared-video.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        eName: '@cache-viewer.w3id',
        fileUri: 'w3ds://file?id=@cache-friend.w3id/cache-file',
        accessScope: 'shared',
        sourceSpaceKey: '@cache-friend.w3id',
        sourceChatId: 'cache-chat',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(
        Promise.all([
          library.resolveMediaUrl({ eName: '@cache-viewer.w3id' }, streamId),
          library.resolveMediaUrl({ eName: '@cache-viewer.w3id' }, streamId),
        ]),
      ).resolves.toEqual([
        'https://media.example/cache-shared-video.mp4',
        'https://media.example/cache-shared-video.mp4',
      ]);
      // A signed legacy File grant resolves through W3DS directly. Range
      // requests coalesce around one owner lookup and one File dereference.
      expect(probe).not.toHaveBeenCalled();
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/resolve'),
      ).toHaveLength(1);
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/files/cache-file'),
      ).toHaveLength(1);
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/platforms/certification'),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a historic share when its GroupManifest proof wins a slow direct proof', async () => {
    const library = configuredLibrary();
    let releaseDirect: (access: SharedAccessResult) => void = () => undefined;
    const direct = new Promise<SharedAccessResult>((resolve) => {
      releaseDirect = resolve;
    });
    let directSettled = false;
    void direct.then(() => {
      directSettled = true;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation((_user, source) =>
        source.kind === 'direct'
          ? direct
          : Promise.resolve({ access: 'ok', member: true } as const),
      );
    stubInteractivePlatformToken();

    try {
      const pending = library.inspectPlayableStream(
        { eName: '@person.w3id' },
        historySharedStream('history-group-wins'),
        { priority: 'interactive' },
      );
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

      await expect(pending).resolves.toEqual({
        fileUri: 'w3ds://file?id=@friend.w3id/history-group-wins',
      });
      expect(directSettled).toBe(false);
      expect(probe).toHaveBeenCalledWith(
        { eName: '@person.w3id' },
        {
          eName: '@friend.w3id',
          kind: 'direct',
          chatId: 'history-chat',
          viewerChatGrantId: 'viewer-history-chat-grant',
        },
        'interactive',
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      releaseDirect({ access: 'missing', member: false });
      await direct;
      vi.unstubAllGlobals();
    }
  });

  it('opens a historic share when its direct proof wins a slow GroupManifest proof', async () => {
    const library = configuredLibrary();
    let releaseGroup: (access: SharedAccessResult) => void = () => undefined;
    const group = new Promise<SharedAccessResult>((resolve) => {
      releaseGroup = resolve;
    });
    let groupSettled = false;
    void group.then(() => {
      groupSettled = true;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation((_user, source) =>
        source.kind === 'direct' ? Promise.resolve({ access: 'ok', member: true } as const) : group,
      );
    stubInteractivePlatformToken();

    try {
      const pending = library.inspectPlayableStream(
        { eName: '@person.w3id' },
        historySharedStream('history-direct-wins'),
        { priority: 'interactive' },
      );
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

      await expect(pending).resolves.toEqual({
        fileUri: 'w3ds://file?id=@friend.w3id/history-direct-wins',
      });
      expect(groupSettled).toBe(false);
      expect(probe).toHaveBeenCalledWith(
        { eName: '@person.w3id' },
        { eName: '@friend.w3id', kind: 'group' },
        'interactive',
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      releaseGroup({ access: 'missing', member: false });
      await group;
      vi.unstubAllGlobals();
    }
  });

  it('uses only the authoritative GroupManifest proof for a known group recording', async () => {
    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@group.w3id/group-recording',
        accessScope: 'shared',
        sourceSpaceKey: '@group.w3id',
        sourceChatId: 'group-chat',
        sourceChatKind: 'group',
        accessBasis: 'history',
      },
      secret,
    );
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    stubInteractivePlatformToken();

    try {
      await expect(
        library.inspectPlayableStream({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toEqual({ fileUri: 'w3ds://file?id=@group.w3id/group-recording' });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith(
        { eName: '@person.w3id' },
        { eName: '@group.w3id', kind: 'group' },
        'interactive',
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses only the direct-chat proof for a known direct shared recording', async () => {
    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/direct-recording',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'direct-chat',
        sourceChatKind: 'direct',
        sourceViewerChatGrantId: 'viewer-direct-chat-grant',
        accessBasis: 'history',
      },
      secret,
    );
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    stubInteractivePlatformToken();

    try {
      await expect(
        library.inspectPlayableStream({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toEqual({ fileUri: 'w3ds://file?id=@friend.w3id/direct-recording' });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith(
        { eName: '@person.w3id' },
        {
          eName: '@friend.w3id',
          kind: 'direct',
          chatId: 'direct-chat',
          viewerChatGrantId: 'viewer-direct-chat-grant',
        },
        'interactive',
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a fully addressed group CallSession without a GroupManifest proof', async () => {
    const viewer = { eName: '@person.w3id' };
    const streamId = exactGroupCallHistoryStream('group-full-recording');
    const fileUri = 'w3ds://file?id=@media.w3id/group-full-recording';
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@group.w3id',
      eVaultUri: 'https://group-vault.example',
    });
    vi.spyOn(internals, 'resolveEVaultLookup').mockResolvedValue({
      vault: { ownerEName: '@media.w3id', eVaultUri: 'https://media-vault.example' },
      cacheHit: false,
    });
    const readEnvelope = vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'group-call-1',
      ontology: documentedOntologyId('call-recording'),
      parsed: {
        chatId: 'group-chat',
        participants: [viewer.eName, '@other.w3id'],
        recording: {
          mediaIsVideo: true,
          recordingVault: '@media.w3id',
          mediaUri: fileUri,
        },
      },
    });
    const dereference = vi
      .spyOn(internals, 'tryDereferenceFileMediaUrl')
      .mockResolvedValue('https://media.example/group-full-recording.mp4');
    const groupManifest = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(library.inspectPlayableStream(viewer, streamId)).resolves.toEqual({ fileUri });
    await expect(library.resolveMediaUrl(viewer, streamId)).resolves.toBe(
      'https://media.example/group-full-recording.mp4',
    );

    // The second request reuses only the dedicated exact-file proof. It never
    // consults the broad group cache or reads a GroupManifest.
    expect(readEnvelope).toHaveBeenCalledOnce();
    expect(readEnvelope).toHaveBeenCalledWith(
      '@group.w3id',
      'https://group-vault.example',
      'group-call-1',
      'interactive',
      undefined,
      expect.any(AbortSignal),
    );
    expect(groupManifest).not.toHaveBeenCalled();
    expect(dereference).toHaveBeenCalledOnce();
  });

  it('does not let a cached GroupManifest hide a group CallSession participant contradiction', async () => {
    const viewer = { eName: '@person.w3id' };
    const streamId = exactGroupCallHistoryStream('viewer-not-in-call');
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    rememberVerifiedSharedAccess(viewer.eName, { eName: '@group.w3id', kind: 'group' });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@group.w3id',
      eVaultUri: 'https://group-vault.example',
    });
    const readEnvelope = vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'group-call-1',
      ontology: documentedOntologyId('call-recording'),
      parsed: {
        chatId: 'group-chat',
        participants: ['@other.w3id'],
        recording: {
          mediaIsVideo: true,
          recordingVault: '@media.w3id',
          mediaUri: 'w3ds://file?id=@media.w3id/viewer-not-in-call',
        },
      },
    });
    const groupManifest = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(library.inspectPlayableStream(viewer, streamId)).rejects.toThrow(
      expect.objectContaining({ code: 'authorization_denied', status: 403 }),
    );

    expect(readEnvelope).toHaveBeenCalledOnce();
    expect(groupManifest).not.toHaveBeenCalled();
  });

  it('keeps exact group CallSession proofs isolated between recording segments', async () => {
    const viewer = { eName: '@person.w3id' };
    const firstFileUri = 'w3ds://file?id=@media.w3id/recording-segment-a';
    const firstStreamId = exactGroupCallHistoryStream('recording-segment-a');
    const secondStreamId = exactGroupCallHistoryStream('recording-segment-b');
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@group.w3id',
      eVaultUri: 'https://group-vault.example',
    });
    const readEnvelope = vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'group-call-1',
      ontology: documentedOntologyId('call-recording'),
      parsed: {
        chatId: 'group-chat',
        participants: [viewer.eName, '@other.w3id'],
        recording: {
          mediaIsVideo: true,
          recordingVault: '@media.w3id',
          mediaSegments: [firstFileUri],
        },
      },
    });
    const groupManifest = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(library.inspectPlayableStream(viewer, firstStreamId)).resolves.toEqual({
      fileUri: firstFileUri,
    });
    // This broad cache entry deliberately models an inventory result. It can
    // be an eligible fallback after a transport error, but never a way to skip
    // the exact second-segment CallSession contradiction.
    rememberVerifiedSharedAccess(viewer.eName, { eName: '@group.w3id', kind: 'group' });

    await expect(library.inspectPlayableStream(viewer, secondStreamId)).rejects.toThrow(
      expect.objectContaining({ code: 'authorization_denied', status: 403 }),
    );

    expect(readEnvelope).toHaveBeenCalledTimes(2);
    expect(groupManifest).not.toHaveBeenCalled();
  });

  it('retains an exact group CallSession context after an expired stream is renewed', async () => {
    const viewer = { eName: '@person.w3id' };
    const fileUri = 'w3ds://file?id=@media.w3id/renewed-group-segment';
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    const renewedStreamId = await library.renewPlayableStream(
      viewer,
      exactGroupCallHistoryStream('renewed-group-segment', Date.now() - 1),
    );

    expect(verifyMeshengerVideoStreamId(renewedStreamId, secret)).toMatchObject({
      fileUri,
      sourceSpaceKey: '@group.w3id',
      sourceChatId: 'group-chat',
      sourceCallSessionId: 'group-call-1',
      sourceCallSessionVault: '@group.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'group',
      accessBasis: 'history',
    });
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@group.w3id',
      eVaultUri: 'https://group-vault.example',
    });
    vi.spyOn(internals, 'resolveEVaultLookup').mockResolvedValue({
      vault: { ownerEName: '@media.w3id', eVaultUri: 'https://media-vault.example' },
      cacheHit: false,
    });
    const readEnvelope = vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'group-call-1',
      ontology: documentedOntologyId('call-recording'),
      parsed: {
        chatId: 'group-chat',
        participants: [viewer.eName, '@other.w3id'],
        recording: {
          mediaIsVideo: true,
          recordingVault: '@media.w3id',
          mediaSegments: [fileUri],
        },
      },
    });
    vi.spyOn(internals, 'tryDereferenceFileMediaUrl').mockResolvedValue(
      'https://media.example/renewed-group-segment.mp4',
    );
    const groupManifest = vi.spyOn(library, 'probeSharedSpaceAccess');

    await expect(library.resolveMediaUrl(viewer, renewedStreamId)).resolves.toBe(
      'https://media.example/renewed-group-segment.mp4',
    );

    expect(readEnvelope).toHaveBeenCalledOnce();
    expect(groupManifest).not.toHaveBeenCalled();
  });

  it('keeps a forced-refresh capability bound to the current exact group CallSession proof', async () => {
    const viewer = { eName: '@person.w3id' };
    const streamId = exactGroupCallHistoryStream('forced-group-segment');
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveEVault').mockResolvedValue({
      ownerEName: '@group.w3id',
      eVaultUri: 'https://group-vault.example',
    });
    vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'group-call-1',
      ontology: documentedOntologyId('call-recording'),
      parsed: {
        chatId: 'group-chat',
        participants: [viewer.eName, '@other.w3id'],
        recording: {
          mediaIsVideo: true,
          recordingVault: '@media.w3id',
          mediaUri: 'w3ds://file?id=@media.w3id/forced-group-segment',
        },
      },
    });
    const groupManifest = vi.spyOn(library, 'probeSharedSpaceAccess');

    const proof = await library.proveCurrentPlayableStreamForSourceRefresh(viewer, streamId);
    expect(
      library.playbackSourceRefreshReadReceiptAfterCurrentProof(viewer, streamId, proof),
    ).toEqual(expect.any(String));

    (
      library as unknown as {
        invalidateSharedAccessProofs(viewerEName: string, grant: unknown): void;
      }
    ).invalidateSharedAccessProofs(viewer.eName, verifyMeshengerVideoStreamId(streamId, secret));

    expect(
      library.playbackSourceRefreshReadReceiptAfterCurrentProof(viewer, streamId, proof),
    ).toBeUndefined();
    expect(groupManifest).not.toHaveBeenCalled();
  });

  it('keeps an unavailable exact group CallSession retryable when GroupManifest cannot prove access', async () => {
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveEVault').mockRejectedValue(
      new MeshengerVideoLibraryError('source unavailable', 'remote_unavailable', 503),
    );
    const groupManifest = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'missing', member: false });
    stubInteractivePlatformToken();

    try {
      await expect(
        library.inspectPlayableStream(
          { eName: '@person.w3id' },
          exactGroupCallHistoryStream('unavailable-group-call'),
          { priority: 'interactive' },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'remote_unavailable', status: 503 }));

      expect(groupManifest).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses an independently verified GroupManifest when an exact group CallSession is unavailable', async () => {
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    vi.spyOn(internals, 'resolveEVault').mockRejectedValue(
      new MeshengerVideoLibraryError('source unavailable', 'remote_unavailable', 503),
    );
    const groupManifest = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    stubInteractivePlatformToken();

    try {
      await expect(
        library.inspectPlayableStream(
          { eName: '@person.w3id' },
          exactGroupCallHistoryStream('manifest-fallback-group-call'),
          { priority: 'interactive' },
        ),
      ).resolves.toEqual({ fileUri: 'w3ds://file?id=@media.w3id/manifest-fallback-group-call' });

      expect(groupManifest).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fan out a GroupManifest while an exact group CallSession is pending', async () => {
    vi.useFakeTimers();
    const viewer = { eName: '@person.w3id' };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    let releaseExactVault: ((vault: { ownerEName: string; eVaultUri: string }) => void) | undefined;
    const exactVault = new Promise<{ ownerEName: string; eVaultUri: string }>((resolve) => {
      releaseExactVault = resolve;
    });
    vi.spyOn(internals, 'resolveEVault').mockReturnValue(exactVault);
    vi.spyOn(internals, 'readEnvelope').mockResolvedValue({
      id: 'group-call-1',
      ontology: documentedOntologyId('call-recording'),
      parsed: {
        chatId: 'group-chat',
        participants: ['@other.w3id'],
        recording: {
          mediaIsVideo: true,
          recordingVault: '@media.w3id',
          mediaUri: 'w3ds://file?id=@media.w3id/hedged-group-denial',
        },
      },
    });
    const groupManifest = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    const dereference = vi.spyOn(internals, 'tryDereferenceFileMediaUrl');
    stubInteractivePlatformToken();

    try {
      const pending = library.resolveMediaUrl(
        viewer,
        exactGroupCallHistoryStream('hedged-group-denial'),
      );
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      expect(groupManifest).not.toHaveBeenCalled();

      releaseExactVault?.({ ownerEName: '@group.w3id', eVaultUri: 'https://group-vault.example' });
      await expect(pending).rejects.toThrow(
        expect.objectContaining({ code: 'authorization_denied', status: 403 }),
      );
      expect(dereference).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('starts the GroupManifest fallback only after an exact group CallSession is retryable', async () => {
    vi.useFakeTimers();
    const viewer = { eName: '@person.w3id' };
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    let rejectExactVault: ((error: unknown) => void) | undefined;
    const exactVault = new Promise<{ ownerEName: string; eVaultUri: string }>(
      (_resolve, reject) => {
        rejectExactVault = reject;
      },
    );
    vi.spyOn(internals, 'resolveEVault').mockReturnValue(exactVault);
    const groupManifest = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    vi.spyOn(internals, 'resolveEVaultLookup').mockResolvedValue({
      vault: { ownerEName: '@media.w3id', eVaultUri: 'https://media-vault.example' },
      cacheHit: false,
    });
    vi.spyOn(internals, 'tryDereferenceFileMediaUrl').mockResolvedValue(
      'https://media.example/hedged-group-retry.mp4',
    );
    stubInteractivePlatformToken();

    try {
      const pending = library.resolveMediaUrl(
        viewer,
        exactGroupCallHistoryStream('hedged-group-retry'),
      );
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      expect(groupManifest).not.toHaveBeenCalled();

      rejectExactVault?.(
        new MeshengerVideoLibraryError('source unavailable', 'remote_unavailable', 503),
      );
      await expect(pending).resolves.toBe('https://media.example/hedged-group-retry.mp4');
      // The wider fallback begins only after the file-specific proof is
      // inconclusive, avoiding an otherwise redundant eVault request.
      expect(groupManifest).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps fully addressed group CallSession reads out of background preview work', async () => {
    const library = configuredLibrary();
    const internals = exactCallProofInternals(library);
    const exactVault = vi.spyOn(internals, 'resolveEVault');
    const groupManifest = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });

    await expect(
      library.inspectPlayableStream(
        { eName: '@person.w3id' },
        exactGroupCallHistoryStream('background-group-call'),
        { priority: 'background' },
      ),
    ).resolves.toEqual({ fileUri: 'w3ds://file?id=@media.w3id/background-group-call' });

    expect(exactVault).not.toHaveBeenCalled();
    expect(groupManifest).toHaveBeenCalledOnce();
  });

  it('denies a historic share when both concurrent source proofs are non-positive', async () => {
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation((_user, source) =>
        Promise.resolve(
          source.kind === 'direct'
            ? ({ access: 'missing', member: false } as const)
            : ({ access: 'denied', member: false } as const),
        ),
      );
    stubInteractivePlatformToken();

    try {
      await expect(
        library.inspectPlayableStream(
          { eName: '@person.w3id' },
          historySharedStream('history-both-negative'),
          { priority: 'interactive' },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied', status: 403 }));
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a historic share retryable when one concurrent source proof must retry', async () => {
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation((_user, source) =>
        Promise.resolve(
          source.kind === 'direct'
            ? ({ access: 'retry', member: false } as const)
            : ({ access: 'missing', member: false } as const),
        ),
      );
    stubInteractivePlatformToken();

    try {
      await expect(
        library.inspectPlayableStream(
          { eName: '@person.w3id' },
          historySharedStream('history-retry'),
          { priority: 'interactive' },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'remote_unavailable', status: 503 }));
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds a slow historic Chat proof without denying a concurrent GroupManifest proof', async () => {
    const library = configuredLibrary();
    const directDeadline = new AbortController();
    const groupDeadline = new AbortController();
    const proofDeadlines = [directDeadline, groupDeadline];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      if (milliseconds === 8_000) {
        const next = proofDeadlines.shift();
        if (!next) throw new Error('Unexpected extra interactive shared-proof deadline.');
        return next.signal;
      }
      // The speculative platform-token request retains its ordinary request
      // timeout; it is unrelated to the proof deadline under test.
      return new AbortController().signal;
    });
    let directSignal: AbortSignal | undefined;
    let releaseGroup: (access: SharedAccessResult) => void = () => undefined;
    const group = new Promise<SharedAccessResult>((resolve) => {
      releaseGroup = resolve;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation((_user, source, _rateLimit, options) => {
        if (source.kind !== 'direct') return group;
        directSignal = options?.signal;
        return new Promise<SharedAccessResult>((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => resolve({ access: 'retry', member: false }),
            { once: true },
          );
        });
      });
    stubInteractivePlatformToken();

    try {
      const pending = library.inspectPlayableStream(
        { eName: '@person.w3id' },
        historySharedStream('history-proof-deadline'),
        { priority: 'interactive' },
      );
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

      directDeadline.abort();
      await vi.waitFor(() => expect(directSignal?.aborted).toBe(true));
      // A deadline is only an inconclusive source read. The independent
      // current GroupManifest proof still authorizes the same stream.
      releaseGroup({ access: 'ok', member: true });

      await expect(pending).resolves.toEqual({
        fileUri: 'w3ds://file?id=@friend.w3id/history-proof-deadline',
      });
      expect(timeout.mock.calls.filter(([milliseconds]) => milliseconds === 8_000)).toHaveLength(2);
      expect(groupDeadline.signal.aborted).toBe(false);
    } finally {
      releaseGroup({ access: 'missing', member: false });
      await group;
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('aborts an overdue interactive shared-source request and returns a retryable failure', async () => {
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) =>
        milliseconds === 8_000 ? deadline.signal : originalTimeout(milliseconds),
      );
    let graphQlAborted = false;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              graphQlAborted = true;
              reject(new Error('request aborted'));
            },
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/overdue-shared-proof',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );

    try {
      const pending = configuredLibrary().inspectPlayableStream(
        { eName: '@person.w3id' },
        streamId,
        { priority: 'interactive' },
      );
      await vi.waitFor(() =>
        expect(
          fetcher.mock.calls.some(
            ([url]) =>
              (url as URL).hostname === 'friend-vault.example' &&
              (url as URL).pathname === '/graphql',
          ),
        ).toBe(true),
      );

      deadline.abort();
      await expect(pending).rejects.toThrow(
        expect.objectContaining({ code: 'remote_unavailable', status: 503 }),
      );
      expect(graphQlAborted).toBe(true);
      expect(timeout).toHaveBeenCalledWith(8_000);
    } finally {
      deadline.abort();
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('preserves caller cancellation instead of turning it into a retryable proof deadline', async () => {
    const library = configuredLibrary();
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation(async (_user, _source, _rateLimit, options) => {
        observedSignal = options?.signal;
        return new Promise<SharedAccessResult>((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => resolve({ access: 'retry', member: false }),
            { once: true },
          );
        });
      });
    stubInteractivePlatformToken();

    try {
      const pending = library.inspectPlayableStream(
        { eName: '@person.w3id' },
        historySharedStream('history-proof-cancellation'),
        { priority: 'interactive', signal: caller.signal },
      );
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

      caller.abort();
      await expect(pending).rejects.toThrow('Background media resolution was cancelled.');
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      caller.abort();
      vi.unstubAllGlobals();
    }
  });

  it('coalesces each concurrent historic source proof across independent authorization checks', async () => {
    const library = configuredLibrary();
    let releaseDirect: (access: SharedAccessResult) => void = () => undefined;
    const direct = new Promise<SharedAccessResult>((resolve) => {
      releaseDirect = resolve;
    });
    let releaseGroup: (access: SharedAccessResult) => void = () => undefined;
    const group = new Promise<SharedAccessResult>((resolve) => {
      releaseGroup = resolve;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation((_user, source) => (source.kind === 'direct' ? direct : group));
    stubInteractivePlatformToken();
    const streamId = historySharedStream('history-coalesced');

    try {
      const first = library.inspectPlayableStream({ eName: '@person.w3id' }, streamId, {
        priority: 'interactive',
      });
      const second = library.inspectPlayableStream({ eName: '@person.w3id' }, streamId, {
        priority: 'interactive',
      });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

      releaseGroup({ access: 'ok', member: true });
      await expect(Promise.all([first, second])).resolves.toEqual([
        { fileUri: 'w3ds://file?id=@friend.w3id/history-coalesced' },
        { fileUri: 'w3ds://file?id=@friend.w3id/history-coalesced' },
      ]);
    } finally {
      releaseDirect({ access: 'missing', member: false });
      releaseGroup({ access: 'missing', member: false });
      await Promise.all([direct, group]);
      vi.unstubAllGlobals();
    }
  });

  it('uses one owner registry lookup for a legacy W3DS File', async () => {
    const library = configuredLibrary();
    let releaseFriendResolve: () => void = () => undefined;
    const friendResolve = new Promise<Response>((resolve) => {
      releaseFriendResolve = () =>
        resolve(json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }));
    });
    let registryRequests = 0;
    let groupManifestReads = 0;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        registryRequests += 1;
        return friendResolve;
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'platform-token' }));
      }
      if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          variables?: { chatId?: string };
        };
        if (body.variables?.chatId === 'shared-chat') {
          return Promise.resolve(
            json({
              data: {
                metaEnvelopes: {
                  edges: [
                    {
                      node: {
                        id: 'viewer-chat-reference',
                        ontology: documentedAuthorizationOntologies.chat,
                        parsed: {
                          isReference: true,
                          canonicalOwnerEName: '@friend.w3id',
                          canonicalChatId: 'shared-chat',
                          type: 'direct',
                        },
                        envelopes: [],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          );
        }
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          variables?: { ontologyId?: string };
        };
        if (body.variables?.ontologyId === documentedAuthorizationOntologies.groupManifest) {
          groupManifestReads += 1;
          return Promise.resolve(
            json({
              data: {
                metaEnvelopes: {
                  edges: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          );
        }
      }
      if (url.pathname === '/files/interactive-registry') {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/interactive-registry.mp4' },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/interactive-registry',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'shared-chat',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      const pending = library.resolveMediaUrl(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        streamId,
        { priority: 'interactive' },
      );
      await vi.waitFor(() => expect(registryRequests).toBe(1));
      // The portable File path resolves only the owner directory before its
      // standard dereference; it does not need a Meshenger Chat mirror.
      expect(registryRequests).toBe(1);

      releaseFriendResolve();
      await expect(pending).resolves.toBe('https://media.example/interactive-registry.mp4');
      expect(registryRequests).toBe(1);
      expect(groupManifestReads).toBe(0);
    } finally {
      releaseFriendResolve();
      vi.unstubAllGlobals();
    }
  });

  it('overlaps a shared authorization proof with directory resolution without dereferencing early', async () => {
    const library = configuredLibrary();
    const authorizationContexts: MediaAuthorizationTimingContext[] = [];
    let approve: (access: SharedAccessResult) => void = () => undefined;
    const authorization = new Promise<SharedAccessResult>((resolve) => {
      approve = resolve;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation(async () => authorization);
    let registryRequests = 0;
    let fileRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          registryRequests += 1;
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/overlap-file') {
          fileRequests += 1;
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/overlap-file.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/overlap-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );

    try {
      const pending = library.resolveMediaUrl({ eName: grant.eName }, streamId, {
        priority: 'interactive',
        onAuthorizationContext: (context) => authorizationContexts.push(context),
      });
      await vi.waitFor(() => expect(registryRequests).toBe(1));
      expect(fileRequests).toBe(0);
      expect(authorizationContexts).toEqual([
        {
          accessBasis: 'membership',
          proofKind: 'group',
          sharedProofDeadlineMs: 8_000,
          viewerChatGrantHint: false,
        },
      ]);

      approve({ access: 'ok', member: true });
      await expect(pending).resolves.toBe('https://media.example/overlap-file.mp4');
      expect(fileRequests).toBe(1);
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        { eName: '@friend.w3id', kind: 'group' },
        'interactive',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prefetches a shared platform token during directory resolution without dereferencing early', async () => {
    const library = configuredLibrary();
    let releaseRegistry: () => void = () => undefined;
    const registry = new Promise<Response>((resolve) => {
      releaseRegistry = () =>
        resolve(json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }));
    });
    let approveMembership: () => void = () => undefined;
    const membership = new Promise<Response>((resolve) => {
      approveMembership = () =>
        resolve(
          json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'group-manifest',
                      ontology: documentedAuthorizationOntologies.groupManifest,
                      parsed: {
                        eName: '@friend.w3id',
                        owner: '@friend.w3id',
                        admins: [],
                        members: ['@person.w3id'],
                      },
                      envelopes: [],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        );
    });
    let registryRequests = 0;
    let platformTokenRequests = 0;
    let groupAuthorizationRequests = 0;
    let fileRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        if (url.pathname === '/resolve') {
          registryRequests += 1;
          return registry;
        }
        if (url.pathname === '/platforms/certification') {
          platformTokenRequests += 1;
          return Promise.resolve(json({ token: 'platform-token' }));
        }
        if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
          groupAuthorizationRequests += 1;
          return membership;
        }
        if (url.hostname === 'friend-vault.example' && url.pathname === '/files/prefetch-file') {
          fileRequests += 1;
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/prefetch-file.mp4' },
            }),
          );
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/prefetch-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );

    try {
      const pending = library.resolveMediaUrl({ eName: grant.eName }, streamId, {
        priority: 'interactive',
      });

      // The credential starts while the mandatory source directory lookup is
      // still unresolved. The GroupManifest and File requests remain blocked.
      await vi.waitFor(() => expect(platformTokenRequests).toBe(1));
      expect(registryRequests).toBe(1);
      expect(groupAuthorizationRequests).toBe(0);
      expect(fileRequests).toBe(0);

      releaseRegistry();
      await vi.waitFor(() => expect(groupAuthorizationRequests).toBe(1));
      expect(fileRequests).toBe(0);

      approveMembership();
      await expect(pending).resolves.toBe('https://media.example/prefetch-file.mp4');
      expect(fileRequests).toBe(1);
    } finally {
      releaseRegistry();
      approveMembership();
      vi.unstubAllGlobals();
    }
  });

  it.each(['background', 'warmup'] as const)(
    'does not prefetch a platform token for cancellable %s shared work',
    async (priority) => {
      const library = configuredLibrary();
      const controller = new AbortController();
      let registryRequests = 0;
      let platformTokenRequests = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: URL, init?: RequestInit) => {
          if (url.pathname === '/resolve') {
            registryRequests += 1;
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new Error('background source read aborted')),
                { once: true },
              );
            });
          }
          if (url.pathname === '/platforms/certification') {
            platformTokenRequests += 1;
            return Promise.resolve(json({ token: 'platform-token' }));
          }
          throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
        }),
      );
      const streamId = createMeshengerVideoStreamId(
        {
          ...grant,
          fileUri: 'w3ds://file?id=@friend.w3id/background-prefetch-file',
          accessScope: 'shared',
          sourceSpaceKey: '@friend.w3id',
          accessBasis: 'membership',
        },
        secret,
      );

      try {
        const pending = library.resolveMediaUrl({ eName: grant.eName }, streamId, {
          priority,
          signal: controller.signal,
        });
        await vi.waitFor(() => expect(registryRequests).toBe(1));
        expect(platformTokenRequests).toBe(0);

        controller.abort();
        await expect(pending).rejects.toThrow('Background media resolution was cancelled.');
      } finally {
        controller.abort();
        vi.unstubAllGlobals();
      }
    },
  );

  it('rechecks a cached shared redirect after its short source proof expires', async () => {
    vi.useFakeTimers();
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValueOnce({ access: 'ok', member: true })
      .mockResolvedValue({ access: 'denied', member: false });
    let directRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/cached-shared-file') {
          directRequests += 1;
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/cached-shared.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/cached-shared-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
        // Keep the signed grant valid beyond the short exact-file proof.
        expiresAt: Date.now() + 5 * 60_000,
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/cached-shared.mp4',
      );
      // The successful source verification is cached for one minute. Once it
      // expires, a revoked source must be checked again before the cached
      // redirect can be reused.
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).rejects.toThrow(
        expect.objectContaining({ code: 'authorization_denied', status: 403 }),
      );
      expect(probe).toHaveBeenCalledTimes(2);
      expect(directRequests).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps resumable work preempted while an interactive shared redirect is warming', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
    const library = configuredLibrary();
    let releaseProof: (access: SharedAccessResult) => void = () => undefined;
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValueOnce({ access: 'ok', member: true })
      .mockImplementationOnce(
        () =>
          new Promise<SharedAccessResult>((resolve) => {
            releaseProof = resolve;
          }),
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.pathname === '/files/cached-priority-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/cached-priority.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/cached-priority-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
        expiresAt: Date.now() + 5 * 60_000,
      },
      secret,
    );
    let inventory: ReturnType<typeof beginBackgroundWork> | undefined;

    try {
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/cached-priority.mp4',
      );
      // The first cold start has already taken its bounded player reservation.
      // A verified cached Range request must not let inventory restart in the
      // middle of that opening window merely because its source redirect is
      // already cached.
      await vi.advanceTimersByTimeAsync(5_001);
      const verifiedRange = beginBackgroundWork();
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/cached-priority.mp4',
      );
      expect(verifiedRange.signal.aborted).toBe(true);
      verifiedRange.release();

      // Keep the URL cache, but make its current source proof unavailable so
      // the next cached request must perform the authoritative recheck.
      resetSharedAccessCacheForTests();
      inventory = beginBackgroundWork();
      const pending = library.resolveMediaUrl({ eName: grant.eName }, streamId, {
        priority: 'interactive',
      });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

      expect(inventory.signal.aborted).toBe(true);
      expect(backgroundWorkDelayMs()).toBeGreaterThan(8_000);

      releaseProof({ access: 'ok', member: true });
      await expect(pending).resolves.toBe('https://media.example/cached-priority.mp4');
    } finally {
      releaseProof({ access: 'retry', member: false });
      inventory?.release();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('reuses a fresh library verification when the viewer opens that shared video', async () => {
    const library = configuredLibrary();
    const viewer = '@library-cache-viewer.w3id';
    const source = {
      eName: '@library-cache-friend.w3id',
      kind: 'direct' as const,
      chatId: 'chat-1',
    };
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    rememberVerifiedSharedAccess(viewer, source);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({
            ename: '@library-cache-friend.w3id',
            uri: 'https://library-cache-friend-vault.example',
          });
        }
        if (url.pathname === '/files/library-cache-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/library-cache.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        eName: viewer,
        fileUri: 'w3ds://file?id=@library-cache-friend.w3id/library-cache-file',
        accessScope: 'shared',
        sourceSpaceKey: source.eName,
        sourceChatId: source.chatId,
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: viewer }, streamId)).resolves.toBe(
        'https://media.example/library-cache.mp4',
      );
      expect(probe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reuses current viewer Chat grants read by both fresh catalogue paths', async () => {
    const viewer = '@person.w3id';
    const source = '@friend.w3id';
    const chatId = 'chat-current';
    const fileUri = 'w3ds://file?id=@friend.w3id/current-chat-file';
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        eName: viewer,
        fileUri,
        accessScope: 'shared',
        sourceSpaceKey: source,
        sourceChatId: chatId,
        accessBasis: 'history',
      },
      secret,
    );
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: source, uri: 'https://friend-vault.example' });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        variables?: { ontologyId?: string };
      };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === documentedAuthorizationOntologies.chat
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'viewer-current-chat',
                    ontology: documentedAuthorizationOntologies.chat,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: source,
                      canonicalChatId: chatId,
                      type: 'direct',
                    },
                    envelopes: [],
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
      const freshLibrary = configuredLibrary();
      const freshProbe = vi.spyOn(freshLibrary, 'probeSharedSpaceAccess');
      await freshLibrary.listWithContext(
        { eName: viewer, eVaultUri: 'https://person-vault.example' },
        { scope: 'shared' },
      );
      await expect(
        freshLibrary.inspectPlayableStream(
          { eName: viewer, eVaultUri: 'https://person-vault.example' },
          streamId,
          { priority: 'interactive' },
        ),
      ).resolves.toEqual({ fileUri });
      expect(freshProbe).not.toHaveBeenCalled();

      // The production grid consumes the durable scan path. Clear only the
      // process-local proof result before exercising that independently.
      resetSharedAccessCacheForTests();
      const durableLibrary = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: createMemoryInventoryJobStore() },
      );
      const durableProbe = vi.spyOn(durableLibrary, 'probeSharedSpaceAccess');
      await durableLibrary.scanLibrary(
        { eName: viewer, eVaultUri: 'https://person-vault.example' },
        { scope: 'shared', onSnapshot: () => undefined },
      );
      await expect(
        durableLibrary.inspectPlayableStream(
          { eName: viewer, eVaultUri: 'https://person-vault.example' },
          streamId,
          { priority: 'interactive' },
        ),
      ).resolves.toEqual({ fileUri });
      expect(durableProbe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('seeds a GroupManifest proof only from the matching bounded group-open read', async () => {
    const viewer = '@person.w3id';
    const group = '@current-group.w3id';
    const chatId = 'group-current';
    const fileUri = 'w3ds://file?id=@current-group.w3id/current-group-file';
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        eName: viewer,
        fileUri,
        accessScope: 'shared',
        sourceSpaceKey: group,
        accessBasis: 'membership',
      },
      secret,
    );
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: group, uri: 'https://current-group-vault.example' });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        variables?: { ontologyId?: string };
      };
      if (
        url.hostname === 'person-vault.example' &&
        body.variables?.ontologyId === documentedAuthorizationOntologies.chat
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'viewer-current-group-chat',
                    ontology: documentedAuthorizationOntologies.chat,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: group,
                      canonicalChatId: chatId,
                      type: 'group',
                    },
                    envelopes: [],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (
        url.hostname === 'current-group-vault.example' &&
        body.variables?.ontologyId === documentedAuthorizationOntologies.groupManifest
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'current-group-manifest',
                    ontology: documentedAuthorizationOntologies.groupManifest,
                    parsed: { owner: group, members: [viewer] },
                    envelopes: [],
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
      const freshLibrary = configuredLibrary();
      const freshProbe = vi
        .spyOn(freshLibrary, 'probeSharedSpaceAccess')
        .mockResolvedValue({ access: 'ok', member: true });
      await freshLibrary.listWithContext(
        { eName: viewer, eVaultUri: 'https://person-vault.example' },
        { scope: 'shared' },
      );
      // The full discovery path may page further than the verifier's first
      // GroupManifest read, so it must not seed a playback proof.
      await expect(
        freshLibrary.inspectPlayableStream(
          { eName: viewer, eVaultUri: 'https://person-vault.example' },
          streamId,
          { priority: 'interactive' },
        ),
      ).resolves.toEqual({ fileUri });
      expect(freshProbe).toHaveBeenCalledTimes(1);

      resetSharedAccessCacheForTests();
      const durableLibrary = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: createMemoryInventoryJobStore() },
      );
      const durableProbe = vi.spyOn(durableLibrary, 'probeSharedSpaceAccess');
      await durableLibrary.scanLibrary(
        { eName: viewer, eVaultUri: 'https://person-vault.example' },
        { scope: 'shared', onSnapshot: () => undefined },
      );
      await expect(
        durableLibrary.inspectPlayableStream(
          { eName: viewer, eVaultUri: 'https://person-vault.example' },
          streamId,
          { priority: 'interactive' },
        ),
      ).resolves.toEqual({ fileUri });
      expect(durableProbe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('warms a shared source before Watch without streaming media bytes', async () => {
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/warm-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'chat-warm',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      const fetcher = vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.pathname === '/files/warm-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/warm-video.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      vi.stubGlobal('fetch', fetcher);
      await expect(library.authorizePlayableStream({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/warm-video.mp4',
      );
      expect(probe).not.toHaveBeenCalled();
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/warm-video.mp4',
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('briefly waits for the canonical eVault handoff before completing Watch authorization', async () => {
    let finishWrite: ((value: boolean) => void) | undefined;
    const durableCache: EVaultMediaUrlCache = {
      get: vi.fn().mockResolvedValue({ writeToken: 'cache-write-token-1234567890' }),
      put: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishWrite = resolve;
          }),
      ),
      invalidate: vi.fn(),
    };
    setEVaultMediaUrlCacheForTests(durableCache);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@person.w3id/handoff-file',
      },
      secret,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
        }
        if (url.pathname === '/files/handoff-file') {
          return new Response(null, {
            status: 302,
            headers: {
              location: `https://media.example/handoff.mp4?expires=${Math.floor(
                (Date.now() + 120_000) / 1_000,
              )}&signature=test-source`,
            },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );

    let settled = false;
    const pending = configuredLibrary()
      .authorizePlayableStream({ eName: grant.eName }, streamId)
      .then((mediaUrl) => {
        settled = true;
        return mediaUrl;
      });
    try {
      await vi.waitFor(() => expect(durableCache.put).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      finishWrite?.(true);
      await expect(pending).resolves.toContain('https://media.example/handoff.mp4');
    } finally {
      finishWrite?.(false);
      vi.unstubAllGlobals();
    }
  });

  it('reuses the registry platform credential across request-scoped libraries', async () => {
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
      }
      if (url.pathname === '/files/file-a' || url.pathname === '/files/file-b') {
        // A 404 can describe one stale File, not an endpoint-wide capability.
        // Each record falls back independently while the registry credential
        // remains reusable across request-scoped libraries.
        return new Response(null, { status: 404 });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
        const variables = JSON.parse(String(init?.body ?? '{}')).variables as { id?: string };
        return json({
          data: {
            metaEnvelope: {
              id: variables.id,
              ontology: 'w3ds-file',
              parsed: { url: `https://media.example/${variables.id}.mp4` },
              envelopes: [],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const stream = (fileId: string) =>
      createMeshengerVideoStreamId(
        { ...grant, fileUri: `w3ds://file?id=@person.w3id/${fileId}` },
        secret,
      );

    try {
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: grant.eName }, stream('file-a')),
      ).resolves.toBe('https://media.example/file-a.mp4');
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: grant.eName }, stream('file-b')),
      ).resolves.toBe('https://media.example/file-b.mp4');

      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/platforms/certification'),
      ).toHaveLength(1);
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname.startsWith('/files/')),
      ).toHaveLength(2);
      const graphQlHeaders = fetcher.mock.calls
        .filter(
          ([url]) =>
            (url as URL).hostname === 'person-vault.example' &&
            (url as URL).pathname === '/graphql',
        )
        .map(([, init]) => new Headers((init as RequestInit | undefined)?.headers));
      expect(graphQlHeaders).toHaveLength(2);
      for (const headers of graphQlHeaders) {
        expect(headers.get('X-ENAME')).toBe('@person.w3id');
        expect(headers.get('Authorization')).toBe('Bearer platform-token');
        expect(headers.get('X-ON-BEHALF-OF')).toBeNull();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('briefly skips a timing-out optional File redirect instead of paying for it on every video', async () => {
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
      }
      if (url.pathname.startsWith('/files/')) {
        throw new TypeError('direct File endpoint timed out');
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
        const variables = JSON.parse(String(init?.body ?? '{}')).variables as { id?: string };
        return json({
          data: {
            metaEnvelope: {
              id: variables.id,
              ontology: 'w3ds-file',
              parsed: { url: `https://media.example/${variables.id}.mp4` },
              envelopes: [],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const stream = (fileId: string) =>
      createMeshengerVideoStreamId(
        { ...grant, fileUri: `w3ds://file?id=@person.w3id/${fileId}` },
        secret,
      );

    try {
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: grant.eName }, stream('slow-file-a')),
      ).resolves.toBe('https://media.example/slow-file-a.mp4');
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: grant.eName }, stream('slow-file-b')),
      ).resolves.toBe('https://media.example/slow-file-b.mp4');

      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname.startsWith('/files/')),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens a portable legacy File when a source mirror omits the viewer', async () => {
    const library = configuredLibrary();
    let groupManifestReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/resolve') {
          const requested = url.searchParams.get('w3id');
          return json(
            requested === '@person.w3id'
              ? { ename: '@person.w3id', uri: 'https://person-vault.example' }
              : { ename: '@friend.w3id', uri: 'https://friend-vault.example' },
          );
        }
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            variables?: { ontologyId?: string };
          };
          if (body.variables?.ontologyId === documentedAuthorizationOntologies.chat) {
            return json({
              data: {
                metaEnvelopes: {
                  edges: [
                    {
                      node: {
                        id: 'viewer-chat-reference',
                        ontology: documentedAuthorizationOntologies.chat,
                        parsed: {
                          isReference: true,
                          canonicalOwnerEName: '@friend.w3id',
                          canonicalChatId: 'chat-1',
                          type: 'direct',
                        },
                        envelopes: [],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            });
          }
        }
        if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            variables?: { ontologyId?: string };
          };
          if (body.variables?.ontologyId === documentedAuthorizationOntologies.groupManifest) {
            groupManifestReads += 1;
            return json({
              data: {
                metaEnvelopes: {
                  edges: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            });
          }
          if (body.variables?.ontologyId === documentedAuthorizationOntologies.chat) {
            return json({
              data: {
                metaEnvelopes: {
                  edges: [
                    {
                      node: {
                        id: 'chat-1',
                        ontology: documentedAuthorizationOntologies.chat,
                        parsed: { id: 'chat-1', participantIds: [] },
                        envelopes: [],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            });
          }
        }
        if (url.hostname === 'friend-vault.example' && url.pathname === '/files/shared-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/shared-video.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/shared-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'chat-1',
        accessBasis: 'history',
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/shared-video.mp4',
      );
      expect(groupManifestReads).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses one exact Chat authorization lookup instead of paging source chat history', async () => {
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { chatId?: string; first?: number };
        };
        expect(body.query).toContain('ExactChatAuthorization');
        expect(body.query).not.toContain('query AuthorizedMedia');
        expect(body.variables).toMatchObject({ chatId: 'chat-1', first: 8 });
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'chat-1',
                    ontology: documentedAuthorizationOntologies.chat,
                    parsed: { id: 'chat-1', participantIds: ['@person.w3id'] },
                    envelopes: [],
                  },
                },
              ],
              // A full history scan would now request another page. Exact
              // authorization must stop after this one matching query.
              pageInfo: { hasNextPage: true, endCursor: 'unrelated-history' },
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
          { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(
        fetcher.mock.calls.filter(
          ([url]) =>
            (url as URL).hostname === 'friend-vault.example' &&
            (url as URL).pathname === '/graphql',
        ),
      ).toHaveLength(1);
      expect(
        fetcher.mock.calls.filter(
          ([url]) =>
            (url as URL).pathname === '/resolve' &&
            (url as URL).searchParams.get('w3id') === '@friend.w3id',
        ),
      ).toHaveLength(1);
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            (url as URL).pathname === '/resolve' &&
            (url as URL).searchParams.get('w3id') === '@person.w3id',
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a sealed current GroupManifest id before any searchable manifest lookup', async () => {
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'group-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { id?: string };
        };
        expect(body.query).toContain('MeshengerVideoEnvelope');
        expect(body.query).not.toContain('ExactGroupManifestAuthorization');
        expect(body.variables?.id).toBe('current-group-manifest');
        return json({
          data: {
            metaEnvelope: {
              id: 'current-group-manifest',
              ontology: documentedAuthorizationOntologies.groupManifestPrimary,
              parsed: {
                eName: '@group.w3id',
                owner: '@group-owner.w3id',
                admins: [],
                members: ['@person.w3id'],
              },
              envelopes: [],
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id' },
          {
            eName: '@group.w3id',
            kind: 'group',
            manifestId: 'current-group-manifest',
          },
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(
        fetcher.mock.calls.filter(
          ([url]) =>
            (url as URL).hostname === 'group-vault.example' && (url as URL).pathname === '/graphql',
        ),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when a sealed GroupManifest id is stale or mismatched', async () => {
    let pointedReads = 0;
    let searchedReads = 0;
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'group-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { id?: string };
        };
        if (body.query?.includes('MeshengerVideoEnvelope')) {
          pointedReads += 1;
          return json({
            data: {
              metaEnvelope: {
                id: body.variables?.id,
                ontology: documentedAuthorizationOntologies.groupManifestPrimary,
                parsed: {
                  eName: '@another-group.w3id',
                  owner: '@group-owner.w3id',
                  admins: [],
                  members: ['@person.w3id'],
                },
                envelopes: [],
              },
            },
          });
        }
        if (body.query?.includes('ExactGroupManifestAuthorization')) {
          searchedReads += 1;
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'current-group-manifest',
                      ontology: documentedAuthorizationOntologies.groupManifestPrimary,
                      parsed: {
                        eName: '@group.w3id',
                        owner: '@group-owner.w3id',
                        admins: [],
                        members: ['@person.w3id'],
                      },
                      envelopes: [],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id' },
          { eName: '@group.w3id', kind: 'group', manifestId: 'stale-group-manifest' },
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(pointedReads).toBe(1);
      expect(searchedReads).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fan a temporary pointed GroupManifest outage into a broad search', async () => {
    let searchedReads = 0;
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'group-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
        if (body.query?.includes('MeshengerVideoEnvelope')) {
          return new Response('source unavailable', { status: 503 });
        }
        if (body.query?.includes('ExactGroupManifestAuthorization')) searchedReads += 1;
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id' },
          { eName: '@group.w3id', kind: 'group', manifestId: 'current-group-manifest' },
        ),
      ).resolves.toEqual({ access: 'retry', member: false });
      expect(searchedReads).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the exact GroupManifest eName lookup before a broad manifest scan', async () => {
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'group-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { ontologyId?: string; groupEName?: string; first?: number };
        };
        expect(body.query).toContain('ExactGroupManifestAuthorization');
        expect(body.query).not.toContain('query AuthorizedMedia');
        expect(body.query).toContain('fields: ["eName"]');
        expect(body.query).toContain('mode: EXACT');
        expect(body.query).toContain('caseSensitive: true');
        expect(body.variables).toMatchObject({
          ontologyId: documentedAuthorizationOntologies.groupManifestPrimary,
          groupEName: '@group.w3id',
          first: 8,
        });
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'current-group-manifest',
                    ontology: documentedAuthorizationOntologies.groupManifestPrimary,
                    parsed: {
                      eName: '@group.w3id',
                      owner: '@group-owner.w3id',
                      admins: [],
                      members: ['@person.w3id'],
                    },
                    envelopes: [],
                  },
                },
              ],
              // A matching exact manifest is enough; unrelated group records
              // must never force a second page on the playback path.
              pageInfo: { hasNextPage: true, endCursor: 'unrelated-manifests' },
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id' },
          { eName: '@group.w3id', kind: 'group' },
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(
        fetcher.mock.calls.filter(
          ([url]) =>
            (url as URL).hostname === 'group-vault.example' && (url as URL).pathname === '/graphql',
        ),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the one-page GroupManifest scan for legacy records without a searchable eName', async () => {
    let exactReads = 0;
    let broadReads = 0;
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'group-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { ontologyId?: string };
        };
        if (body.query?.includes('ExactGroupManifestAuthorization')) {
          exactReads += 1;
          return json({
            data: {
              metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          });
        }
        if (
          body.query?.includes('AuthorizedMedia') &&
          body.variables?.ontologyId === documentedAuthorizationOntologies.groupManifest
        ) {
          broadReads += 1;
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'legacy-group-manifest',
                      ontology: documentedAuthorizationOntologies.groupManifest,
                      parsed: { owner: '@group-owner.w3id', members: ['@person.w3id'] },
                      envelopes: [],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (body.query?.includes('AuthorizedMedia')) {
          return json({
            data: {
              metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          });
        }
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id' },
          { eName: '@group.w3id', kind: 'group' },
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(exactReads).toBe(2);
      expect(broadReads).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the established GroupManifest scan when an older eVault rejects exact search', async () => {
    let exactReads = 0;
    let broadReads = 0;
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'group-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { ontologyId?: string };
        };
        if (body.query?.includes('ExactGroupManifestAuthorization')) {
          exactReads += 1;
          // An eVault that predates the documented search mode reports this
          // as a GraphQL rejection. The optional fast path must not turn a
          // record that the old bounded read can authorize into an outage.
          return json({ errors: [{ message: 'Unknown search mode EXACT' }] });
        }
        if (
          body.query?.includes('AuthorizedMedia') &&
          body.variables?.ontologyId === documentedAuthorizationOntologies.groupManifest
        ) {
          broadReads += 1;
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'legacy-group-manifest',
                      ontology: documentedAuthorizationOntologies.groupManifest,
                      parsed: { owner: '@group-owner.w3id', members: ['@person.w3id'] },
                      envelopes: [],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (body.query?.includes('AuthorizedMedia')) {
          return json({
            data: {
              metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          });
        }
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id' },
          { eName: '@group.w3id', kind: 'group' },
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(exactReads).toBe(2);
      expect(broadReads).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not multiply a temporary exact GroupManifest failure with a broad scan', async () => {
    let broadReads = 0;
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.hostname === 'group-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
        if (body.query?.includes('ExactGroupManifestAuthorization')) {
          return new Response('source unavailable', { status: 503 });
        }
        if (body.query?.includes('AuthorizedMedia')) broadReads += 1;
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().probeSharedSpaceAccess(
          { eName: '@person.w3id' },
          { eName: '@group.w3id', kind: 'group' },
          'fail-fast',
        ),
      ).resolves.toEqual({ access: 'retry', member: false });
      expect(broadReads).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the current viewer Chat-grant hint before searching legacy Chat history for Watch and hover warmup', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let hintedReads = 0;
    let indexedLookups = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            query?: string;
            variables?: { id?: string };
          };
          if (body.query?.includes('MeshengerVideoEnvelope')) {
            hintedReads += 1;
            expect(body.variables?.id).toBe('viewer-chat-grant');
            return json({
              data: {
                metaEnvelope: {
                  id: 'viewer-chat-grant',
                  ontology: documentedAuthorizationOntologies.chat,
                  parsed: {
                    isReference: true,
                    canonicalOwnerEName: '@friend.w3id',
                    canonicalChatId: 'chat-1',
                  },
                  envelopes: [],
                },
              },
            });
          }
          if (body.query?.includes('ExactChatAuthorization')) indexedLookups += 1;
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    try {
      for (const rateLimit of ['interactive', 'warmup-cancellable'] as const) {
        await expect(
          internals.probeViewerChatGrantAccess(
            { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
            {
              eName: '@friend.w3id',
              chatId: 'chat-1',
              viewerChatGrantId: 'viewer-chat-grant',
            },
            rateLimit,
          ),
        ).resolves.toEqual({ access: 'ok', member: true });
      }
      expect(hintedReads).toBe(2);
      expect(indexedLookups).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a durable viewer Chat pointer before searching legacy shared history for Watch and hover warmup', async () => {
    const pointers = new InMemoryViewerChatGrantPointerStore();
    await pointers.upsert({
      viewerEName: '@person.w3id',
      sourceEName: '@friend.w3id',
      sourceChatId: 'chat-1',
      viewerEnvelopeId: 'durable-viewer-chat-grant',
    });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { viewerChatGrantPointerStore: pointers },
    );
    const internals = directProbeInternals(library);
    let exactPointerReads = 0;
    let legacyLookups = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            query?: string;
            variables?: { id?: string };
          };
          if (body.query?.includes('MeshengerVideoEnvelope')) {
            exactPointerReads += 1;
            expect(body.variables?.id).toBe('durable-viewer-chat-grant');
            return json({
              data: {
                metaEnvelope: {
                  id: 'durable-viewer-chat-grant',
                  ontology: documentedAuthorizationOntologies.chat,
                  parsed: {
                    isReference: true,
                    canonicalOwnerEName: '@friend.w3id',
                    canonicalChatId: 'chat-1',
                  },
                  envelopes: [],
                },
              },
            });
          }
          if (body.query?.includes('ExactChatAuthorization')) legacyLookups += 1;
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    try {
      for (const rateLimit of ['interactive', 'warmup-cancellable'] as const) {
        await expect(
          internals.probeViewerChatGrantAccess(
            { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
            { eName: '@friend.w3id', chatId: 'chat-1' },
            rateLimit,
          ),
        ).resolves.toEqual({ access: 'ok', member: true });
      }
      expect(exactPointerReads).toBe(2);
      expect(legacyLookups).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a durable viewer Chat pointer when a sealed Chat hint is stale', async () => {
    const pointers = new InMemoryViewerChatGrantPointerStore();
    await pointers.upsert({
      viewerEName: '@person.w3id',
      sourceEName: '@friend.w3id',
      sourceChatId: 'chat-1',
      viewerEnvelopeId: 'durable-viewer-chat-grant',
    });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { viewerChatGrantPointerStore: pointers },
    );
    const internals = directProbeInternals(library);
    const exactReads: string[] = [];
    let legacyLookups = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            query?: string;
            variables?: { id?: string };
          };
          if (body.query?.includes('MeshengerVideoEnvelope')) {
            const id = body.variables?.id;
            if (id) exactReads.push(id);
            return json({
              data: {
                metaEnvelope: {
                  id,
                  ontology: documentedAuthorizationOntologies.chat,
                  parsed:
                    id === 'durable-viewer-chat-grant'
                      ? {
                          isReference: true,
                          canonicalOwnerEName: '@friend.w3id',
                          canonicalChatId: 'chat-1',
                        }
                      : {
                          isReference: true,
                          canonicalOwnerEName: '@different-friend.w3id',
                          canonicalChatId: 'chat-1',
                        },
                  envelopes: [],
                },
              },
            });
          }
          if (body.query?.includes('ExactChatAuthorization')) legacyLookups += 1;
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    try {
      await expect(
        internals.probeViewerChatGrantAccess(
          { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
          {
            eName: '@friend.w3id',
            chatId: 'chat-1',
            viewerChatGrantId: 'stale-viewer-chat-grant',
          },
          'interactive',
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(exactReads.sort()).toEqual(['durable-viewer-chat-grant', 'stale-viewer-chat-grant']);
      expect(legacyLookups).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('invalidates only a stale durable pointer and learns the replacement current grant', async () => {
    const pointers = new InMemoryViewerChatGrantPointerStore();
    const pointerScope = {
      viewerEName: '@person.w3id',
      sourceEName: '@friend.w3id',
      sourceChatId: 'chat-1',
    };
    await pointers.upsert({ ...pointerScope, viewerEnvelopeId: 'stale-viewer-chat-grant' });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { viewerChatGrantPointerStore: pointers },
    );
    const internals = directProbeInternals(library);
    let exactPointerReads = 0;
    let legacyLookups = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            query?: string;
            variables?: { id?: string };
          };
          if (body.query?.includes('MeshengerVideoEnvelope')) {
            exactPointerReads += 1;
            return json({
              data: {
                metaEnvelope: {
                  id: body.variables?.id,
                  ontology: documentedAuthorizationOntologies.chat,
                  parsed: {
                    isReference: true,
                    canonicalOwnerEName: '@different-friend.w3id',
                    canonicalChatId: 'chat-1',
                  },
                  envelopes: [],
                },
              },
            });
          }
          if (body.query?.includes('ExactChatAuthorization')) {
            legacyLookups += 1;
            return json({
              data: {
                metaEnvelopes: {
                  edges: [
                    {
                      node: {
                        id: 'replacement-viewer-chat-grant',
                        ontology: documentedAuthorizationOntologies.chat,
                        parsed: {
                          isReference: true,
                          canonicalOwnerEName: '@friend.w3id',
                          canonicalChatId: 'chat-1',
                        },
                        envelopes: [],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            });
          }
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    try {
      await expect(
        internals.probeViewerChatGrantAccess(
          { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
          { eName: '@friend.w3id', chatId: 'chat-1' },
          'interactive',
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(exactPointerReads).toBe(1);
      expect(legacyLookups).toBe(1);
      await vi.waitFor(async () => {
        await expect(
          pointers.listCandidates({ ...pointerScope, includeInactive: true, limit: 3 }),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              viewerEnvelopeId: 'stale-viewer-chat-grant',
              state: 'invalid',
            }),
            expect.objectContaining({
              viewerEnvelopeId: 'replacement-viewer-chat-grant',
              state: 'active',
            }),
          ]),
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when a viewer Chat-grant hint no longer matches the direct share', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let hintedReads = 0;
    let indexedLookups = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            query?: string;
            variables?: { id?: string };
          };
          if (body.query?.includes('MeshengerVideoEnvelope')) {
            hintedReads += 1;
            return json({
              data: {
                metaEnvelope: {
                  id: body.variables?.id,
                  ontology: documentedAuthorizationOntologies.chat,
                  parsed: {
                    isReference: true,
                    canonicalOwnerEName: '@different-friend.w3id',
                    canonicalChatId: 'chat-1',
                  },
                  envelopes: [],
                },
              },
            });
          }
          if (body.query?.includes('ExactChatAuthorization')) {
            indexedLookups += 1;
            return json({
              data: {
                metaEnvelopes: {
                  edges: [
                    {
                      node: {
                        id: 'replacement-chat-grant',
                        ontology: documentedAuthorizationOntologies.chat,
                        parsed: {
                          isReference: true,
                          canonicalOwnerEName: '@friend.w3id',
                          canonicalChatId: 'chat-1',
                        },
                        envelopes: [],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            });
          }
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    try {
      await expect(
        internals.probeViewerChatGrantAccess(
          { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
          {
            eName: '@friend.w3id',
            chatId: 'chat-1',
            viewerChatGrantId: 'stale-chat-grant',
          },
          'interactive',
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(hintedReads).toBe(1);
      expect(indexedLookups).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps an exact viewer Chat hint alive when an empty legacy lookup finishes first', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let releaseExact: (response: Response) => void = () => undefined;
    const exactResponse = new Promise<Response>((resolve) => {
      releaseExact = resolve;
    });
    let legacyLookupFinished: () => void = () => undefined;
    const legacyLookup = new Promise<void>((resolve) => {
      legacyLookupFinished = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') {
          return Promise.resolve(json({ token: 'platform-token' }));
        }
        if (url.hostname !== 'person-vault.example' || url.pathname !== '/graphql') {
          throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { id?: string };
        };
        if (
          body.query?.includes('MeshengerVideoEnvelope') &&
          body.variables?.id === 'viewer-chat-grant'
        ) {
          return exactResponse;
        }
        if (body.query?.includes('ExactChatAuthorization')) {
          return Promise.resolve(
            json({
              data: {
                metaEnvelopes: {
                  edges: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          );
        }
        legacyLookupFinished();
        return Promise.resolve(
          json({
            data: {
              metaEnvelopes: {
                edges: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        );
      }),
    );

    try {
      const pending = internals.findInteractiveViewerChatGrantAuthorizationEnvelopes(
        '@person.w3id',
        'https://person-vault.example',
        {
          eName: '@friend.w3id',
          chatId: 'chat-1',
          viewerChatGrantId: 'viewer-chat-grant',
        },
        '@person.w3id',
        'interactive',
      );
      await legacyLookup;
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseExact(
        json({
          data: {
            metaEnvelope: {
              id: 'viewer-chat-grant',
              ontology: documentedAuthorizationOntologies.chat,
              parsed: {
                isReference: true,
                canonicalOwnerEName: '@friend.w3id',
                canonicalChatId: 'chat-1',
              },
              envelopes: [],
            },
          },
        }),
      );

      await expect(pending).resolves.toEqual([
        expect.objectContaining({ id: 'viewer-chat-grant' }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps an exact viewer Chat hint alive when the legacy lookup fails first', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let releaseExact: (response: Response) => void = () => undefined;
    const exactResponse = new Promise<Response>((resolve) => {
      releaseExact = resolve;
    });
    let legacyLookupStarted: () => void = () => undefined;
    const legacyLookup = new Promise<void>((resolve) => {
      legacyLookupStarted = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') {
          return Promise.resolve(json({ token: 'platform-token' }));
        }
        if (url.hostname !== 'person-vault.example' || url.pathname !== '/graphql') {
          throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { id?: string };
        };
        if (
          body.query?.includes('MeshengerVideoEnvelope') &&
          body.variables?.id === 'viewer-chat-grant'
        ) {
          return exactResponse;
        }
        if (body.query?.includes('ExactChatAuthorization')) {
          legacyLookupStarted();
          return Promise.resolve(new Response('temporary source failure', { status: 503 }));
        }
        throw new Error(`Unexpected GraphQL query: ${body.query}`);
      }),
    );

    try {
      const pending = internals.findInteractiveViewerChatGrantAuthorizationEnvelopes(
        '@person.w3id',
        'https://person-vault.example',
        {
          eName: '@friend.w3id',
          chatId: 'chat-1',
          viewerChatGrantId: 'viewer-chat-grant',
        },
        '@person.w3id',
        'interactive',
      );
      await legacyLookup;
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseExact(
        json({
          data: {
            metaEnvelope: {
              id: 'viewer-chat-grant',
              ontology: documentedAuthorizationOntologies.chat,
              parsed: {
                isReference: true,
                canonicalOwnerEName: '@friend.w3id',
                canonicalChatId: 'chat-1',
              },
              envelopes: [],
            },
          },
        }),
      );

      await expect(pending).resolves.toEqual([
        expect.objectContaining({ id: 'viewer-chat-grant' }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a positive source-envelope hedge before a slow legacy Chat page', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let legacyStarted = false;
    let legacyAborted = false;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { id?: string };
        };
        if (body.query?.includes('ExactChatAuthorization')) {
          return Promise.resolve(
            json({
              data: {
                metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            }),
          );
        }
        if (body.query?.includes('AuthorizedMedia')) {
          legacyStarted = true;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                legacyAborted = true;
                reject(new Error('legacy Chat read aborted'));
              },
              { once: true },
            );
          });
        }
        if (body.query?.includes('MeshengerVideoEnvelope') && body.variables?.id === 'chat-1') {
          return Promise.resolve(
            json({
              data: {
                metaEnvelope: {
                  id: 'chat-1',
                  ontology: documentedAuthorizationOntologies.chat,
                  parsed: { id: 'chat-1', participantIds: ['@person.w3id'] },
                  envelopes: [],
                },
              },
            }),
          );
        }
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        internals.probeDirectSourceChatAccess(
          { eName: '@person.w3id' },
          { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
          'interactive',
        ),
      ).resolves.toEqual({ access: 'ok', member: true });
      expect(legacyStarted).toBe(true);
      await vi.waitFor(() => expect(legacyAborted).toBe(true));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the indexed and legacy Chat lookup authoritative after a non-member hedge', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let releaseLegacy: (response: Response) => void = () => undefined;
    const legacyResponse = new Promise<Response>((resolve) => {
      releaseLegacy = resolve;
    });
    let legacySignal: AbortSignal | undefined;
    let hedgeReadStarted: () => void = () => undefined;
    const hedgeRead = new Promise<void>((resolve) => {
      hedgeReadStarted = resolve;
    });
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { id?: string };
        };
        if (body.query?.includes('ExactChatAuthorization')) {
          return Promise.resolve(
            json({
              data: {
                metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            }),
          );
        }
        if (body.query?.includes('AuthorizedMedia')) {
          legacySignal = init?.signal ?? undefined;
          return legacyResponse;
        }
        if (body.query?.includes('MeshengerVideoEnvelope') && body.variables?.id === 'chat-1') {
          hedgeReadStarted();
          return Promise.resolve(
            json({
              data: {
                metaEnvelope: {
                  id: 'chat-1',
                  ontology: documentedAuthorizationOntologies.chat,
                  parsed: { id: 'chat-1', participantIds: ['@someone-else.w3id'] },
                  envelopes: [],
                },
              },
            }),
          );
        }
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const pending = internals.probeDirectSourceChatAccess(
        { eName: '@person.w3id' },
        { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
        'interactive',
      );
      await hedgeRead;
      expect(legacySignal?.aborted).toBe(false);
      releaseLegacy(
        json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'chat-1',
                    ontology: documentedAuthorizationOntologies.chat,
                    parsed: { id: 'chat-1', participantIds: ['@person.w3id'] },
                    envelopes: [],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );

      await expect(pending).resolves.toEqual({ access: 'ok', member: true });
      expect(legacySignal?.aborted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancels the delayed source-envelope hedge with its direct Chat branch', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    const controller = new AbortController();
    let exactSignal: AbortSignal | undefined;
    let sourceEnvelopeReads = 0;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
        if (body.query?.includes('ExactChatAuthorization')) {
          exactSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Chat read aborted')), {
              once: true,
            });
          });
        }
        if (body.query?.includes('MeshengerVideoEnvelope')) {
          sourceEnvelopeReads += 1;
          return Promise.resolve(json({ data: { metaEnvelope: null } }));
        }
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const pending = internals.probeDirectSourceChatAccess(
        { eName: '@person.w3id' },
        { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
        'interactive',
        controller.signal,
        controller.signal,
      );
      await vi.waitFor(() => expect(exactSignal).toBeDefined());
      controller.abort();

      await expect(pending).resolves.toEqual({ access: 'retry', member: false });
      expect(exactSignal?.aborted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sourceEnvelopeReads).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops the losing viewer Chat probe after the source proves a direct share', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let viewerChatSignal: AbortSignal | undefined;
    const source = vi
      .spyOn(internals, 'probeDirectSourceChatAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    const viewer = vi
      .spyOn(internals, 'probeViewerChatGrantAccess')
      .mockImplementation(async (_user, _space, _rateLimit, _parentSignal, chatSignal) => {
        viewerChatSignal = chatSignal;
        return new Promise<SharedAccessResult>((resolve) => {
          chatSignal?.addEventListener('abort', () => resolve({ access: 'retry', member: false }), {
            once: true,
          });
        });
      });

    await expect(
      library.probeSharedSpaceAccess(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
        'backoff',
      ),
    ).resolves.toEqual({ access: 'ok', member: true });

    expect(source).toHaveBeenCalledWith(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
      'backoff',
      undefined,
      expect.any(AbortSignal),
    );
    expect(viewer).toHaveBeenCalledWith(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { eName: '@friend.w3id', chatId: 'chat-1' },
      'backoff',
      undefined,
      expect.any(AbortSignal),
    );
    expect(viewerChatSignal?.aborted).toBe(true);
  });

  it('stops the losing source Chat probe after the viewer proves a direct share', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let sourceChatSignal: AbortSignal | undefined;
    vi.spyOn(internals, 'probeDirectSourceChatAccess').mockImplementation(
      async (_user, _space, _rateLimit, _parentSignal, chatSignal) => {
        sourceChatSignal = chatSignal;
        return new Promise<SharedAccessResult>((resolve) => {
          chatSignal?.addEventListener('abort', () => resolve({ access: 'retry', member: false }), {
            once: true,
          });
        });
      },
    );
    vi.spyOn(internals, 'probeViewerChatGrantAccess').mockResolvedValue({
      access: 'ok',
      member: true,
    });

    await expect(
      library.probeSharedSpaceAccess(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
        'backoff',
      ),
    ).resolves.toEqual({ access: 'ok', member: true });

    expect(sourceChatSignal?.aborted).toBe(true);
  });

  it('keeps the alternate direct Chat probe running after a non-proof result', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    let viewerChatSignal: AbortSignal | undefined;
    let resolveViewer: (access: SharedAccessResult) => void = () => undefined;
    vi.spyOn(internals, 'probeDirectSourceChatAccess').mockResolvedValue({
      access: 'ok',
      member: false,
    });
    vi.spyOn(internals, 'probeViewerChatGrantAccess').mockImplementation(
      async (_user, _space, _rateLimit, _parentSignal, chatSignal) => {
        viewerChatSignal = chatSignal;
        return new Promise<SharedAccessResult>((resolve) => {
          resolveViewer = resolve;
        });
      },
    );

    const pending = library.probeSharedSpaceAccess(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
      'backoff',
    );
    await vi.waitFor(() => expect(viewerChatSignal).toBeDefined());
    expect(viewerChatSignal?.aborted).toBe(false);
    resolveViewer({ access: 'ok', member: true });

    await expect(pending).resolves.toEqual({ access: 'ok', member: true });
    expect(viewerChatSignal?.aborted).toBe(false);
  });

  it('propagates parent cancellation to both direct Chat probes', async () => {
    const library = configuredLibrary();
    const internals = directProbeInternals(library);
    const controller = new AbortController();
    let sourceChatSignal: AbortSignal | undefined;
    let viewerChatSignal: AbortSignal | undefined;
    vi.spyOn(internals, 'probeDirectSourceChatAccess').mockImplementation(
      async (_user, _space, _rateLimit, _parentSignal, chatSignal) => {
        sourceChatSignal = chatSignal;
        return new Promise<SharedAccessResult>((resolve) => {
          chatSignal?.addEventListener('abort', () => resolve({ access: 'retry', member: false }), {
            once: true,
          });
        });
      },
    );
    vi.spyOn(internals, 'probeViewerChatGrantAccess').mockImplementation(
      async (_user, _space, _rateLimit, _parentSignal, chatSignal) => {
        viewerChatSignal = chatSignal;
        return new Promise<SharedAccessResult>((resolve) => {
          chatSignal?.addEventListener('abort', () => resolve({ access: 'retry', member: false }), {
            once: true,
          });
        });
      },
    );

    const pending = library.probeSharedSpaceAccess(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
      'backoff',
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(sourceChatSignal).toBeDefined());
    await vi.waitFor(() => expect(viewerChatSignal).toBeDefined());
    controller.abort();

    await expect(pending).resolves.toEqual({ access: 'retry', member: false });
    expect(sourceChatSignal?.aborted).toBe(true);
    expect(viewerChatSignal?.aborted).toBe(true);
  });

  it('does not cancel a shared source vault resolution when the other direct Chat probe wins', async () => {
    const library = configuredLibrary();
    let releaseFriendResolve: () => void = () => undefined;
    let friendResolveSignal: AbortSignal | undefined;
    const delayedFriendResolve = new Promise<Response>((resolve) => {
      releaseFriendResolve = () =>
        resolve(json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, init?: RequestInit) => {
        if (url.pathname === '/resolve' && url.searchParams.get('w3id') === '@friend.w3id') {
          friendResolveSignal = init?.signal ?? undefined;
          return delayedFriendResolve;
        }
        if (url.pathname === '/platforms/certification') {
          return Promise.resolve(json({ token: 'platform-token' }));
        }
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            variables?: { chatId?: string };
          };
          if (body.variables?.chatId === 'chat-1') {
            return Promise.resolve(
              json({
                data: {
                  metaEnvelopes: {
                    edges: [
                      {
                        node: {
                          id: 'viewer-chat-reference',
                          ontology: documentedAuthorizationOntologies.chat,
                          parsed: {
                            isReference: true,
                            canonicalOwnerEName: '@friend.w3id',
                            canonicalChatId: 'chat-1',
                            type: 'direct',
                          },
                          envelopes: [],
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              }),
            );
          }
          if (body.variables?.chatId === 'chat-2') {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new Error('viewer chat request aborted')),
                { once: true },
              );
            });
          }
        }
        if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            variables?: { chatId?: string };
          };
          if (body.variables?.chatId === 'chat-2') {
            return Promise.resolve(
              json({
                data: {
                  metaEnvelopes: {
                    edges: [
                      {
                        node: {
                          id: 'chat-2',
                          ontology: documentedAuthorizationOntologies.chat,
                          parsed: { id: 'chat-2', participantIds: ['@person.w3id'] },
                          envelopes: [],
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              }),
            );
          }
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    try {
      const first = library.probeSharedSpaceAccess(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
        'backoff',
      );
      await vi.waitFor(() => expect(friendResolveSignal).toBeDefined());
      await expect(first).resolves.toEqual({ access: 'ok', member: true });
      expect(friendResolveSignal?.aborted).toBe(false);

      const second = library.probeSharedSpaceAccess(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-2' },
        'backoff',
      );
      releaseFriendResolve();

      await expect(second).resolves.toEqual({ access: 'ok', member: true });
    } finally {
      releaseFriendResolve();
      vi.unstubAllGlobals();
    }
  });

  it('aborts a background shared-access probe at its in-flight eVault read', async () => {
    const controller = new AbortController();
    let graphQlAborted = false;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(
          json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
        );
      }
      if (url.pathname === '/platforms/certification') {
        return Promise.resolve(json({ token: 'platform-token' }));
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/graphql') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              graphQlAborted = true;
              reject(new Error('request aborted'));
            },
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const pending = configuredLibrary().probeSharedSpaceAccess(
        { eName: '@person.w3id' },
        { eName: '@friend.w3id', kind: 'direct', chatId: 'chat-1' },
        'fail-fast',
        { signal: controller.signal },
      );

      await vi.waitFor(() =>
        expect(
          fetcher.mock.calls.some(
            ([url]) =>
              (url as URL).hostname === 'friend-vault.example' &&
              (url as URL).pathname === '/graphql',
          ),
        ).toBe(true),
      );
      controller.abort();

      await expect(pending).resolves.toEqual({ access: 'retry', member: false });
      expect(graphQlAborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the dedicated eight-second budget for preview resolution and File redirects', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
      }
      if (url.hostname === 'person-vault.example' && url.pathname === '/files/preview-budget') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/preview-budget.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();

    try {
      await expect(
        configuredLibrary().resolveMediaUrl(
          { eName: '@person.w3id' },
          createMeshengerVideoStreamId(
            { ...grant, fileUri: 'w3ds://file?id=@person.w3id/preview-budget' },
            secret,
          ),
          { priority: 'preview', signal: controller.signal },
        ),
      ).resolves.toBe('https://media.example/preview-budget.mp4');

      expect(timeout.mock.calls.filter(([milliseconds]) => milliseconds === 8_000)).toHaveLength(2);
      expect(timeout).not.toHaveBeenCalledWith(2_500);
      expect(timeout).not.toHaveBeenCalledWith(2_000);
    } finally {
      timeout.mockRestore();
      controller.abort();
      vi.unstubAllGlobals();
    }
  });

  it('does not let preview proof work inherit a pending 2.5-second background proof', async () => {
    const library = configuredLibrary();
    let releaseBackground: (result: SharedAccessResult) => void = () => undefined;
    let markBackgroundStarted: () => void = () => undefined;
    const backgroundStarted = new Promise<void>((resolve) => {
      markBackgroundStarted = resolve;
    });
    const pendingBackground = new Promise<SharedAccessResult>((resolve) => {
      releaseBackground = resolve;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation(async (_user, _source, rateLimit) => {
        if (rateLimit === 'background-cancellable') {
          markBackgroundStarted();
          return pendingBackground;
        }
        if (rateLimit === 'preview-cancellable') return { access: 'ok', member: true };
        throw new Error(`Unexpected source policy: ${String(rateLimit)}`);
      });
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/separate-preview-proof',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );
    const backgroundController = new AbortController();

    try {
      const background = library.inspectPlayableStream({ eName: grant.eName }, streamId, {
        priority: 'background',
        signal: backgroundController.signal,
      });
      await backgroundStarted;

      await expect(
        library.inspectPlayableStream({ eName: grant.eName }, streamId, {
          priority: 'preview',
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ fileUri: 'w3ds://file?id=@friend.w3id/separate-preview-proof' });
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        { eName: '@friend.w3id', kind: 'group' },
        'background-cancellable',
        expect.anything(),
      );
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        { eName: '@friend.w3id', kind: 'group' },
        'preview-cancellable',
        expect.anything(),
      );

      releaseBackground({ access: 'retry', member: false });
      await expect(background).rejects.toThrow(
        expect.objectContaining({ code: 'remote_unavailable', status: 503 }),
      );
    } finally {
      releaseBackground({ access: 'retry', member: false });
      backgroundController.abort();
    }
  });

  it('does not let a cancellable shared preview block an interactive Watch request', async () => {
    const library = configuredLibrary();
    const controller = new AbortController();
    let markBackgroundStarted: () => void = () => undefined;
    const backgroundStarted = new Promise<void>((resolve) => {
      markBackgroundStarted = resolve;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation(async (_user, _space, rateLimit, options) => {
        if (rateLimit === 'preview-cancellable') {
          markBackgroundStarted();
          return new Promise<{ access: 'retry'; member: false }>((resolve) => {
            options?.signal?.addEventListener(
              'abort',
              () => resolve({ access: 'retry', member: false }),
              { once: true },
            );
          });
        }
        return { access: 'ok', member: true };
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/shared-preview-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/shared-preview.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/shared-preview-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );

    try {
      const preview = library.resolveMediaUrl({ eName: grant.eName }, streamId, {
        priority: 'preview',
        signal: controller.signal,
      });
      await backgroundStarted;

      await expect(
        library.resolveMediaUrl({ eName: grant.eName }, streamId, { priority: 'interactive' }),
      ).resolves.toBe('https://media.example/shared-preview.mp4');
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        { eName: '@friend.w3id', kind: 'group' },
        'preview-cancellable',
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        { eName: '@friend.w3id', kind: 'group' },
        'interactive',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      controller.abort();
      await expect(preview).rejects.toThrow('Background media resolution was cancelled.');
    } finally {
      controller.abort();
      vi.unstubAllGlobals();
    }
  });

  it('does not let a cancellable shared hover warmup block an interactive Watch request', async () => {
    const library = configuredLibrary();
    const controller = new AbortController();
    let markWarmupStarted: () => void = () => undefined;
    const warmupStarted = new Promise<void>((resolve) => {
      markWarmupStarted = resolve;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockImplementation(async (_user, _space, rateLimit, options) => {
        if (rateLimit === 'warmup-cancellable') {
          markWarmupStarted();
          return new Promise<{ access: 'retry'; member: false }>((resolve) => {
            options?.signal?.addEventListener(
              'abort',
              () => resolve({ access: 'retry', member: false }),
              { once: true },
            );
          });
        }
        return { access: 'ok', member: true };
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/shared-hover-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/shared-hover.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/shared-hover-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );

    try {
      const warmup = library.resolveMediaUrl({ eName: grant.eName }, streamId, {
        priority: 'warmup',
        signal: controller.signal,
      });
      await warmupStarted;

      await expect(
        library.resolveMediaUrl({ eName: grant.eName }, streamId, { priority: 'interactive' }),
      ).resolves.toBe('https://media.example/shared-hover.mp4');
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        { eName: '@friend.w3id', kind: 'group' },
        'warmup-cancellable',
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        { eName: '@friend.w3id', kind: 'group' },
        'interactive',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      controller.abort();
      await expect(warmup).rejects.toThrow('Background media resolution was cancelled.');
    } finally {
      controller.abort();
      vi.unstubAllGlobals();
    }
  });

  it('cancels a shared hover directory lookup without poisoning the next Watch', async () => {
    const library = configuredLibrary();
    const controller = new AbortController();
    let markRegistryStarted: () => void = () => undefined;
    const registryStarted = new Promise<void>((resolve) => {
      markRegistryStarted = resolve;
    });
    let registryAborted = false;
    let registryRequests = 0;
    vi.spyOn(library, 'probeSharedSpaceAccess').mockImplementation(
      async (_user, _space, rateLimit, options) => {
        if (rateLimit !== 'warmup-cancellable') return { access: 'ok', member: true };
        return new Promise<SharedAccessResult>((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => resolve({ access: 'retry', member: false }),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, init?: RequestInit) => {
        if (url.pathname === '/resolve') {
          registryRequests += 1;
          if (registryRequests > 1) {
            return Promise.resolve(
              json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
            );
          }
          markRegistryStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                registryAborted = true;
                reject(new Error('hover directory lookup aborted'));
              },
              { once: true },
            );
          });
        }
        if (url.pathname === '/files/cancelled-hover') {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/cancelled-hover.mp4' },
            }),
          );
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/cancelled-hover',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );

    try {
      const hover = library.resolveMediaUrl({ eName: grant.eName }, streamId, {
        priority: 'warmup',
        signal: controller.signal,
      });
      await registryStarted;
      controller.abort();
      await expect(hover).rejects.toThrow('Background media resolution was cancelled.');
      expect(registryAborted).toBe(true);

      await expect(
        library.resolveMediaUrl({ eName: grant.eName }, streamId, { priority: 'interactive' }),
      ).resolves.toBe('https://media.example/cancelled-hover.mp4');
      expect(registryRequests).toBe(2);
    } finally {
      controller.abort();
      vi.unstubAllGlobals();
    }
  });

  it('opens a shared File reference after checking its viewer-owned reference proof', async () => {
    const library = configuredLibrary();
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
        }
        if (url.pathname === '/files/shared-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/shared-video.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/shared-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceReferenceId: 'local-reference',
        sourceReferenceFileId: 'shared-file',
        accessBasis: 'reference',
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).resolves.toBe(
        'https://media.example/shared-video.mp4',
      );
      expect(probe).toHaveBeenCalledWith(
        { eName: grant.eName },
        {
          eName: '@friend.w3id',
          kind: 'reference',
          referenceId: 'local-reference',
          fileId: 'shared-file',
        },
        'interactive',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('verifies that a shared File reference still targets the exact canonical file', async () => {
    let canonicalFileId = 'shared-file';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
        }
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.hostname === 'person-vault.example' && url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
          if (body.query?.includes('metaEnvelope(id:')) {
            return json({
              data: {
                metaEnvelope: {
                  id: 'local-reference',
                  ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                  parsed: {
                    isReference: true,
                    canonicalOwnerEName: '@friend.w3id',
                    canonicalFileId,
                  },
                  envelopes: [],
                },
              },
            });
          }
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );
    const library = configuredLibrary();
    const probe = {
      eName: '@friend.w3id',
      kind: 'reference' as const,
      referenceId: 'local-reference',
      fileId: 'shared-file',
    };

    try {
      await expect(
        library.probeSharedSpaceAccess({ eName: '@person.w3id' }, probe),
      ).resolves.toEqual({ access: 'ok', member: true });
      canonicalFileId = 'a-different-file';
      await expect(
        library.probeSharedSpaceAccess({ eName: '@person.w3id' }, probe),
      ).resolves.toEqual({ access: 'denied', member: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a shared stream when its current source access is gone even if File would redirect', async () => {
    const library = configuredLibrary();
    const probe = vi.spyOn(library, 'probeSharedSpaceAccess').mockResolvedValue({
      access: 'denied',
      member: false,
    });
    const fetcher = vi.fn(async (url: URL, _init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
      }
      if (url.pathname === '/files/shared-file') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/shared-file.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/shared-file',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );

    try {
      await expect(library.resolveMediaUrl({ eName: grant.eName }, streamId)).rejects.toThrow(
        expect.objectContaining({ code: 'authorization_denied', status: 403 }),
      );
      expect(probe).toHaveBeenCalledTimes(1);
      // The owner directory may be resolved speculatively, but a denied
      // share must never reach the File/media endpoint.
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname.startsWith('/files/')),
      ).toHaveLength(0);
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/resolve'),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps an interactive source read retryable when the source briefly rate limits', async () => {
    let resolveAttempts = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        resolveAttempts += 1;
        if (resolveAttempts === 1) return rateLimited('0');
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/files/interactive-rate-limit') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/interactive-rate-limit.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().resolveMediaUrl(
          { eName: '@person.w3id' },
          createMeshengerVideoStreamId(
            { ...grant, fileUri: 'w3ds://file?id=@person.w3id/interactive-rate-limit' },
            secret,
          ),
          { priority: 'interactive' },
        ),
      ).resolves.toBe('https://media.example/interactive-rate-limit.mp4');
      expect(resolveAttempts).toBe(2);
      expect(
        fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/resolve'),
      ).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the longer retry budget for background source repair', async () => {
    let resolveAttempts = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        resolveAttempts += 1;
        if (resolveAttempts < 4) return rateLimited('0');
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/files/background-repair') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/background-repair.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(
        configuredLibrary().resolveMediaUrl(
          { eName: '@person.w3id' },
          createMeshengerVideoStreamId(
            { ...grant, fileUri: 'w3ds://file?id=@person.w3id/background-repair' },
            secret,
          ),
          { priority: 'background' },
        ),
      ).resolves.toBe('https://media.example/background-repair.mp4');
      expect(resolveAttempts).toBe(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not make an interactive Watch request inherit a background source resolution', async () => {
    let resolveAttempts = 0;
    let releaseBackgroundResolve!: () => void;
    let markBackgroundStarted!: () => void;
    const backgroundStarted = new Promise<void>((resolve) => {
      markBackgroundStarted = resolve;
    });
    const delayedBackgroundResolve = new Promise<Response>((resolve) => {
      releaseBackgroundResolve = () =>
        resolve(json({ ename: '@person.w3id', uri: 'https://vault.example' }));
    });
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        resolveAttempts += 1;
        if (resolveAttempts === 1) {
          markBackgroundStarted();
          return delayedBackgroundResolve;
        }
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/files/priority-file') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/priority-file.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      { ...grant, fileUri: 'w3ds://file?id=@person.w3id/priority-file' },
      secret,
    );

    try {
      const background = configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        priority: 'background',
      });
      await backgroundStarted;
      await expect(
        configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toBe('https://media.example/priority-file.mp4');
      expect(resolveAttempts).toBe(2);

      releaseBackgroundResolve();
      await expect(background).resolves.toBe('https://media.example/priority-file.mp4');
    } finally {
      releaseBackgroundResolve();
      vi.unstubAllGlobals();
    }
  });

  it('cancels a preview File resolution without poisoning the next interactive redirect', async () => {
    const controller = new AbortController();
    let markDirectRequestStarted: () => void = () => undefined;
    const directRequestStarted = new Promise<void>((resolve) => {
      markDirectRequestStarted = resolve;
    });
    let directRequests = 0;
    const fetcher = vi.fn((url: URL, init?: RequestInit) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(json({ ename: '@person.w3id', uri: 'https://vault.example' }));
      }
      if (url.pathname === '/files/cancellable-preview') {
        directRequests += 1;
        if (directRequests > 1) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/cancellable-preview.mp4' },
            }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          markDirectRequestStarted();
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      { ...grant, fileUri: 'w3ds://file?id=@person.w3id/cancellable-preview' },
      secret,
    );

    try {
      const preview = configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        priority: 'preview',
        signal: controller.signal,
      });
      await directRequestStarted;
      controller.abort();
      await expect(preview).rejects.toThrow('Background media resolution was cancelled.');

      await expect(
        configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toBe('https://media.example/cancellable-preview.mp4');
      expect(directRequests).toBe(2);
      expect(fetcher.mock.calls.some(([url]) => (url as URL).pathname === '/graphql')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops a cancelled preview during Retry-After instead of issuing another source retry', async () => {
    const controller = new AbortController();
    let resolveAttempts = 0;
    const fetcher = vi.fn((url: URL) => {
      if (url.pathname === '/resolve') {
        resolveAttempts += 1;
        return Promise.resolve(rateLimited('120'));
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const streamId = createMeshengerVideoStreamId(
      { ...grant, fileUri: 'w3ds://file?id=@person.w3id/cancel-retry' },
      secret,
    );

    try {
      const preview = configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        priority: 'preview',
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(resolveAttempts).toBe(1));
      controller.abort();
      await expect(preview).rejects.toThrow('Background media resolution was cancelled.');
      expect(resolveAttempts).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports fixed resolution phase timings without exposing a source', async () => {
    const timing: Array<{
      mediaUrlCacheHit: boolean;
      sharedAccessVerificationMs: number;
      eVaultResolutionMs: number;
      directFileDereferenceMs: number;
      platformTokenMs: number;
      metadataReadMs: number;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/resolve') {
          return json({ ename: '@person.w3id', uri: 'https://vault.example' });
        }
        if (url.pathname === '/files/timed-file') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/timed-file.mp4' },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const streamId = createMeshengerVideoStreamId(
      { ...grant, fileUri: 'w3ds://file?id=@person.w3id/timed-file' },
      secret,
    );

    try {
      await configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        onTiming: (entry) => timing.push(entry),
      });
      await configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
        onTiming: (entry) => timing.push(entry),
      });

      expect(timing).toHaveLength(2);
      expect(timing[0]).toMatchObject({
        mediaUrlCacheHit: false,
        sharedAccessVerificationMs: 0,
        eVaultResolutionMs: expect.any(Number),
        directFileDereferenceMs: expect.any(Number),
        platformTokenMs: 0,
        metadataReadMs: 0,
      });
      expect(timing[1]).toMatchObject({
        mediaUrlCacheHit: true,
        sharedAccessVerificationMs: 0,
        eVaultResolutionMs: 0,
        directFileDereferenceMs: 0,
        platformTokenMs: 0,
        metadataReadMs: 0,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries a rate-limited personal File read before failing playback', async () => {
    let fileReadAttempts = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.pathname === '/graphql') {
        fileReadAttempts += 1;
        if (fileReadAttempts === 1) return rateLimited('0');
        return json({
          data: {
            metaEnvelope: {
              id: 'retry-unavailable-file',
              ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              parsed: { publicUrl: 'https://media.example/personal-video.mp4' },
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(
        configuredLibrary().resolveMediaUrl(
          { eName: '@person.w3id' },
          createMeshengerVideoStreamId(
            { ...grant, fileUri: 'w3ds://file?id=@person.w3id/retry-unavailable-file' },
            secret,
          ),
        ),
      ).resolves.toBe('https://media.example/personal-video.mp4');
      expect(fileReadAttempts).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries a transient personal File source failure before failing playback', async () => {
    let fileReadAttempts = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.pathname === '/graphql') {
        fileReadAttempts += 1;
        if (fileReadAttempts === 1) return new Response('temporary failure', { status: 503 });
        return json({
          data: {
            metaEnvelope: {
              id: 'retry-file',
              ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              parsed: { publicUrl: 'https://media.example/personal-video.mp4' },
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(
        configuredLibrary().resolveMediaUrl(
          { eName: '@person.w3id' },
          createMeshengerVideoStreamId(
            { ...grant, fileUri: 'w3ds://file?id=@person.w3id/retry-file' },
            secret,
          ),
        ),
      ).resolves.toBe('https://media.example/personal-video.mp4');
      expect(fileReadAttempts).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the canonical File redirect before querying video metadata', async () => {
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/files/direct-file') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/direct-file.mp4' },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(
        configuredLibrary().resolveMediaUrl(
          { eName: '@person.w3id' },
          createMeshengerVideoStreamId(
            { ...grant, fileUri: 'w3ds://file?id=@person.w3id/direct-file' },
            secret,
          ),
        ),
      ).resolves.toBe('https://media.example/direct-file.mp4');
      expect(fetcher.mock.calls.some(([url]) => (url as URL).pathname === '/graphql')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('temporarily yields background inventory to an interactive personal playback read', async () => {
    let now = 1_000;
    const jobStore = createMemoryInventoryJobStore();
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.pathname === '/graphql') {
        return json({
          data: {
            metaEnvelope: {
              id: 'reserved-file',
              ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              parsed: { publicUrl: 'https://media.example/reserved-video.mp4' },
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const library = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore, now: () => now },
      );
      await library.resolveMediaUrl(
        { eName: '@person.w3id' },
        createMeshengerVideoStreamId(
          { ...grant, fileUri: 'w3ds://file?id=@person.w3id/reserved-file' },
          secret,
        ),
      );
      expect(await jobStore.vaultNotBefore('@person.w3id', now)).toBe(now + 90_000);
      now += 90_000;
      expect(await jobStore.vaultNotBefore('@person.w3id', now)).toBe(now);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pauses the next same-vault inventory wave before its durable playback gate is written', async () => {
    let now = 1_000;
    const durableStore = createMemoryInventoryJobStore();
    let releaseDurableGate: () => void = () => {};
    const delayedSetVaultGate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDurableGate = resolve;
        }),
    );
    const jobStore = { ...durableStore, setVaultGate: delayedSetVaultGate };
    let inventoryReads = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        return json({ ename: '@person.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname === '/files/local-gate-file') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/local-gate.mp4' },
        });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      if (url.pathname === '/graphql') {
        inventoryReads += 1;
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const library = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore, now: () => now },
      );
      await library.resolveMediaUrl(
        { eName: '@person.w3id' },
        createMeshengerVideoStreamId(
          { ...grant, fileUri: 'w3ds://file?id=@person.w3id/local-gate-file' },
          secret,
        ),
      );

      await library.scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'shared', maxWaves: 1, onSnapshot: () => undefined },
      );

      expect(delayedSetVaultGate).toHaveBeenCalledWith('@person.w3id', now + 90_000);
      expect(inventoryReads).toBe(0);

      now += 90_000;
      await library.scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'shared', maxWaves: 1, onSnapshot: () => undefined },
      );
      expect(inventoryReads).toBeGreaterThan(0);
    } finally {
      releaseDurableGate();
      vi.unstubAllGlobals();
    }
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
            title: t(t('Circle update.mp4')),
            shape: 'circle',
            durationSeconds: 12,
          }),
          expect.objectContaining({
            kind: 'file',
            title: t(t('A shared clip.mp4')),
            accessScope: 'personal',
            visibility: 'private',
          }),
          expect.objectContaining({
            kind: 'file',
            title: t(t('Video from another app.webm')),
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

  it('discovers group-vault calls through chat references and prefers their complete recording', async () => {
    const completeRecording = 'w3ds://file?id=@group.w3id/call-complete';
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
                        mediaUri: completeRecording,
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
      expect(call?.accessScope).toBe('shared');
      expect(call?.streamIds).toHaveLength(1);
      expect(videos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'video-message',
            shape: 'circle',
            title: 'Team update',
          }),
          expect.objectContaining({
            kind: 'file',
            title: t(t('Planning demo.mp4')),
            accessScope: 'shared',
            visibility: 'shared-with-me',
          }),
          expect.objectContaining({
            kind: 'file',
            title: t(t('Shared raw eVault clip.mp4')),
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
          return (
            body.query.includes('AuthorizedChatMessages') && body.variables.chatId === 'chat-1'
          );
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
      { ...grant, fileUri: 'w3ds://file?id=@person.w3id/file_123' },
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
      fileUri: 'w3ds://file?id=@cache-test.w3id/cache-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve')
        return json({ ename: '@vault.w3id', uri: 'https://vault.example' });
      if (url.pathname.startsWith('/files/')) return new Response(null, { status: 404 });
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
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires a fresh shared proof before a forced recovery can invalidate media caches', async () => {
    const library = configuredLibrary();
    const streamId = historySharedStream('revoked-forced-recovery');
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    stubInteractivePlatformToken();

    try {
      // Seed the ordinary 60-second positive proof cache. A later forced
      // recovery must not trust this completed result after membership changes.
      await expect(
        library.inspectPlayableStream({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).resolves.toEqual({ fileUri: 'w3ds://file?id=@friend.w3id/revoked-forced-recovery' });

      probe.mockReset();
      probe.mockResolvedValue({ access: 'denied', member: false });
      const beginForcedSourceRefresh = vi.spyOn(
        library as unknown as { beginForcedSourceRefresh: () => unknown },
        'beginForcedSourceRefresh',
      );

      await expect(
        library.resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          forceSourceRefresh: true,
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied', status: 403 }));

      expect(probe).toHaveBeenCalled();
      expect(beginForcedSourceRefresh).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not join a pre-revocation shared proof when a source recovery starts', async () => {
    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/pre-revocation-proof',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );
    let completeOlderProof: ((access: SharedAccessResult) => void) | undefined;
    const olderProof = new Promise<SharedAccessResult>((resolve) => {
      completeOlderProof = resolve;
    });
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockReturnValueOnce(olderProof)
      .mockResolvedValue({ access: 'denied', member: false });
    stubInteractivePlatformToken();

    try {
      const ordinary = library.inspectPlayableStream({ eName: '@person.w3id' }, streamId, {
        priority: 'interactive',
      });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

      await expect(
        library.proveCurrentPlayableStreamForSourceRefresh({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied', status: 403 }));

      // The forced proof must have its own post-invalidation source read;
      // reusing the earlier pending positive result would permit a revoked
      // viewer to clear a healthy source cache.
      expect(probe).toHaveBeenCalledTimes(2);
      completeOlderProof?.({ access: 'ok', member: true });
      await expect(ordinary).resolves.toEqual({
        fileUri: 'w3ds://file?id=@friend.w3id/pre-revocation-proof',
      });

      await expect(
        library.inspectPlayableStream({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
        }),
      ).rejects.toThrow(expect.objectContaining({ code: 'authorization_denied', status: 403 }));
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not mint a recovery capability when its current proof is invalidated in flight', async () => {
    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(
      {
        ...grant,
        fileUri: 'w3ds://file?id=@friend.w3id/in-flight-capability-proof',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        accessBasis: 'membership',
      },
      secret,
    );
    let finishProof: ((access: SharedAccessResult) => void) | undefined;
    const pendingProof = new Promise<SharedAccessResult>((resolve) => {
      finishProof = resolve;
    });
    const probe = vi.spyOn(library, 'probeSharedSpaceAccess').mockReturnValue(pendingProof);
    stubInteractivePlatformToken();

    try {
      const capability = library.proveCurrentPlayableStreamForSourceRefresh(
        { eName: '@person.w3id' },
        streamId,
        { priority: 'interactive' },
      );
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

      // Model another recovery/revocation invalidating this exact source while
      // the first remote ACL probe is still pending.
      await library.invalidateMediaUrl({ eName: '@person.w3id' }, streamId);
      finishProof?.({ access: 'ok', member: true });

      await expect(capability).rejects.toThrow(
        expect.objectContaining({ code: 'remote_unavailable', status: 503 }),
      );
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('issues a durable-read receipt only after an exact current proof', async () => {
    const library = configuredLibrary();
    const streamId = historySharedStream('server-only-ready-handoff');
    const otherStreamId = historySharedStream('different-ready-handoff');
    vi.spyOn(library, 'probeSharedSpaceAccess').mockResolvedValue({ access: 'ok', member: true });
    stubInteractivePlatformToken();

    try {
      const proof = await library.proveCurrentPlayableStreamForSourceRefresh(
        { eName: '@person.w3id' },
        streamId,
        { priority: 'interactive' },
      );

      expect(
        library.playbackSourceRefreshReadReceiptAfterCurrentProof(
          { eName: '@person.w3id' },
          streamId,
          proof,
        ),
      ).toEqual(expect.any(String));
      expect(
        library.playbackSourceRefreshReadReceiptAfterCurrentProof(
          { eName: '@person.w3id' },
          otherStreamId,
          proof,
        ),
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses a fresh current proof when a supplied recovery capability was invalidated', async () => {
    const refreshGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@friend.w3id/fallback-proof-file',
      accessScope: 'shared' as const,
      sourceSpaceKey: '@friend.w3id',
      accessBasis: 'membership' as const,
    };
    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(refreshGrant, secret);
    const probe = vi
      .spyOn(library, 'probeSharedSpaceAccess')
      .mockResolvedValue({ access: 'ok', member: true });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        if (url.pathname === '/resolve') {
          return Promise.resolve(
            json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' }),
          );
        }
        if (url.hostname === 'friend-vault.example' && url.pathname.startsWith('/files/')) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/fallback-proof.mp4' },
            }),
          );
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    try {
      const staleProof = await library.proveCurrentPlayableStreamForSourceRefresh(
        { eName: refreshGrant.eName },
        streamId,
        { priority: 'interactive' },
      );
      // Model a concurrent invalidation after the route obtained its
      // capability but before it entered the forced resolver. The resolver
      // must establish a new proof and validate that proof at completion,
      // rather than rechecking the stale supplied object and failing late.
      await library.invalidateMediaUrl({ eName: refreshGrant.eName }, streamId);

      await expect(
        library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId, {
          forceSourceRefresh: true,
          forcedSourceRefreshProof: staleProof,
        }),
      ).resolves.toBe('https://media.example/fallback-proof.mp4');
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not let a pre-refresh pending resolution overwrite the forced fresh source', async () => {
    const refreshGrant = {
      eName: '@generation-test.w3id',
      fileUri: 'w3ds://file?id=@generation-test.w3id/generation-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    let fileReads = 0;
    let releaseStaleSource: (() => void) | undefined;
    let notifyFirstFileRead: (() => void) | undefined;
    const firstFileRead = new Promise<void>((resolve) => {
      notifyFirstFileRead = resolve;
    });
    const fetcher = vi.fn((url: URL) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(json({ ename: '@vault.w3id', uri: 'https://vault.example' }));
      }
      if (url.pathname.startsWith('/files/')) {
        fileReads += 1;
        if (fileReads === 1) {
          notifyFirstFileRead?.();
          return new Promise<Response>((resolve) => {
            releaseStaleSource = () =>
              resolve(
                new Response(null, {
                  status: 302,
                  headers: { location: 'https://media.example/stale.mp4' },
                }),
              );
          });
        }
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/fresh.mp4' },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(refreshGrant, secret);
    const staleResolution = library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId);
    await firstFileRead;

    const freshResolution = await library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId, {
      forceSourceRefresh: true,
    });
    releaseStaleSource?.();

    await expect(staleResolution).rejects.toMatchObject({ code: 'remote_unavailable' });
    expect(freshResolution).toBe('https://media.example/fresh.mp4');
    await expect(library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId)).resolves.toBe(
      'https://media.example/fresh.mp4',
    );
    expect(fileReads).toBe(2);
  });

  it('adopts a ready cross-replica source without letting an older local resolver restore S', async () => {
    const refreshGrant = {
      eName: '@adopt-generation-test.w3id',
      fileUri: 'w3ds://file?id=@adopt-generation-test.w3id/adopt-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    let releaseStaleSource: (() => void) | undefined;
    let notifyFirstFileRead: (() => void) | undefined;
    const firstFileRead = new Promise<void>((resolve) => {
      notifyFirstFileRead = resolve;
    });
    let fileReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        if (url.pathname === '/resolve') {
          return Promise.resolve(json({ ename: '@vault.w3id', uri: 'https://vault.example' }));
        }
        if (url.pathname.startsWith('/files/')) {
          fileReads += 1;
          notifyFirstFileRead?.();
          return new Promise<Response>((resolve) => {
            releaseStaleSource = () =>
              resolve(
                new Response(null, {
                  status: 302,
                  headers: { location: 'https://media.example/stale-adopt.mp4' },
                }),
              );
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );

    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(refreshGrant, secret);
    const staleResolution = library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId);
    await firstFileRead;
    const proof = await library.proveCurrentPlayableStreamForSourceRefresh(
      { eName: refreshGrant.eName },
      streamId,
    );

    expect(
      library.adoptReadyPlaybackSourceAfterCurrentProof(
        { eName: refreshGrant.eName },
        streamId,
        proof,
        'https://media.example/ready-from-other-replica.mp4',
      ),
    ).toBe(true);
    releaseStaleSource?.();

    await expect(staleResolution).rejects.toMatchObject({ code: 'remote_unavailable' });
    await expect(library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId)).resolves.toBe(
      'https://media.example/ready-from-other-replica.mp4',
    );
    expect(fileReads).toBe(1);
  });

  it('does not join a pre-refresh pending eVault lookup during a forced source refresh', async () => {
    const refreshGrant = {
      eName: '@generation-vault-test.w3id',
      fileUri: 'w3ds://file?id=@generation-vault-test.w3id/generation-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    let registryReads = 0;
    let releaseStaleVault: (() => void) | undefined;
    let notifyFirstRegistryRead: (() => void) | undefined;
    const firstRegistryRead = new Promise<void>((resolve) => {
      notifyFirstRegistryRead = resolve;
    });
    const fetcher = vi.fn((url: URL) => {
      if (url.pathname === '/resolve') {
        registryReads += 1;
        if (registryReads === 1) {
          notifyFirstRegistryRead?.();
          return new Promise<Response>((resolve) => {
            releaseStaleVault = () =>
              resolve(json({ ename: '@vault.w3id', uri: 'https://old-vault.example' }));
          });
        }
        return Promise.resolve(json({ ename: '@vault.w3id', uri: 'https://fresh-vault.example' }));
      }
      if (url.hostname === 'old-vault.example' && url.pathname.startsWith('/files/')) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/stale-vault.mp4' },
          }),
        );
      }
      if (url.hostname === 'fresh-vault.example' && url.pathname.startsWith('/files/')) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/fresh-vault.mp4' },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(refreshGrant, secret);
    const staleResolution = library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId);
    await firstRegistryRead;

    await expect(
      library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId, {
        forceSourceRefresh: true,
      }),
    ).resolves.toBe('https://media.example/fresh-vault.mp4');
    releaseStaleVault?.();

    await expect(staleResolution).rejects.toMatchObject({ code: 'remote_unavailable' });
    // Resolve a different File so a stale directory write cannot hide behind
    // the first File's fresh media-URL cache.
    const secondStreamId = createMeshengerVideoStreamId(
      { ...refreshGrant, fileUri: 'w3ds://file?id=@generation-vault-test.w3id/second-file' },
      secret,
    );
    await expect(
      library.resolveMediaUrl({ eName: refreshGrant.eName }, secondStreamId),
    ).resolves.toBe('https://media.example/fresh-vault.mp4');
    expect(registryReads).toBe(2);
  });

  it('lets different forced video recoveries share an eVault without cancelling either result', async () => {
    const ownerEName = '@person.w3id';
    const firstGrant = {
      ...grant,
      fileUri: `w3ds://file?id=${ownerEName}/first-file`,
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    const secondGrant = {
      ...firstGrant,
      fileUri: `w3ds://file?id=${ownerEName}/second-file`,
    };
    let registryReads = 0;
    let releaseFirstRegistry: (() => void) | undefined;
    let firstRegistryStarted: (() => void) | undefined;
    const firstRegistryPending = new Promise<void>((resolve) => {
      firstRegistryStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        if (url.pathname === '/resolve') {
          registryReads += 1;
          if (registryReads === 1) {
            firstRegistryStarted?.();
            return new Promise<Response>((resolve) => {
              releaseFirstRegistry = () =>
                resolve(json({ ename: ownerEName, uri: 'https://same-owner-vault.example' }));
            });
          }
          return Promise.resolve(
            json({ ename: ownerEName, uri: 'https://same-owner-vault.example' }),
          );
        }
        if (url.hostname === 'same-owner-vault.example' && url.pathname === '/files/first-file') {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/first-forced.mp4' },
            }),
          );
        }
        if (url.hostname === 'same-owner-vault.example' && url.pathname === '/files/second-file') {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/second-forced.mp4' },
            }),
          );
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    const library = configuredLibrary();
    const firstStream = createMeshengerVideoStreamId(firstGrant, secret);
    const secondStream = createMeshengerVideoStreamId(secondGrant, secret);
    try {
      const first = library.resolveMediaUrl({ eName: firstGrant.eName }, firstStream, {
        forceSourceRefresh: true,
      });
      await firstRegistryPending;

      await expect(
        library.resolveMediaUrl({ eName: secondGrant.eName }, secondStream, {
          forceSourceRefresh: true,
        }),
      ).resolves.toBe('https://media.example/second-forced.mp4');
      releaseFirstRegistry?.();

      await expect(first).resolves.toBe('https://media.example/first-forced.mp4');
      expect(registryReads).toBe(2);
    } finally {
      releaseFirstRegistry?.();
      vi.unstubAllGlobals();
    }
  });

  it('adopts a ready handoff for one video while another video refreshes the same eVault', async () => {
    const ownerEName = '@person.w3id';
    const firstGrant = {
      ...grant,
      fileUri: `w3ds://file?id=${ownerEName}/adopt-first-file`,
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    const secondGrant = {
      ...firstGrant,
      fileUri: `w3ds://file?id=${ownerEName}/adopt-second-file`,
    };
    let registryReads = 0;
    let firstFileReads = 0;
    let releaseSecondRegistry: (() => void) | undefined;
    let secondRegistryStarted: (() => void) | undefined;
    const secondRegistryPending = new Promise<void>((resolve) => {
      secondRegistryStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        if (url.pathname === '/resolve') {
          registryReads += 1;
          if (registryReads === 2) {
            secondRegistryStarted?.();
            return new Promise<Response>((resolve) => {
              releaseSecondRegistry = () =>
                resolve(json({ ename: ownerEName, uri: 'https://adopt-owner-vault.example' }));
            });
          }
          return Promise.resolve(
            json({ ename: ownerEName, uri: 'https://adopt-owner-vault.example' }),
          );
        }
        if (
          url.hostname === 'adopt-owner-vault.example' &&
          url.pathname === '/files/adopt-first-file'
        ) {
          firstFileReads += 1;
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/adopt-stale.mp4' },
            }),
          );
        }
        if (
          url.hostname === 'adopt-owner-vault.example' &&
          url.pathname === '/files/adopt-second-file'
        ) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/adopt-second.mp4' },
            }),
          );
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );

    const library = configuredLibrary();
    const firstStream = createMeshengerVideoStreamId(firstGrant, secret);
    const secondStream = createMeshengerVideoStreamId(secondGrant, secret);
    try {
      await expect(library.resolveMediaUrl({ eName: firstGrant.eName }, firstStream)).resolves.toBe(
        'https://media.example/adopt-stale.mp4',
      );
      const proof = await library.proveCurrentPlayableStreamForSourceRefresh(
        { eName: firstGrant.eName },
        firstStream,
      );

      const second = library.resolveMediaUrl({ eName: secondGrant.eName }, secondStream, {
        forceSourceRefresh: true,
      });
      await secondRegistryPending;

      expect(
        library.adoptReadyPlaybackSourceAfterCurrentProof(
          { eName: firstGrant.eName },
          firstStream,
          proof,
          'https://media.example/adopt-fresh.mp4',
        ),
      ).toBe(true);
      releaseSecondRegistry?.();
      await expect(second).resolves.toBe('https://media.example/adopt-second.mp4');

      await expect(library.resolveMediaUrl({ eName: firstGrant.eName }, firstStream)).resolves.toBe(
        'https://media.example/adopt-fresh.mp4',
      );
      expect(firstFileReads).toBe(1);
    } finally {
      releaseSecondRegistry?.();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a receipt-authorized durable handoff after the receipt-local window ends', async () => {
    const receiptGrant = {
      ...grant,
      fileUri: 'w3ds://file?id=@person.w3id/receipt-adopt-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    let fileReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL) => {
        if (url.pathname === '/resolve') {
          return Promise.resolve(
            json({ ename: '@person.w3id', uri: 'https://receipt-vault.example' }),
          );
        }
        if (
          url.hostname === 'receipt-vault.example' &&
          url.pathname === '/files/receipt-adopt-file'
        ) {
          fileReads += 1;
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://media.example/receipt-stale.mp4' },
            }),
          );
        }
        throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
      }),
    );
    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(receiptGrant, secret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: receiptGrant.eName,
      streamId,
      env: { W3DS_AUTH_JWT_SECRET: secret },
    });

    try {
      await expect(library.resolveMediaUrl({ eName: receiptGrant.eName }, streamId)).resolves.toBe(
        'https://media.example/receipt-stale.mp4',
      );
      expect(
        library.adoptReadyPlaybackSourceAfterAuthorizationReceipt(
          { eName: receiptGrant.eName },
          streamId,
          receipt,
          'https://media.example/receipt-fresh.mp4',
        ),
      ).toBe(true);

      await expect(library.resolveMediaUrl({ eName: receiptGrant.eName }, streamId)).resolves.toBe(
        'https://media.example/receipt-fresh.mp4',
      );
      expect(fileReads).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not let normal work that began during a forced refresh warm a stale source', async () => {
    const refreshGrant = {
      eName: '@active-refresh-test.w3id',
      fileUri: 'w3ds://file?id=@active-refresh-test.w3id/active-refresh-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    let registryReads = 0;
    let releaseForcedDirectory: (() => void) | undefined;
    let releaseNormalFile: (() => void) | undefined;
    let forcedDirectoryStarted: (() => void) | undefined;
    let normalFileStarted: (() => void) | undefined;
    const forcedDirectoryPending = new Promise<void>((resolve) => {
      forcedDirectoryStarted = resolve;
    });
    const normalFilePending = new Promise<void>((resolve) => {
      normalFileStarted = resolve;
    });
    const fetcher = vi.fn((url: URL) => {
      if (url.pathname === '/resolve') {
        registryReads += 1;
        if (registryReads === 1) {
          forcedDirectoryStarted?.();
          return new Promise<Response>((resolve) => {
            releaseForcedDirectory = () =>
              resolve(json({ ename: '@vault.w3id', uri: 'https://fresh-vault.example' }));
          });
        }
        return Promise.resolve(json({ ename: '@vault.w3id', uri: 'https://old-vault.example' }));
      }
      if (url.hostname === 'fresh-vault.example' && url.pathname.startsWith('/files/')) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/fresh-active.mp4' },
          }),
        );
      }
      if (url.hostname === 'old-vault.example' && url.pathname.startsWith('/files/')) {
        normalFileStarted?.();
        return new Promise<Response>((resolve) => {
          releaseNormalFile = () =>
            resolve(
              new Response(null, {
                status: 302,
                headers: { location: 'https://media.example/stale-active.mp4' },
              }),
            );
        });
      }
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(refreshGrant, secret);
    const forced = library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId, {
      forceSourceRefresh: true,
    });
    await forcedDirectoryPending;
    const normal = library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId, {
      priority: 'background',
    });
    await normalFilePending;
    releaseForcedDirectory?.();
    await expect(forced).resolves.toBe('https://media.example/fresh-active.mp4');
    releaseNormalFile?.();
    await expect(normal).rejects.toMatchObject({ code: 'remote_unavailable' });
    await expect(library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId)).resolves.toBe(
      'https://media.example/fresh-active.mp4',
    );
  });

  it('does not return an older forced source after a newer recovery supersedes it', async () => {
    const refreshGrant = {
      eName: '@superseded-refresh-test.w3id',
      fileUri: 'w3ds://file?id=@superseded-refresh-test.w3id/superseded-refresh-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    let fileReads = 0;
    let releaseFirstFile: (() => void) | undefined;
    let firstFileStarted: (() => void) | undefined;
    const firstFilePending = new Promise<void>((resolve) => {
      firstFileStarted = resolve;
    });
    const fetcher = vi.fn((url: URL) => {
      if (url.pathname === '/resolve') {
        return Promise.resolve(json({ ename: '@vault.w3id', uri: 'https://vault.example' }));
      }
      if (url.pathname.startsWith('/files/')) {
        fileReads += 1;
        if (fileReads === 1) {
          firstFileStarted?.();
          return new Promise<Response>((resolve) => {
            releaseFirstFile = () =>
              resolve(
                new Response(null, {
                  status: 302,
                  headers: { location: 'https://media.example/older-forced.mp4' },
                }),
              );
          });
        }
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/newer-forced.mp4' },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const library = configuredLibrary();
    const streamId = createMeshengerVideoStreamId(refreshGrant, secret);
    const first = library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId, {
      forceSourceRefresh: true,
    });
    await firstFilePending;
    await expect(
      library.resolveMediaUrl({ eName: refreshGrant.eName }, streamId, {
        forceSourceRefresh: true,
      }),
    ).resolves.toBe('https://media.example/newer-forced.mp4');
    releaseFirstFile?.();
    await expect(first).rejects.toMatchObject({ code: 'remote_unavailable' });
  });

  it('refreshes a cached eVault directory once when its old File location is missing', async () => {
    vi.useFakeTimers();
    let registryReads = 0;
    let oldMovedFileReads = 0;
    let freshMovedFileReads = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        registryReads += 1;
        return json({
          ename: '@person.w3id',
          uri: registryReads === 1 ? 'https://old-vault.example' : 'https://new-vault.example',
        });
      }
      if (url.hostname === 'old-vault.example' && url.pathname === '/files/cache-seed') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/cache-seed.mp4' },
        });
      }
      if (url.hostname === 'old-vault.example' && url.pathname === '/files/moved-file') {
        oldMovedFileReads += 1;
        return new Response(null, { status: 404 });
      }
      if (url.hostname === 'old-vault.example' && url.pathname === '/graphql') {
        return new Response(null, { status: 404 });
      }
      if (url.hostname === 'new-vault.example' && url.pathname === '/files/moved-file') {
        freshMovedFileReads += 1;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/moved-file.mp4' },
        });
      }
      if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
      throw new Error(`Unexpected request: ${url.hostname}${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const stream = (fileId: string) =>
      createMeshengerVideoStreamId(
        {
          ...grant,
          fileUri: `w3ds://file?id=@person.w3id/${fileId}`,
          expiresAt: Date.now() + 10 * 60_000,
        },
        secret,
      );

    try {
      const library = configuredLibrary();
      // Seed only non-authorizing directory metadata. The next stream shares
      // the old mapping, then the File/metadata source proves it is stale.
      await expect(
        library.resolveMediaUrl({ eName: grant.eName }, stream('cache-seed')),
      ).resolves.toBe('https://media.example/cache-seed.mp4');
      // The previous one-minute directory cache would be cold by now. Keep
      // the non-authorizing mapping warm through normal browsing, then prove
      // that a moved source still forces one fresh registry lookup.
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(
        library.resolveMediaUrl({ eName: grant.eName }, stream('moved-file')),
      ).resolves.toBe('https://media.example/moved-file.mp4');

      expect(registryReads).toBe(2);
      expect(oldMovedFileReads).toBe(1);
      expect(freshMovedFileReads).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('retries a transient File redirect after upstream invalidation instead of retaining its stale GraphQL fallback', async () => {
    const staleGrant = {
      eName: '@cache-reset.w3id',
      fileUri: 'w3ds://file?id=@cache-reset.w3id/reset-file',
      accessScope: 'personal' as const,
      expiresAt: Date.now() + 60_000,
    };
    let readCount = 0;
    let registryReads = 0;
    let directFileReads = 0;
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') {
        registryReads += 1;
        return json({ ename: '@vault.w3id', uri: 'https://vault.example' });
      }
      if (url.pathname.startsWith('/files/')) {
        directFileReads += 1;
        if (directFileReads === 1) return new Response(null, { status: 503 });
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example/refreshed.mp4' },
        });
      }
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      readCount += 1;
      return json({
        data: {
          metaEnvelope: {
            id: 'reset-file',
            ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            parsed: {
              publicUrl: 'https://media.example/expired.mp4',
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
      await library.invalidateMediaUrl({ eName: staleGrant.eName }, streamId);
      await expect(library.resolveMediaUrl({ eName: staleGrant.eName }, streamId)).resolves.toBe(
        'https://media.example/refreshed.mp4',
      );
      expect(directFileReads).toBe(2);
      expect(readCount).toBe(1);
      expect(registryReads).toBe(2);
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
          title: t('Owned studio clip.mp4'),
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
          title: t('Same clip.mp4'),
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
          title: t('Briefing.mp4'),
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
          title: t('Earlier briefing.mp4'),
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
        expect.objectContaining({ title: t('Indexed clip.mp4'), accessScope: 'shared' }),
      ]);
      expect(workspace.completeness).toEqual({
        indexed: 1,
        expected: 2,
        denied: 0,
        missing: 1,
        failed: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
        retrying: 0,
        deferred: 0,
        coverage: emptyInventoryCoverage,
        media: { ...emptyInventoryMediaCounts, unresolved: {} },
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
      expect(videos.map((video) => video.title).sort()).toEqual([
        t('First page.mp4'),
        t('Second page.mp4'),
      ]);
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
        expect.objectContaining({ title: t('Kept clip.mp4'), accessScope: 'shared' }),
      ]);
      expect(workspace.completeness).toEqual({
        indexed: 1,
        expected: 1,
        denied: 0,
        missing: 0,
        failed: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
        retrying: 0,
        deferred: 0,
        coverage: emptyInventoryCoverage,
        media: { ...emptyInventoryMediaCounts, unresolved: {} },
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
        expect.objectContaining({ title: t('Alias clip.mp4'), accessScope: 'shared' }),
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
      expect(videos).toEqual([expect.objectContaining({ title: t('Visible clip.mp4') })]);
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
        failed: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
        retrying: 0,
        deferred: 0,
        coverage: emptyInventoryCoverage,
        media: { ...emptyInventoryMediaCounts, unresolved: {} },
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
      if (url.hostname === 'alumni-vault.example')
        return new Response('forbidden', { status: 403 });
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
        expect.objectContaining({ title: t('Group clip.mp4'), accessScope: 'shared' }),
      ]);
      expect(workspace.completeness).toEqual({
        indexed: 1,
        expected: 1,
        denied: 0,
        missing: 0,
        failed: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
        retrying: 0,
        deferred: 0,
        coverage: emptyInventoryCoverage,
        media: { ...emptyInventoryMediaCounts, unresolved: {} },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not scan shared spaces when the caller asks for owned scope', async () => {
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
                    id: 'group-ref',
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
        throw new Error('owned scope must not read shared vaults');
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const workspace = await configuredLibrary().listWithContext(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { scope: 'owned' },
      );
      expect(workspace.items).toEqual([]);
      expect(
        fetcher.mock.calls.some(([url]) => (url as URL).hostname === 'group-vault.example'),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails fast on 429 instead of retrying during the inventory request', async () => {
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      return new Response('too many requests', { status: 429 });
    });
    vi.stubGlobal('fetch', fetcher);
    const started = Date.now();
    try {
      await expect(
        configuredLibrary().list({
          eName: '@person.w3id',
          eVaultUri: 'https://vault.example',
        }),
      ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(fetcher.mock.calls.length).toBeLessThan(12);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries a first-pass 429 in the background and emits additional owned cards', async () => {
    const fileOntology = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    let filePages = 0;
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      const body = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { ontologyId?: string; after?: string | null };
      };
      if (body.variables?.ontologyId === fileOntology) {
        filePages += 1;
        if (filePages === 1) return new Response('too many requests', { status: 429 });
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'owned-after-retry',
                    ontology: fileOntology,
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'Recovered take.mp4',
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
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const titles: string[][] = [];
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        {
          scope: 'owned',
          onSnapshot: (library) => {
            titles.push(library.items.map((item) => item.title));
          },
        },
      );
      expect(titles.some((page) => page.includes(t('Recovered take.mp4')))).toBe(true);
      expect(result.items.map((item) => item.title)).toContain(t('Recovered take.mp4'));
      expect(result.completeness.complete).toBe(true);
      expect(result.completeness.retryNeeded).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('paginates owned sources and merges later pages without dropping the first', async () => {
    const fileOntology = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      const body = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { ontologyId?: string; after?: string | null };
      };
      if (body.variables?.ontologyId === fileOntology) {
        if (!body.variables.after) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'page-one',
                      ontology: fileOntology,
                      parsed: {
                        contentType: 'video/mp4',
                        filename: 'First page.mp4',
                        createdAt: '2026-08-21T10:00:00.000Z',
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            },
          });
        }
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'page-two',
                    ontology: fileOntology,
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'Second page.mp4',
                      createdAt: '2026-08-22T10:00:00.000Z',
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
      const snapshots: string[][] = [];
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        {
          scope: 'owned',
          onSnapshot: (library) => {
            snapshots.push(library.items.map((item) => item.title));
          },
        },
      );
      expect(snapshots.some((page) => page.length === 1 && page[0] === t('First page.mp4'))).toBe(
        true,
      );
      expect(result.items.map((item) => item.title)).toEqual(
        expect.arrayContaining([t('First page.mp4'), t('Second page.mp4')]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries a 429 shared space then paginated chats without dropping earlier cards', async () => {
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    const fileOntology = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const manifestOntology = 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e';
    const groupHits = new Map<string, number>();
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        const id = url.searchParams.get('w3id');
        if (id === '@group-a.w3id') return json({ ename: id, uri: 'https://group-a.example' });
        if (id === '@group-b.w3id') return json({ ename: id, uri: 'https://group-b.example' });
        return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { ontologyId?: string; after?: string | null };
      };
      const ontologyId = body.variables?.ontologyId;
      if (url.hostname === 'person-vault.example' && ontologyId === chatOntology) {
        if (!body.variables?.after) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'ref-a',
                      ontology: chatOntology,
                      parsed: {
                        isReference: true,
                        canonicalOwnerEName: '@group-a.w3id',
                        canonicalChatId: 'chat-a',
                        type: 'group',
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'chats-2' },
              },
            },
          });
        }
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-b',
                    ontology: chatOntology,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group-b.w3id',
                      canonicalChatId: 'chat-b',
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
      if (url.hostname === 'group-a.example') {
        const n = (groupHits.get(ontologyId ?? 'all') ?? 0) + 1;
        groupHits.set(ontologyId ?? 'all', n);
        if (n === 1) return new Response('too many requests', { status: 429 });
        if (ontologyId === manifestOntology) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'manifest-a',
                      ontology: manifestOntology,
                      parsed: { owner: '@group-a.w3id', members: ['@person.w3id'] },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (ontologyId === fileOntology) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'clip-a',
                      ontology: fileOntology,
                      parsed: {
                        contentType: 'video/mp4',
                        filename: 'Group A clip.mp4',
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
      }
      if (url.hostname === 'group-b.example' && ontologyId === fileOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'clip-b',
                    ontology: fileOntology,
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'Group B clip.mp4',
                      createdAt: '2026-08-21T10:00:00.000Z',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.hostname === 'group-b.example' && ontologyId === manifestOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-b',
                    ontology: manifestOntology,
                    parsed: { owner: '@group-b.w3id', members: ['@person.w3id'] },
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
      const snapshots: string[][] = [];
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        {
          scope: 'shared',
          onSnapshot: (library) => {
            snapshots.push(library.items.map((item) => item.title));
          },
        },
      );
      expect(snapshots[0]?.length ?? 0).toBeLessThan(result.items.length);
      expect(result.items.map((item) => item.title)).toEqual(
        expect.arrayContaining([t('Group A clip.mp4'), t('Group B clip.mp4')]),
      );
      expect(result.completeness.retryNeeded).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not scan shared group vaults when owned scope is requested', async () => {
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.hostname === 'group-vault.example') {
        throw new Error('owned scope must not read shared vaults');
      }
      return json({
        data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { scope: 'owned', onSnapshot: () => undefined },
      );
      expect(
        fetcher.mock.calls.some(([url]) => (url as URL).hostname === 'group-vault.example'),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('scans the complete union and classifies ownership by record owner, not discovery space', async () => {
    const ownCallUri = 'w3ds://file?id=@person.w3id/own-call';
    const friendClipUri = 'w3ds://file?id=@friend.w3id/friend-clip';
    const ownGroupUri = 'w3ds://file?id=@group.w3id/mine-in-group';
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        const id = url.searchParams.get('w3id');
        if (id === '@group.w3id') return json({ ename: id, uri: 'https://group-vault.example' });
        return json({ ename: '@person.w3id', uri: 'https://person-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      const ontologyId = body.variables?.ontologyId;
      if (
        url.hostname === 'person-vault.example' &&
        ontologyId === 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'own-call',
                    ontology: ontologyId,
                    parsed: {
                      initiator: '@person.w3id',
                      participants: ['@person.w3id', '@friend.w3id'],
                      recording: { mediaIsVideo: true, mediaUri: ownCallUri },
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
        ontologyId === '550e8400-e29b-41d4-a716-446655440003'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'group-ref',
                    ontology: ontologyId,
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
        ontologyId === 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-1',
                    ontology: ontologyId,
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
        ontologyId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'friend-clip',
                    ontology: ontologyId,
                    parsed: {
                      contentType: 'video/mp4',
                      filename: 'Friend briefing.mp4',
                      ownerId: '@friend.w3id',
                      uri: friendClipUri,
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
        ontologyId === '550e8400-e29b-41d4-a716-446655440004'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'mine-in-group',
                    ontology: ontologyId,
                    parsed: {
                      chatId: 'chat-1',
                      type: 'video',
                      senderEName: '@person.w3id',
                      mediaUri: ownGroupUri,
                      file: { filename: 'My group take.mp4' },
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
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      const titles = result.items.map((item) => item.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          'Call recording',
          t('Friend briefing.mp4'),
          t('My group take.mp4'),
        ]),
      );
      expect(new Set(titles).size).toBe(titles.length);
      expect(result.items.find((item) => item.title === 'Call recording')?.accessScope).toBe(
        'personal',
      );
      expect(result.items.find((item) => item.title === t('My group take.mp4'))?.accessScope).toBe(
        'shared',
      );
      expect(
        result.items.find((item) => item.title === t('Friend briefing.mp4'))?.accessScope,
      ).toBe('shared');
      expect(
        fetcher.mock.calls.some(([url]) => (url as URL).hostname === 'group-vault.example'),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resumes a 429 group history page after Retry-After without dropping earlier videos', async () => {
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    const messageOntology = '550e8400-e29b-41d4-a716-446655440004';
    const manifestOntology = 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e';
    let messagePages = 0;
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { ontologyId?: string; after?: string | null; chatId?: string };
      };
      const ontologyId = body.variables?.ontologyId;
      if (url.hostname === 'person-vault.example' && ontologyId === chatOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-1',
                    ontology: chatOntology,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-history',
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
      if (url.hostname === 'group-vault.example' && ontologyId === manifestOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-1',
                    ontology: manifestOntology,
                    parsed: { owner: '@group.w3id', members: ['@person.w3id'] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.hostname === 'group-vault.example' && ontologyId === chatOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'group-chat-1',
                    ontology: chatOntology,
                    parsed: { id: 'chat-history', type: 'group' },
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
        ontologyId === messageOntology &&
        body.variables?.chatId === 'chat-history'
      ) {
        if (!body.variables.after) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'msg-page-1',
                      ontology: messageOntology,
                      parsed: {
                        chatId: 'chat-history',
                        type: 'file',
                        mediaUrl: 'w3ds://file?id=@group.w3id/page-one',
                        file: { name: 'History page one.mp4' },
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'msgs-2' },
              },
            },
          });
        }
        messagePages += 1;
        if (messagePages === 1) return rateLimited();
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'msg-page-2',
                    ontology: messageOntology,
                    parsed: {
                      chatId: 'chat-history',
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@group.w3id/page-two',
                      file: { name: 'History page two.mp4' },
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
      const snapshots: string[][] = [];
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        {
          scope: 'shared',
          onSnapshot: (library) => {
            snapshots.push(library.items.map((item) => item.title));
          },
        },
      );
      expect(snapshots.some((page) => page.includes(t('History page one.mp4')))).toBe(true);
      expect(result.items.map((item) => item.title)).toEqual(
        expect.arrayContaining([t('History page one.mp4'), t('History page two.mp4')]),
      );
      expect(result.completeness).toMatchObject({
        indexed: 1,
        expected: 1,
        complete: true,
        retryNeeded: false,
        retrying: 0,
        deferred: 0,
      });
      expect(messagePages).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not surface zip or document attachments as video cards', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      const body = JSON.parse(String(init.body ?? '{}')) as { variables?: { ontologyId?: string } };
      if (body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440004') {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'zip-1',
                    ontology: '550e8400-e29b-41d4-a716-446655440004',
                    parsed: {
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@person.w3id/archive',
                      mimeType: 'application/zip',
                      file: { name: 'bundle.zip' },
                    },
                  },
                },
                {
                  node: {
                    id: 'vid-1',
                    ontology: '550e8400-e29b-41d4-a716-446655440004',
                    parsed: {
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@person.w3id/clip',
                      file: { name: 'Keep this.mp4' },
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
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'owned', onSnapshot: () => undefined },
      );
      expect(result.items.map((item) => item.title)).toEqual([t('Keep this.mp4')]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('follows official Chat participant grants onto the other vault without Meshenger isReference', async () => {
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    const messageOntology = '550e8400-e29b-41d4-a716-446655440004';
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { ontologyId?: string; chatId?: string };
      };
      if (url.hostname === 'person-vault.example' && body.variables?.ontologyId === chatOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'official-dm',
                    ontology: chatOntology,
                    parsed: {
                      type: 'direct',
                      id: 'dm-1',
                      participantIds: ['@person.w3id', '@friend.w3id'],
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
        url.hostname === 'friend-vault.example' &&
        body.variables?.ontologyId === messageOntology &&
        body.variables.chatId === 'dm-1'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'friend-clip',
                    ontology: messageOntology,
                    parsed: {
                      chatId: 'dm-1',
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@friend.w3id/briefing',
                      file: { name: 'Official dm clip.mp4' },
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
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { scope: 'shared', onSnapshot: () => undefined },
      );
      expect(result.items.map((item) => item.title)).toContain(t('Official dm clip.mp4'));
      expect(result.completeness.coverage?.officialChatGrants).toBeGreaterThan(0);
      expect(result.completeness.coverage?.directChats).toBeGreaterThan(0);
      expect(result.completeness.complete).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries and prewarms an accepted shared File from eVault inventory before the first Watch', async () => {
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    const messageOntology = '550e8400-e29b-41d4-a716-446655440004';
    let fileMetadataReads = 0;
    let directFileReads = 0;
    let refreshed = false;
    const fetcher = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === '/platforms/certification') {
        return json({ token: 'registry-platform-token' });
      }
      if (url.pathname === '/resolve') {
        return json({ ename: '@friend.w3id', uri: 'https://friend-vault.example' });
      }
      if (url.hostname === 'friend-vault.example' && url.pathname === '/files/briefing') {
        directFileReads += 1;
        if (refreshed) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://media.example/refreshed-after-invalidation.mp4' },
          });
        }
        return new Response(null, { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        variables?: { id?: string; ontologyId?: string; chatId?: string };
      };
      if (url.hostname === 'friend-vault.example' && body.variables?.id === 'briefing') {
        fileMetadataReads += 1;
        // The cache fill is deliberately independent of card discovery. A
        // transient eVault failure must be retried by the background pump,
        // rather than making the first Watch pay for a cold metadata read.
        if (fileMetadataReads === 1) return new Response(null, { status: 503 });
        return json({
          data: {
            metaEnvelope: {
              id: 'briefing',
              ontology: 'w3ds-file-v1',
              parsed: {
                contentType: 'video/mp4',
                filename: 'Official dm clip.mp4',
                publicUrl: 'https://media.example/prewarmed.mp4',
              },
            },
          },
        });
      }
      if (url.hostname === 'person-vault.example' && body.variables?.ontologyId === chatOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'official-dm',
                    ontology: chatOntology,
                    parsed: {
                      type: 'direct',
                      id: 'dm-1',
                      participantIds: ['@person.w3id', '@friend.w3id'],
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
        url.hostname === 'friend-vault.example' &&
        body.variables?.ontologyId === messageOntology &&
        body.variables.chatId === 'dm-1'
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'friend-clip',
                    ontology: messageOntology,
                    parsed: {
                      chatId: 'dm-1',
                      type: 'file',
                      mediaUrl: 'w3ds://file?id=@friend.w3id/briefing',
                      file: { name: 'Official dm clip.mp4' },
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
    // Model the encrypted cache that survives the inventory worker's process
    // and is readable by the later request-scoped playback library.
    setEVaultMediaUrlCacheForTests(
      new InMemoryEVaultMediaUrlCache({ env: { W3DS_AUTH_JWT_SECRET: secret } }),
    );
    try {
      const library = configuredLibrary();
      const result = await library.scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { scope: 'shared', onSnapshot: () => undefined },
      );
      const card = result.items.find((item) => item.title === t('Official dm clip.mp4'));
      expect(card?.streamIds).toHaveLength(1);
      expect(fileMetadataReads).toBe(2);
      expect(JSON.stringify(card)).not.toContain('https://media.example/prewarmed.mp4');

      // A process restart clears the local short-burst warmup. Inventory did
      // not reserve a durable write token before its source I/O, so it must
      // not publish an opaque redirect that could later expire or survive an
      // explicit invalidation. The first Watch safely repeats canonical eVault
      // resolution; foreground resolution owns durable caching when its
      // redirect exposes a portable expiry.
      resetMeshengerVideoLibraryCachesForTests();
      const restartedLibrary = configuredLibrary();
      const streamId = card?.streamIds[0];
      if (!streamId) throw new Error('Expected an opaque stream ID for the shared File.');
      await expect(
        restartedLibrary.resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
          hasRecentSharedAuthorizationReceipt: true,
        }),
      ).resolves.toBe('https://media.example/prewarmed.mp4');
      expect(fileMetadataReads).toBe(3);
      expect(directFileReads).toBe(1);

      // A source rejection/invalidation must evict the prewarmed entry just
      // like an ordinary foreground-resolved URL.
      await restartedLibrary.invalidateMediaUrl({ eName: '@person.w3id' }, streamId);
      refreshed = true;
      await expect(
        restartedLibrary.resolveMediaUrl({ eName: '@person.w3id' }, streamId, {
          priority: 'interactive',
          hasRecentSharedAuthorizationReceipt: true,
        }),
      ).resolves.toBe('https://media.example/refreshed-after-invalidation.mp4');
      expect(directFileReads).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('inventories member group messages that chatId search would miss', async () => {
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    const messageOntology = '550e8400-e29b-41d4-a716-446655440004';
    const manifestOntology = 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e';
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as {
        query?: string;
        variables?: { ontologyId?: string; chatId?: string };
      };
      if (url.hostname === 'person-vault.example' && body.variables?.ontologyId === chatOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-1',
                    ontology: chatOntology,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-known',
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
        body.variables?.ontologyId === manifestOntology
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-1',
                    ontology: manifestOntology,
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
        body.variables?.ontologyId === messageOntology &&
        !body.variables.chatId
      ) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'orphan-msg',
                    ontology: messageOntology,
                    parsed: {
                      type: 'video',
                      fileId: 'w3ds://file?id=@group.w3id/orphan',
                      file: { filename: 'Unscoped group clip.mp4' },
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
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { scope: 'shared', onSnapshot: () => undefined },
      );
      expect(result.items.map((item) => item.title)).toContain(t('Unscoped group clip.mp4'));
      expect(result.completeness.coverage?.referenceGrants).toBeGreaterThan(0);
      expect(result.completeness.coverage?.messagePages).toBeGreaterThan(0);
      expect(result.completeness.coverage?.groupManifestPages).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pages GroupManifest until membership is found and then lists member files', async () => {
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    const manifestOntology = 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e';
    const fileOntology = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    let manifestPages = 0;
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification')
        return json({ token: 'registry-platform-token' });
      if (url.pathname === '/resolve') {
        return json({ ename: '@group.w3id', uri: 'https://group-vault.example' });
      }
      const body = JSON.parse(String(init.body ?? '{}')) as {
        variables?: { ontologyId?: string; after?: string | null };
      };
      if (url.hostname === 'person-vault.example' && body.variables?.ontologyId === chatOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'ref-1',
                    ontology: chatOntology,
                    parsed: {
                      isReference: true,
                      canonicalOwnerEName: '@group.w3id',
                      canonicalChatId: 'chat-known',
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
        body.variables?.ontologyId === manifestOntology
      ) {
        manifestPages += 1;
        if (!body.variables.after) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'manifest-old',
                      ontology: manifestOntology,
                      parsed: { owner: '@group.w3id', members: ['@other.w3id'] },
                    },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'manifests-2' },
              },
            },
          });
        }
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'manifest-current',
                    ontology: manifestOntology,
                    parsed: { owner: '@group.w3id', members: ['@person.w3id'] },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.hostname === 'group-vault.example' && body.variables?.ontologyId === fileOntology) {
        return json({
          data: {
            metaEnvelopes: {
              edges: [
                {
                  node: {
                    id: 'member-file',
                    ontology: fileOntology,
                    parsed: {
                      mimeType: 'video/mp4',
                      name: 'Member-only take.mp4',
                      uri: 'w3ds://file?id=@group.w3id/member-file',
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
      const result = await configuredLibrary().scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
        { scope: 'shared', onSnapshot: () => undefined },
      );
      expect(manifestPages).toBeGreaterThanOrEqual(2);
      expect(result.items.map((item) => item.title)).toContain(t('Member-only take.mp4'));
      expect(result.completeness.coverage?.groupManifestPages).toBeGreaterThanOrEqual(2);
      expect(result.completeness.coverage?.filePages).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('inventories a type=file attachment without filename or MIME via documented metaEnvelope resolution', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const body = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (body.includes('MeshengerVideoEnvelope') || body.includes('metaEnvelope(id')) {
          return json({
            data: {
              metaEnvelope: {
                id: 'bare-clip',
                ontology: 'w3ds-file-v1',
                parsed: { contentType: 'video/mp4' },
              },
            },
          });
        }
        if (body.includes('550e8400-e29b-41d4-a716-446655440004')) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'file-message-bare',
                      ontology: '550e8400-e29b-41d4-a716-446655440004',
                      parsed: {
                        type: 'file',
                        mediaUrl: 'w3ds://file?id=@person.w3id/bare-clip',
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
      const result = await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      expect(result.items.some((item) => item.kind === 'video-message')).toBe(true);
      expect(result.completeness.media?.accepted).toBeGreaterThan(0);
      expect(result.completeness.media?.candidates).toBeGreaterThan(0);
      expect(JSON.stringify(result.completeness.media)).not.toMatch(/@|https?:\/\//i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('inventories type=file media referenced only through documented envelopes, not parsed w3ds://file', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const body = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (body.includes('MeshengerVideoEnvelope') || body.includes('metaEnvelope(id')) {
          return json({
            data: {
              metaEnvelope: {
                id: 'envelope-clip',
                ontology: 'w3ds-file-v1',
                parsed: { contentType: 'video/mp4' },
                envelopes: [{ fieldKey: 'contentType', value: 'video/mp4', valueType: 'string' }],
              },
            },
          });
        }
        if (body.includes('550e8400-e29b-41d4-a716-446655440004')) {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'file-message-envelopes',
                      ontology: '550e8400-e29b-41d4-a716-446655440004',
                      parsed: { type: 'file' },
                      envelopes: [
                        {
                          fieldKey: 'mediaUrl',
                          value: 'w3ds://file?id=@person.w3id/envelope-clip',
                          valueType: 'string',
                        },
                      ],
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
      const result = await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      expect(result.items.some((item) => item.kind === 'video-message')).toBe(true);
      expect(result.completeness.media?.accepted).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reseals retained group-history cards from the saved current manifest before a deep rescan', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      completeness: { ...job.completeness, complete: false, retryNeeded: true },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        drainFinished: false,
        queue: [{ type: 'group-calls', after: null, attempts: 0, groupEName: '@group.w3id' }],
        found: [
          {
            key: 'call:@group.w3id/legacy-history-call',
            fileUris: ['w3ds://file?id=@media.w3id/legacy-history-file'],
            kind: 'call-recording',
            title: 'Retained group recording',
            accessScope: 'shared',
            sourceId: 'group-history:legacy',
            sourceSpaceKey: '@group.w3id',
            sourceChatId: 'group-chat',
            accessBasis: 'history',
          },
        ],
        openedGroups: [
          [
            '@group.w3id',
            {
              vault: { ownerEName: '@group.w3id', eVaultUri: 'https://group-vault.example' },
              member: true,
              currentManifestId: 'current-group-manifest',
            },
          ],
        ],
      },
    });

    const result = await createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store },
    ).scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
      { scope: 'all', drain: false, onSnapshot: () => undefined },
    );

    const card = result.items.find((item) => item.title === 'Retained group recording');
    const sealed = verifyMeshengerVideoStreamId(card?.streamIds[0] ?? '', secret);
    const saved = await store.getByOwner('@person.w3id');
    const savedRecord = Array.isArray(saved?.ledger.found)
      ? saved.ledger.found.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { key?: string }).key === 'call:@group.w3id/legacy-history-call',
        )
      : undefined;

    expect(sealed).toMatchObject({
      sourceChatKind: 'group',
      sourceGroupManifestId: 'current-group-manifest',
    });
    expect(JSON.stringify(card)).not.toContain('current-group-manifest');
    expect(savedRecord).toMatchObject({
      sourceChatKind: 'group',
      sourceGroupManifestId: 'current-group-manifest',
    });
  });

  it('reseals retained group-history cards as soon as group-open proves current membership', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      completeness: { ...job.completeness, complete: false, retryNeeded: true },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        drainFinished: false,
        queue: [{ type: 'group-open', groupEName: '@group.w3id', attempts: 0 }],
        found: [
          {
            key: 'call:@group.w3id/group-open-history-call',
            fileUris: ['w3ds://file?id=@media.w3id/group-open-history-file'],
            kind: 'call-recording',
            title: 'Group-open retained recording',
            accessScope: 'shared',
            sourceId: 'group-history:group-open',
            sourceSpaceKey: '@group.w3id',
            sourceChatId: 'group-chat',
            accessBasis: 'history',
          },
        ],
      },
    });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store },
    );
    const internals = library as unknown as {
      readGroupSpace: (input: unknown) => Promise<unknown>;
    };
    const readGroupSpace = vi.spyOn(internals, 'readGroupSpace').mockResolvedValue({
      videos: [],
      conversations: [],
      messages: [],
      outcome: 'indexed',
      retryNeeded: false,
      vault: { ownerEName: '@group.w3id', eVaultUri: 'https://group-vault.example' },
      currentMember: true,
      currentManifestId: 'group-open-current-manifest',
      openedChatIds: [],
      chatsComplete: true,
      manifestsComplete: true,
    });

    const result = await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
      { scope: 'shared', maxWaves: 1, onSnapshot: () => undefined },
    );
    const card = result.items.find((item) => item.title === 'Group-open retained recording');
    const sealed = verifyMeshengerVideoStreamId(card?.streamIds[0] ?? '', secret);
    const saved = await store.getByOwner('@person.w3id');
    const savedRecord = Array.isArray(saved?.ledger.found)
      ? saved.ledger.found.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { key?: string }).key === 'call:@group.w3id/group-open-history-call',
        )
      : undefined;

    expect(readGroupSpace).toHaveBeenCalledTimes(1);
    expect(sealed).toMatchObject({
      sourceChatKind: 'group',
      sourceGroupManifestId: 'group-open-current-manifest',
    });
    expect(savedRecord).toMatchObject({
      sourceChatKind: 'group',
      sourceGroupManifestId: 'group-open-current-manifest',
    });
    expect(saved?.ledger.queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'group-calls' })]),
    );
  });

  it('preserves saved GroupManifest pointers through a stale catalogue restart', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      completeness: { ...job.completeness, complete: false, retryNeeded: true },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION - 1,
        drainFinished: false,
        queue: [{ type: 'messages', after: 'obsolete-cursor', attempts: 0 }],
        found: [
          {
            key: 'call:@group.w3id/restarted-history-call',
            fileUris: ['w3ds://file?id=@media.w3id/restarted-history-file'],
            kind: 'call-recording',
            title: 'Restarted retained group recording',
            accessScope: 'shared',
            sourceId: 'group-history:restart',
            sourceSpaceKey: '@group.w3id',
            sourceChatId: 'group-chat',
            accessBasis: 'history',
          },
        ],
        openedGroups: [
          [
            '@group.w3id',
            {
              vault: { ownerEName: '@group.w3id', eVaultUri: 'https://group-vault.example' },
              member: true,
              currentManifestId: 'restarted-current-group-manifest',
            },
          ],
        ],
      },
    });

    const result = await createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store },
    ).scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
      { scope: 'shared', drain: false, onSnapshot: () => undefined },
    );
    const card = result.items.find((item) => item.title === 'Restarted retained group recording');
    const sealed = verifyMeshengerVideoStreamId(card?.streamIds[0] ?? '', secret);
    const saved = await store.getByOwner('@person.w3id');
    const savedRecord = Array.isArray(saved?.ledger.found)
      ? saved.ledger.found.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { key?: string }).key === 'call:@group.w3id/restarted-history-call',
        )
      : undefined;

    expect(sealed).toMatchObject({
      sourceChatKind: 'group',
      sourceGroupManifestId: 'restarted-current-group-manifest',
    });
    expect(savedRecord).toMatchObject({
      sourceChatKind: 'group',
      sourceGroupManifestId: 'restarted-current-group-manifest',
    });
    expect(saved?.ledger.openedGroups).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          '@group.w3id',
          expect.objectContaining({ currentManifestId: 'restarted-current-group-manifest' }),
        ]),
      ]),
    );
  });

  it('restarts a stale catalogue while rebuilding legacy shared records', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      completeness: { ...job.completeness, complete: false, retryNeeded: true },
      ledger: {
        drainFinished: false,
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION - 1,
        queue: [{ type: 'messages', after: 'stale-cursor', attempts: 0 }],
        found: [
          {
            key: 'w3ds-file:@person.w3id/kept-clip',
            fileUris: ['w3ds://file?id=@person.w3id/kept-clip'],
            kind: 'file',
            title: 'Kept library clip',
            accessScope: 'personal',
            sourceId: 'w3ds-file',
          },
          {
            key: 'call:@friend.w3id/legacy-shared-clip',
            fileUris: ['w3ds://file?id=@friend.w3id/legacy-shared-clip'],
            kind: 'call-recording',
            title: 'Legacy shared clip',
            accessScope: 'shared',
            sourceId: 'call-recording',
          },
          {
            key: 'message:@friend.w3id/verified-shared-clip',
            fileUris: ['w3ds://file?id=@friend.w3id/verified-shared-clip'],
            kind: 'video-message',
            title: 'Verified shared clip',
            accessScope: 'shared',
            sourceId: 'video-message',
            sourceSpaceKey: '@friend.w3id',
            sourceChatId: 'chat-1',
            accessBasis: 'history',
          },
        ],
      },
    });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store },
    );

    const result = await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
      { scope: 'all', drain: false, onSnapshot: () => undefined },
    );
    const saved = await store.getByOwner('@person.w3id');

    expect(result.items.map((item) => item.title)).toContain('Kept library clip');
    expect(result.items.map((item) => item.title)).not.toContain('Legacy shared clip');
    expect(result.items.map((item) => item.title)).toContain('Verified shared clip');
    expect(saved?.id).toBe(job.id);
    expect(saved?.status).toBe('running');
    expect(saved?.ledger.catalogueVersion).toBe(VIDEO_SPACE_CATALOGUE_VERSION);
    expect(saved?.ledger.drainFinished).toBe(false);
    expect(saved?.ledger.queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'messages', after: null })]),
    );
    expect(JSON.stringify(saved?.ledger.queue)).not.toContain('stale-cursor');
  });

  it('automatically restarts an incomplete catalogue whose queue and task rows were both lost', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      completeness: {
        ...job.completeness,
        indexed: 82,
        expected: 100,
        complete: false,
        retryNeeded: true,
      },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        drainFinished: false,
        queue: [],
        found: [
          {
            key: 'w3ds-file:@person.w3id/kept-clip',
            fileUris: ['w3ds://file?id=@person.w3id/kept-clip'],
            kind: 'file',
            title: 'Kept while recovering',
            accessScope: 'personal',
            sourceId: 'w3ds-file',
          },
        ],
      },
    });

    const result = await createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store },
    ).scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
      { scope: 'all', drain: false, onSnapshot: () => undefined },
    );
    const recovered = await store.getByOwner('@person.w3id');
    const tasks = recovered ? await store.loadOpenTasks(recovered.id) : [];

    expect(result.items.map((item) => item.title)).toContain('Kept while recovering');
    expect(recovered?.status).toBe('running');
    expect(recovered?.ledger.drainFinished).toBe(false);
    expect(recovered?.ledger.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'chats', after: null }),
        expect.objectContaining({ type: 'messages', after: null }),
      ]),
    );
    expect(tasks.map((task) => task.kind)).toEqual(
      expect.arrayContaining(['chats', 'messages', 'owned-source']),
    );
  });

  it('resolves a shared File reference to its canonical title with a viewer-bound playback grant', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.pathname === '/resolve') {
          return json({ uri: 'https://friend-vault.example', ename: '@friend.w3id' });
        }
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { ontologyId?: string };
        };
        if (url.host === 'friend-vault.example' && request.query?.includes('metaEnvelope(id:')) {
          return json({
            data: {
              metaEnvelope: {
                id: 'canonical-clip',
                ontology: 'w3ds-file-v1',
                parsed: {
                  contentType: 'video/mp4',
                  filename: 'Canonical recording.mp4',
                  publicUrl: 'https://media.example/canonical-clip.mp4',
                },
                envelopes: [],
              },
            },
          });
        }
        if (request.variables?.ontologyId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'local-reference',
                      ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                      parsed: {
                        isReference: true,
                        canonicalOwnerEName: '@friend.w3id',
                        canonicalFileId: 'canonical-clip',
                      },
                      envelopes: [],
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
      const library = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      );
      const probe = vi.spyOn(library, 'probeSharedSpaceAccess');
      const result = await library.scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      const card = result.items.find((item) => item.title === 'Canonical Recording');
      expect(card).toBeDefined();
      expect(card?.title).not.toBe('Untitled video');
      expect(card?.accessScope).toBe('shared');
      expect(card?.sourceSpaceKey).toBe('@friend.w3id');
      expect(card?.sourceReferenceId).toBe('local-reference');
      expect(card?.sourceReferenceFileId).toBe('canonical-clip');
      expect(card?.accessBasis).toBe('reference');
      expect(card?.streamIds).toHaveLength(1);
      await expect(
        library.inspectPlayableStream(
          { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
          card?.streamIds[0] ?? '',
          { priority: 'interactive' },
        ),
      ).resolves.toEqual({ fileUri: 'w3ds://file?id=@friend.w3id/canonical-clip' });
      expect(probe).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('removes a shared File placeholder when its canonical record is explicitly non-video', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification') return json({ token: 'platform-token' });
        if (url.pathname === '/resolve') {
          return json({ uri: 'https://friend-vault.example', ename: '@friend.w3id' });
        }
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          query?: string;
          variables?: { ontologyId?: string };
        };
        if (url.host === 'friend-vault.example' && request.query?.includes('metaEnvelope(id:')) {
          return json({
            data: {
              metaEnvelope: {
                id: 'canonical-image',
                ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                parsed: {
                  contentType: 'image/png',
                  filename: 'Screenshot.png',
                  publicUrl: 'https://media.example/screenshot.png',
                },
                envelopes: [],
              },
            },
          });
        }
        if (request.variables?.ontologyId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') {
          return json({
            data: {
              metaEnvelopes: {
                edges: [
                  {
                    node: {
                      id: 'local-reference',
                      ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                      parsed: {
                        isReference: true,
                        canonicalOwnerEName: '@friend.w3id',
                        canonicalFileId: 'canonical-image',
                      },
                      envelopes: [],
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
      const result = await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );

      expect(result.items).toEqual([]);
      expect(result.completeness.media?.unresolved.resolver_unavailable ?? 0).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resumes the exact unfinished chats cursor instead of restarting that ontology', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      ledger: {
        queue: [{ type: 'chats', after: 'cursor-chat-2', attempts: 0 }],
        drainFinished: false,
      },
    });
    const afterValues: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const raw = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (!raw.includes('{'))
          return json({
            data: {
              metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          });
        const body = JSON.parse(raw) as {
          variables?: { ontologyId?: string; after?: string | null };
        };
        if (body.variables?.ontologyId === '550e8400-e29b-41d4-a716-446655440003') {
          afterValues.push(body.variables.after ?? null);
        }
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      expect(afterValues).toContain('cursor-chat-2');
      expect(afterValues).not.toContain(null);
      const finished = await store.getByOwner('@person.w3id');
      expect(finished?.ledger.drainFinished).toBe(true);
      expect(finished?.status).toBe('complete');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not treat a complete row without drainFinished as a finished inventory', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: {
        indexed: 0,
        expected: 0,
        denied: 0,
        missing: 0,
        failed: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
        retrying: 0,
        deferred: 0,
      },
      ledger: { queue: [] },
    });
    let chatPages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const raw = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (raw.includes('550e8400-e29b-41d4-a716-446655440003')) chatPages += 1;
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      expect(chatPages).toBeGreaterThan(0);
      const finished = await store.getByOwner('@person.w3id');
      expect(finished?.ledger.drainFinished).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reseeds a drainFinished job that still has leftover retries instead of returning it as done', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: {
        indexed: 0,
        expected: 0,
        denied: 0,
        missing: 0,
        failed: 0,
        complete: false,
        retryNeeded: true,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 10,
        retrying: 10,
      },
      ledger: { queue: [], drainFinished: true, catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION },
    });
    let chatPages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const raw = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (raw.includes('550e8400-e29b-41d4-a716-446655440003')) chatPages += 1;
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      const result = await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      expect(chatPages).toBeGreaterThan(0);
      expect(result.completeness.retrying).toBe(0);
      expect(result.completeness.complete).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reseeds a falsely complete job that still has unsettled shared spaces', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: {
        indexed: 0,
        expected: 12,
        denied: 0,
        missing: 0,
        failed: 1,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 10,
        retrying: 0,
        deferred: 0,
      },
      ledger: {
        queue: [],
        drainFinished: true,
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        remaining: [
          ['@group-a.w3id', 2],
          ['@group-b.w3id', 1],
        ],
        settled: ['@failed.w3id'],
        referencedGroupChats: [['@group-a.w3id', ['chat-1']]],
        referencedDirectChats: [['@direct-a.w3id', ['chat-2']]],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      const result = await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      const saved = await store.getByOwner('@person.w3id');
      expect(saved?.status).toBe('running');
      expect(saved?.ledger.drainFinished).not.toBe(true);
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.expected).toBe(12);
      expect(
        result.completeness.indexed +
          result.completeness.denied +
          result.completeness.missing +
          (result.completeness.failed ?? 0),
      ).toBeLessThan(result.completeness.expected);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('repairs a rate-limit false complete job and resumes deferred spaces', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: {
        indexed: 3,
        expected: 12,
        denied: 0,
        missing: 0,
        failed: 9,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 10,
        retrying: 0,
        deferred: 0,
      },
      ledger: {
        queue: [],
        drainFinished: true,
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        remaining: [],
        settled: ['@a.w3id', '@b.w3id', '@c.w3id'],
        failedSpaces: ['@d.w3id', '@e.w3id'],
        referencedGroupChats: [['@d.w3id', ['chat-1']]],
        referencedDirectChats: [['@e.w3id', ['chat-2']]],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      const result = await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', onSnapshot: () => undefined },
      );
      const saved = await store.getByOwner('@person.w3id');
      expect(saved?.status).toBe('running');
      expect(saved?.ledger.drainFinished).not.toBe(true);
      expect(result.completeness.complete).toBe(false);
      expect(result.completeness.failed).toBeLessThan(9);
      expect(result.completeness.deferred).toBeGreaterThanOrEqual(2);
      expect(result.completeness.retryNeeded).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps paging after an HTTP hydrate when only drain continues', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    let chatPages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const raw = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (raw.includes('550e8400-e29b-41d4-a716-446655440003')) chatPages += 1;
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      const library = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      );
      await library.scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', drain: false, onSnapshot: () => undefined },
      );
      expect(chatPages).toBe(0);
      const seeded = await store.getByOwner('@person.w3id');
      expect(seeded?.status).toBe('running');
      expect(Array.isArray(seeded?.ledger.queue) ? seeded.ledger.queue.length : 0).toBeGreaterThan(
        0,
      );
      const seededOpen = seeded ? await store.loadOpenTasks(seeded.id) : [];
      expect(seededOpen.length).toBeGreaterThan(0);
      expect(seededOpen.every((task) => !task.taskKey.includes('\u0000'))).toBe(true);

      await library.scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', drain: true, onSnapshot: () => undefined },
      );
      expect(chatPages).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not grow retries when the same chats cursor is rate-limited three times', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    let chatHits = 0;
    let maxRetrying = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const raw = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (raw.includes(chatOntology)) {
          chatHits += 1;
          if (chatHits <= 3) return rateLimited('0');
        }
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      const result = await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        {
          scope: 'all',
          onSnapshot: (library) => {
            maxRetrying = Math.max(maxRetrying, library.completeness.retrying ?? 0);
          },
        },
      );
      expect(chatHits).toBe(4);
      expect(maxRetrying).toBe(1);
      expect(result.completeness.retrying).toBe(0);
      const job = await store.getByOwner('@person.w3id');
      expect(job).toBeDefined();
      const open = job ? await store.loadOpenTasks(job.id) : [];
      expect(open.filter((task) => task.kind === 'chats')).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps draining when open-task persistence fails', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    store.replaceOpenTasks = async () => {
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
    };
    let chatPages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const raw = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (raw.includes('550e8400-e29b-41d4-a716-446655440003')) chatPages += 1;
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
          W3DS_AUTH_JWT_SECRET: secret,
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', drain: true, onSnapshot: () => undefined },
      );
      expect(chatPages).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resumes open tasks instead of a stale ledger queue', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      ledger: { queue: [{ type: 'chats', after: 'stale', attempts: 0 }], drainFinished: false },
    });
    await store.saveTask({
      id: 'messages-task',
      jobId: job.id,
      taskKey: 'messages-task',
      kind: 'messages',
      vaultKey: '@person.w3id',
      cursorAfter: null,
      attempts: 0,
      notBefore: 0,
      status: 'pending',
      priority: 60,
      payload: { type: 'messages', after: null, attempts: 0 },
    });
    const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
    const messageOntology = '550e8400-e29b-41d4-a716-446655440004';
    let chatPages = 0;
    let messagePages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const raw = String(init.body ?? '');
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        if (raw.includes(chatOntology)) chatPages += 1;
        if (raw.includes(messageOntology)) messagePages += 1;
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_AUTH_JWT_SECRET: secret,
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', drain: true, onSnapshot: () => undefined },
      );
      expect(messagePages).toBeGreaterThan(0);
      expect(chatPages).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not let an HTTP hydrate shrink open tasks', async () => {
    const store = (await import('./video-space/job-store')).createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      ledger: { queue: [{ type: 'chats', after: null, attempts: 0 }], drainFinished: false },
    });
    for (const kind of ['chats', 'messages', 'group-files'] as const) {
      await store.saveTask({
        id: `${kind}-task`,
        jobId: job.id,
        taskKey: `${kind}-task`,
        kind,
        vaultKey: '@person.w3id',
        cursorAfter: null,
        attempts: 0,
        notBefore: 0,
        status: 'pending',
        priority: 30,
        payload: { type: kind, after: null, attempts: 0 },
      });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        if (url.pathname === '/platforms/certification')
          return json({ token: 'registry-platform-token' });
        return json({
          data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      }),
    );
    try {
      await createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_AUTH_JWT_SECRET: secret,
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        { scope: 'all', drain: false, onSnapshot: () => undefined },
      );
      const open = await store.loadOpenTasks(job.id);
      expect(open).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('checkpoints every selected durable cursor when playback cancels two source reads', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      ledger: {
        queue: [
          {
            type: 'group-chats',
            spaceKey: '@group-a.w3id',
            groupEName: '@group-a.w3id',
            owner: '@group-a.w3id',
            eVaultUri: 'https://group-a-vault.example',
            after: 'cursor-a',
            attempts: 0,
          },
          {
            type: 'group-chats',
            spaceKey: '@group-b.w3id',
            groupEName: '@group-b.w3id',
            owner: '@group-b.w3id',
            eVaultUri: 'https://group-b-vault.example',
            after: 'cursor-b',
            attempts: 0,
          },
        ],
        drainFinished: false,
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
      },
    });
    const controller = new AbortController();
    let sourceReads = 0;
    let notifyBothStarted: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      notifyBothStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification')
          return Promise.resolve(json({ token: 'registry-platform-token' }));
        if (url.host === 'group-a-vault.example' || url.host === 'group-b-vault.example') {
          sourceReads += 1;
          if (sourceReads === 2) notifyBothStarted();
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        throw new Error(`Unexpected request: ${url.toString()}`);
      }),
    );
    try {
      const phases: string[] = [];
      const pending = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_AUTH_JWT_SECRET: secret,
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        {
          scope: 'all',
          drain: true,
          maxVaultsPerWave: 2,
          onSnapshot: (_library, phase) => phases.push(phase),
          signal: controller.signal,
        },
      );

      await bothStarted;
      controller.abort();
      await pending;
      const saved = await store.getByOwner('@person.w3id');
      const open = saved ? await store.loadOpenTasks(saved.id) : [];
      const resumed = Array.isArray(saved?.ledger.queue) ? saved.ledger.queue : [];

      expect(phases.at(-1)).toBe('batch');
      expect(saved?.status).toBe('running');
      expect(saved?.ledger.drainFinished).toBe(false);
      expect(saved?.completeness.retryNeeded).toBe(false);
      expect(resumed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'group-chats', after: 'cursor-a', attempts: 0 }),
          expect.objectContaining({ type: 'group-chats', after: 'cursor-b', attempts: 0 }),
        ]),
      );
      expect(open.map((task) => task.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'group-chats', after: 'cursor-a', attempts: 0 }),
          expect.objectContaining({ type: 'group-chats', after: 'cursor-b', attempts: 0 }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('checkpoints active and queued eVault-preempted durable reads instead of treating them as scan failures', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'running',
      ledger: {
        queue: [
          {
            type: 'group-chats',
            spaceKey: '@group-a.w3id',
            groupEName: '@group-a.w3id',
            owner: '@group-a.w3id',
            eVaultUri: 'https://group-a-vault.example',
            after: 'resume-active-after-preemption',
            attempts: 0,
          },
          {
            type: 'group-chats',
            spaceKey: '@group-b.w3id',
            groupEName: '@group-b.w3id',
            owner: '@group-b.w3id',
            eVaultUri: 'https://group-b-vault.example',
            after: 'resume-queued-after-preemption',
            attempts: 0,
          },
        ],
        drainFinished: false,
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
      },
    });
    const inventoryController = new AbortController();
    let notifySourceReadStarted: () => void = () => undefined;
    const sourceReadStarted = new Promise<void>((resolve) => {
      notifySourceReadStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, init?: RequestInit) => {
        if (url.pathname === '/platforms/certification')
          return Promise.resolve(json({ token: 'registry-platform-token' }));
        if (url.host === 'group-a-vault.example' || url.host === 'group-b-vault.example') {
          notifySourceReadStarted();
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        throw new Error(`Unexpected request: ${url.toString()}`);
      }),
    );
    try {
      const phases: string[] = [];
      const pending = createMeshengerVideoLibrary(
        {
          W3DS_AUTH_PLATFORM_NAME: 'vidak',
          W3DS_AUTH_JWT_SECRET: secret,
          W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        },
        { jobStore: store },
      ).scanLibrary(
        { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
        {
          scope: 'all',
          drain: true,
          maxVaultsPerWave: 2,
          onSnapshot: (_library, phase) => phases.push(phase),
          signal: inventoryController.signal,
        },
      );

      await sourceReadStarted;
      const playback = beginInteractiveEVaultTrafficSession();
      try {
        await pending;
      } finally {
        playback.release();
      }

      const saved = await store.getByOwner('@person.w3id');
      const open = saved ? await store.loadOpenTasks(saved.id) : [];
      const resumed = Array.isArray(saved?.ledger.queue) ? saved.ledger.queue : [];

      expect(phases.at(-1)).toBe('batch');
      expect(saved?.status).toBe('running');
      expect(saved?.ledger.drainFinished).toBe(false);
      expect(saved?.completeness.retryNeeded).toBe(false);
      expect(resumed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'group-chats',
            after: 'resume-active-after-preemption',
            attempts: 0,
          }),
          expect.objectContaining({
            type: 'group-chats',
            after: 'resume-queued-after-preemption',
            attempts: 0,
          }),
        ]),
      );
      expect(open.map((task) => task.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'group-chats',
            after: 'resume-active-after-preemption',
            attempts: 0,
          }),
          expect.objectContaining({
            type: 'group-chats',
            after: 'resume-queued-after-preemption',
            attempts: 0,
          }),
        ]),
      );
    } finally {
      inventoryController.abort();
      vi.unstubAllGlobals();
    }
  });

  it('durably prewarms only the first source of retained shared call recordings', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://person-vault.example',
    });
    const firstSegment = 'w3ds://file?id=@media.w3id/retained-call-part-1';
    const secondSegment = 'w3ds://file?id=@media.w3id/retained-call-part-2';
    await store.saveJob({
      ...job,
      // A production job remains running only because this optional warmup
      // is queued. Pressure mode must finish it, not reseed the catalogue.
      status: 'running',
      completeness: { ...completeInventory },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        drainFinished: false,
        queue: [],
        found: [
          {
            key: 'call:@group.w3id/retained-call',
            fileUris: [firstSegment, secondSegment],
            kind: 'call-recording',
            title: 'Retained continuous recording',
            accessScope: 'shared',
            sourceId: 'call-recording',
            sourceSpaceKey: '@group.w3id',
            sourceGroupManifestId: 'current-group-manifest',
            sourceChatId: 'group-chat',
            sourceCallSessionId: 'group-call-1',
            sourceCallSessionVault: '@group.w3id',
            sourceRecordingVault: '@media.w3id',
            sourceChatKind: 'group',
            accessBasis: 'history',
          },
        ],
      },
    });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store },
    );
    const internals = library as unknown as {
      resolveMediaUrl: (
        user: { eName: string },
        streamId: string,
        options?: { priority?: string },
      ) => Promise<string>;
    };
    const warm = vi
      .spyOn(internals, 'resolveMediaUrl')
      .mockResolvedValue('https://media.example/retained-call-part-1.mp4');

    const result = await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', onSnapshot: () => undefined },
    );
    const card = result.items.find((item) => item.id === 'call:@group.w3id/retained-call');
    const warmedStream = warm.mock.calls[0]?.[1];
    const saved = await store.getByOwner('@person.w3id');

    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm.mock.calls[0]?.[0]).toEqual({ eName: '@person.w3id' });
    expect(warm.mock.calls[0]?.[2]).toEqual({ priority: 'warmup' });
    expect(card?.streamIds).toHaveLength(2);
    expect(verifyMeshengerVideoStreamId(warmedStream ?? '', secret)).toMatchObject({
      fileUri: firstSegment,
      accessScope: 'shared',
      sourceSpaceKey: '@group.w3id',
      sourceGroupManifestId: 'current-group-manifest',
      sourceCallSessionId: 'group-call-1',
      sourceCallSessionVault: '@group.w3id',
      sourceRecordingVault: '@media.w3id',
      sourceChatKind: 'group',
      accessBasis: 'history',
    });
    expect(JSON.stringify(card)).not.toContain('https://media.example');
    expect(saved?.status).toBe('complete');
    expect(saved?.ledger.drainFinished).toBe(true);
    expect(saved?.ledger.queue).toEqual([]);
    expect(saved?.ledger.callMediaPrewarmVersion).toBe(1);

    await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', onSnapshot: () => undefined },
    );
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('keeps matching shared-call warmup retry state across pumps and collapses stale duplicates', async () => {
    let now = 1_000;
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://person-vault.example',
    });
    const firstSegment = 'w3ds://file?id=@media.w3id/retry-retained-call-part-1';
    const recordKey = 'call:@group.w3id/retry-retained-call';
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: { ...completeInventory },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        drainFinished: true,
        queue: [],
        found: [
          {
            key: recordKey,
            fileUris: [firstSegment],
            kind: 'call-recording',
            title: 'Retry retained recording',
            accessScope: 'shared',
            sourceId: 'call-recording',
            sourceSpaceKey: '@group.w3id',
            sourceGroupManifestId: 'current-group-manifest',
            sourceChatId: 'group-chat',
            sourceCallSessionId: 'group-call-1',
            sourceCallSessionVault: '@group.w3id',
            sourceRecordingVault: '@media.w3id',
            sourceChatKind: 'group',
            accessBasis: 'history',
          },
        ],
      },
    });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store, now: () => now },
    );
    // Seed a real, signed durable work item so the test covers the exact
    // context identity used by production queue restoration.
    await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', drain: false, onSnapshot: () => undefined },
    );
    const seeded = await store.getByOwner('@person.w3id');
    const seededWork = Array.isArray(seeded?.ledger.queue)
      ? seeded.ledger.queue.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'prewarm-call-media',
        )
      : undefined;
    if (!seeded || !seededWork || typeof seededWork !== 'object') {
      throw new Error('Expected a retained shared-call prewarm task');
    }
    const currentWork: Record<string, unknown> = {
      ...(seededWork as Record<string, unknown>),
      attempts: 1,
      notBefore: now,
    };
    const staleWork: Record<string, unknown> = {
      ...currentWork,
      attempts: 0,
      streamGrant: {
        ...(currentWork.streamGrant as Record<string, unknown>),
        sourceGroupManifestId: 'stale-group-manifest',
      },
    };
    await store.saveJob({
      ...seeded,
      status: 'running',
      ledger: {
        ...seeded.ledger,
        drainFinished: false,
        queue: [staleWork, currentWork],
      },
    });
    await store.replaceOpenTasks(seeded.id, []);
    const internals = library as unknown as {
      resolveMediaUrl: () => Promise<string>;
    };
    const warm = vi
      .spyOn(internals, 'resolveMediaUrl')
      .mockRejectedValue(
        new MeshengerVideoLibraryError('temporary eVault failure', 'remote_unavailable', 503),
      );

    await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', maxWaves: 1, onSnapshot: () => undefined },
    );
    const afterFirstPump = await store.getByOwner('@person.w3id');
    const firstQueue = Array.isArray(afterFirstPump?.ledger.queue)
      ? afterFirstPump.ledger.queue
      : [];
    const firstPrewarms = firstQueue.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { type?: unknown }).type === 'prewarm-call-media',
    ) as Array<Record<string, unknown>>;

    expect(firstPrewarms).toHaveLength(1);
    expect(firstPrewarms[0]).toMatchObject({ recordKey, attempts: 2 });
    expect(firstPrewarms[0]?.streamGrant).toMatchObject({
      sourceGroupManifestId: 'current-group-manifest',
    });
    now = Number(firstPrewarms[0]?.notBefore);

    await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', maxWaves: 1, onSnapshot: () => undefined },
    );
    const afterSecondPump = await store.getByOwner('@person.w3id');
    const secondPrewarm = Array.isArray(afterSecondPump?.ledger.queue)
      ? (afterSecondPump.ledger.queue.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { recordKey?: unknown }).recordKey === recordKey,
        ) as Record<string, unknown> | undefined)
      : undefined;

    expect(secondPrewarm).toMatchObject({ attempts: 3 });
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it('settles an exhausted retained shared-call warmup instead of reviving it on the next pump', async () => {
    const now = 1_000;
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://person-vault.example',
    });
    const firstSegment = 'w3ds://file?id=@media.w3id/exhausted-retained-call-part-1';
    const recordKey = 'call:@group.w3id/exhausted-retained-call';
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: { ...completeInventory },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        drainFinished: true,
        queue: [],
        found: [
          {
            key: recordKey,
            fileUris: [firstSegment],
            kind: 'call-recording',
            title: 'Exhausted retained recording',
            accessScope: 'shared',
            sourceId: 'call-recording',
            sourceSpaceKey: '@group.w3id',
            sourceGroupManifestId: 'current-group-manifest',
            sourceChatId: 'group-chat',
            sourceCallSessionId: 'group-call-1',
            sourceCallSessionVault: '@group.w3id',
            sourceRecordingVault: '@media.w3id',
            sourceChatKind: 'group',
            accessBasis: 'history',
          },
        ],
      },
    });
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
      },
      { jobStore: store, now: () => now },
    );
    await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', drain: false, onSnapshot: () => undefined },
    );
    const seeded = await store.getByOwner('@person.w3id');
    const seededWork = Array.isArray(seeded?.ledger.queue)
      ? seeded.ledger.queue.find(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'prewarm-call-media',
        )
      : undefined;
    if (!seeded || !seededWork || typeof seededWork !== 'object') {
      throw new Error('Expected a retained shared-call prewarm task');
    }
    const exhaustedWork: Record<string, unknown> = {
      ...(seededWork as Record<string, unknown>),
      attempts: 3,
      notBefore: now,
    };
    const waitingWork: Record<string, unknown> = {
      ...exhaustedWork,
      recordKey: 'call:@group.w3id/waiting-retained-call',
      fileUri: 'w3ds://file?id=@media.w3id/waiting-retained-call-part-1',
      streamGrant: {
        ...(exhaustedWork.streamGrant as Record<string, unknown>),
        fileUri: 'w3ds://file?id=@media.w3id/waiting-retained-call-part-1',
        sourceCallSessionId: 'group-call-waiting',
      },
      attempts: 0,
      notBefore: now + 10_000,
    };
    await store.saveJob({
      ...seeded,
      status: 'running',
      ledger: {
        ...seeded.ledger,
        drainFinished: false,
        queue: [exhaustedWork, waitingWork],
      },
    });
    await store.replaceOpenTasks(seeded.id, []);
    const internals = library as unknown as {
      resolveMediaUrl: () => Promise<string>;
    };
    const warm = vi
      .spyOn(internals, 'resolveMediaUrl')
      .mockRejectedValue(
        new MeshengerVideoLibraryError('temporary eVault failure', 'remote_unavailable', 503),
      );

    await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', maxWaves: 1, onSnapshot: () => undefined },
    );
    const afterTerminal = await store.getByOwner('@person.w3id');

    expect(afterTerminal?.ledger.callMediaPrewarmVersion).toBeUndefined();
    expect(afterTerminal?.ledger.settledCallMediaPrewarms).toEqual(
      expect.arrayContaining([[recordKey, expect.any(String)]]),
    );

    await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', maxWaves: 1, onSnapshot: () => undefined },
    );
    const afterResume = await store.getByOwner('@person.w3id');
    const resumedPrewarms = Array.isArray(afterResume?.ledger.queue)
      ? afterResume.ledger.queue.filter(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'prewarm-call-media',
        )
      : [];

    expect(resumedPrewarms).toHaveLength(1);
    expect(resumedPrewarms[0]).toMatchObject({
      recordKey: 'call:@group.w3id/waiting-retained-call',
    });
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('removes optional retained shared-call warmups without removing the recording card', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://person-vault.example',
    });
    const firstSegment = 'w3ds://file?id=@media.w3id/pressure-mode-call-part-1';
    const recordKey = 'call:@group.w3id/pressure-mode-call';
    const prewarm = {
      type: 'prewarm-call-media',
      recordKey,
      fileUri: firstSegment,
      attempts: 0,
      notBefore: 0,
    };
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: { ...completeInventory },
      ledger: {
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
        drainFinished: true,
        queue: [prewarm],
        found: [
          {
            key: recordKey,
            fileUris: [firstSegment],
            kind: 'call-recording',
            title: 'Retained recording remains visible',
            accessScope: 'shared',
            sourceId: 'call-recording',
            sourceSpaceKey: '@group.w3id',
            sourceGroupManifestId: 'current-group-manifest',
            sourceChatId: 'group-chat',
            sourceCallSessionId: 'group-call-1',
            sourceCallSessionVault: '@group.w3id',
            sourceRecordingVault: '@media.w3id',
            sourceChatKind: 'group',
            accessBasis: 'history',
          },
        ],
      },
    });
    await store.enqueueTask({
      jobId: job.id,
      taskKey: 'prewarm:pressure-mode-call',
      kind: 'prewarm-call-media',
      vaultKey: '@group.w3id',
      cursorAfter: null,
      attempts: 0,
      notBefore: 0,
      priority: 0,
      payload: prewarm,
    });
    const syncOpenTasks = vi.spyOn(store, 'syncOpenTasks');
    const library = createMeshengerVideoLibrary(
      {
        W3DS_AUTH_PLATFORM_NAME: 'vidak',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example',
        W3DS_AUTH_JWT_SECRET: secret,
        VIDAK_SHARED_MEDIA_PREWARM_ENABLED: 'false',
      },
      { jobStore: store },
    );

    const result = await library.scanLibrary(
      { eName: '@person.w3id', eVaultUri: 'https://person-vault.example' },
      { scope: 'shared', drain: false, onSnapshot: () => undefined },
    );
    const saved = await store.getByOwner('@person.w3id');
    const openTasks = await store.loadOpenTasks(job.id);

    expect(result.items.map((item) => item.id)).toContain(recordKey);
    expect(saved?.status).toBe('complete');
    expect(saved?.ledger.drainFinished).toBe(true);
    expect(saved?.ledger.queue).toEqual([]);
    expect(openTasks).toEqual([]);
    expect(syncOpenTasks).toHaveBeenCalledWith(
      job.id,
      [expect.objectContaining({ kind: 'prewarm-call-media' })],
      [],
    );
  });
});
