import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  accessScopeForViewer,
  type DiscoveredVideoRecord,
  dedupeDiscoveredVideos,
  discoverCallRecordingVideos,
  discoverFileRecordVideos,
  discoverVideoMessageVideos,
  discoverW3dsFileVideos,
  documentedRecordOwnerEName,
  isAuthorizedCallParticipant,
  orderedRecordingFileUris,
} from './adapters';

const owner = '@owner.w3id';
const viewer = '@viewer.w3id';
const fileUri = 'w3ds://file?id=@owner.w3id/clip-1';

describe('video space adapters', () => {
  it('prefers a complete call recording over its segment fallbacks', () => {
    expect(
      orderedRecordingFileUris({
        mediaUri: 'w3ds://file?id=@owner.w3id/full-call',
        mediaSegments: [
          'w3ds://file?id=@owner.w3id/full-call-1',
          'w3ds://file?id=@owner.w3id/full-call-2',
        ],
      }),
    ).toEqual(['w3ds://file?id=@owner.w3id/full-call']);
  });

  it('uses de-duplicated segments only when no complete call recording exists', () => {
    expect(
      orderedRecordingFileUris({
        mediaSegments: [
          'w3ds://file?id=@owner.w3id/part-1',
          'w3ds://file?id=@owner.w3id/part-1',
          'w3ds://file?id=@owner.w3id/part-2',
        ],
      }),
    ).toEqual(['w3ds://file?id=@owner.w3id/part-1', 'w3ds://file?id=@owner.w3id/part-2']);
  });

  it('keeps every legacy segment when mediaUri only aliases the first one', () => {
    expect(
      orderedRecordingFileUris({
        // Older Meshenger writers intentionally used the first segment as the
        // legacy `mediaUri`; it is not a separate full-length file.
        mediaUri: 'w3ds://file?id=@owner.w3id/part-1',
        mediaSegments: [
          'w3ds://file?id=@owner.w3id/part-1',
          'w3ds://file?id=@owner.w3id/part-2',
          'w3ds://file?id=@owner.w3id/part-3',
        ],
      }),
    ).toEqual([
      'w3ds://file?id=@owner.w3id/part-1',
      'w3ds://file?id=@owner.w3id/part-2',
      'w3ds://file?id=@owner.w3id/part-3',
    ]);
  });

  it('surfaces an owned eVault video as a personal file', () => {
    const referenced = new Set<string>();
    expect(
      discoverW3dsFileVideos(
        owner,
        [
          {
            id: 'clip-1',
            ontology: 'w3ds-file-v1',
            parsed: { contentType: 'video/mp4', filename: 'Studio take.mp4' },
          },
        ],
        referenced,
        owner,
      ),
    ).toEqual([
      expect.objectContaining({
        sourceId: 'w3ds-file',
        kind: 'file',
        title: 'Studio Take',
        accessScope: 'personal',
        fileUris: [fileUri],
      }),
    ]);
  });

  it('surfaces an authorized shared file record', () => {
    expect(
      discoverFileRecordVideos(
        '@friend.w3id',
        [
          {
            id: 'shared-1',
            ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            parsed: {
              mimeType: 'video/webm',
              name: 'Shared clip.webm',
              uri: 'w3ds://file?id=@friend.w3id/shared-1',
            },
          },
        ],
        new Set(),
        viewer,
      ),
    ).toEqual([
      expect.objectContaining({
        sourceId: 'file-record',
        accessScope: 'shared',
        title: 'Shared Clip',
      }),
    ]);
  });

  it('retains the authorized chat context when a Message omits a duplicate chatId', () => {
    expect(
      discoverVideoMessageVideos(
        [
          {
            id: 'message-without-chat-id',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'video',
              fileId: fileUri,
              file: { filename: 'Shared cut.mp4' },
              senderEName: owner,
            },
          },
        ],
        new Set(),
        viewer,
        owner,
        'authorized-chat',
      ),
    ).toEqual([
      expect.objectContaining({
        accessScope: 'shared',
        accessBasis: 'history',
        sourceChatId: 'authorized-chat',
      }),
    ]);
  });

  it('carries a verified current GroupManifest id only through shared group records', () => {
    const groupEName = '@group.w3id';
    const sourceGroupManifestId = 'current-group-manifest';
    const calls = discoverCallRecordingVideos({
      viewerEName: viewer,
      sourceEName: groupEName,
      sourceChatKind: 'group',
      sourceGroupManifestId,
      referenced: new Set(),
      calls: [
        {
          id: 'group-call',
          ontology: 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd',
          parsed: {
            participants: [viewer, owner],
            chatId: 'group-chat',
            recording: { mediaIsVideo: true, mediaUri: fileUri, recordingVault: owner },
          },
        },
      ],
    });
    const messages = discoverVideoMessageVideos(
      [
        {
          id: 'group-message',
          ontology: '550e8400-e29b-41d4-a716-446655440004',
          parsed: {
            type: 'video',
            fileId: fileUri,
            senderEName: owner,
          },
        },
      ],
      new Set(),
      viewer,
      groupEName,
      'group-chat',
      undefined,
      undefined,
      sourceGroupManifestId,
    );

    expect(calls).toEqual([
      expect.objectContaining({
        sourceChatKind: 'group',
        sourceGroupManifestId,
      }),
    ]);
    expect(messages).toEqual([
      expect.objectContaining({
        sourceChatKind: 'group',
        sourceGroupManifestId,
      }),
    ]);

    const personalMessage = discoverVideoMessageVideos(
      [
        {
          id: 'personal-message',
          ontology: '550e8400-e29b-41d4-a716-446655440004',
          parsed: {
            type: 'video',
            fileId: 'w3ds://file?id=@viewer.w3id/personal-clip',
            senderEName: viewer,
          },
        },
      ],
      new Set(),
      viewer,
      groupEName,
      'group-chat',
      undefined,
      undefined,
      sourceGroupManifestId,
    );
    expect(personalMessage[0]).not.toHaveProperty('sourceGroupManifestId');
  });

  it('prefers the Messages-by-Chat context over a conflicting legacy payload chat id', () => {
    expect(
      discoverVideoMessageVideos(
        [
          {
            id: 'message-with-conflicting-chat-id',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'video',
              chatId: 'legacy-alias-chat',
              fileId: fileUri,
              senderEName: owner,
            },
          },
        ],
        new Set(),
        viewer,
        owner,
        'authorized-chat',
        'viewer-chat-grant',
        new Map([['legacy-alias-chat', 'wrong-chat-grant']]),
      ),
    ).toEqual([
      expect.objectContaining({
        sourceChatId: 'authorized-chat',
        sourceViewerChatGrantId: 'viewer-chat-grant',
      }),
    ]);
  });

  it('carries an exact current viewer Chat grant only for the matching direct conversation', () => {
    const grants = new Map([['authorized-chat', 'viewer-chat-grant']]);
    const messages = discoverVideoMessageVideos(
      [
        {
          id: 'direct-message',
          ontology: '550e8400-e29b-41d4-a716-446655440004',
          parsed: {
            type: 'video',
            chatId: 'authorized-chat',
            fileId: fileUri,
            senderEName: owner,
          },
        },
        {
          id: 'other-message',
          ontology: '550e8400-e29b-41d4-a716-446655440004',
          parsed: {
            type: 'video',
            chatId: 'other-chat',
            fileId: 'w3ds://file?id=@owner.w3id/other-clip',
            senderEName: owner,
          },
        },
      ],
      new Set(),
      viewer,
      owner,
      undefined,
      undefined,
      grants,
    );

    expect(messages.find((item) => item.key.startsWith('message:direct-message'))).toMatchObject({
      sourceChatId: 'authorized-chat',
      sourceViewerChatGrantId: 'viewer-chat-grant',
    });
    expect(
      messages.find((item) => item.key.startsWith('message:other-message')),
    ).not.toHaveProperty('sourceViewerChatGrantId');

    const calls = discoverCallRecordingVideos({
      viewerEName: viewer,
      sourceEName: owner,
      referenced: new Set(),
      sourceViewerChatGrantIds: grants,
      sourceChatKind: 'direct',
      calls: [
        {
          id: 'direct-call-session',
          ontology: 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd',
          parsed: {
            participants: [viewer, owner],
            chatId: 'authorized-chat',
            recording: { mediaIsVideo: true, mediaUri: fileUri, recordingVault: owner },
          },
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'direct-call-session',
      sourceCallSessionVault: owner,
      sourceRecordingVault: owner,
      sourceChatKind: 'direct',
    });
  });

  it('uses the canonical target for a shared File reference without leaving it untitled', () => {
    const referenced = new Set<string>();
    expect(
      discoverFileRecordVideos(
        viewer,
        [
          {
            id: 'local-reference',
            ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            parsed: {
              isReference: true,
              canonicalOwnerEName: '@friend.w3id',
              canonicalFileId: 'canonical-clip',
            },
          },
        ],
        referenced,
        viewer,
      ),
    ).toEqual([
      expect.objectContaining({
        title: 'Shared video',
        accessScope: 'shared',
        fileUris: ['w3ds://file?id=@friend.w3id/canonical-clip'],
        sourceSpaceKey: '@friend.w3id',
        sourceReferenceId: 'local-reference',
        sourceReferenceFileId: 'canonical-clip',
        accessBasis: 'reference',
      }),
    ]);
    expect(referenced.has('w3ds://file?id=@friend.w3id/canonical-clip')).toBe(false);
  });

  it('keeps a viewer-owned File reference when the matching Message was discovered first', () => {
    const referenced = new Set<string>();
    const messages = discoverVideoMessageVideos(
      [
        {
          id: 'message-before-reference',
          ontology: '550e8400-e29b-41d4-a716-446655440004',
          parsed: {
            type: 'video',
            chatId: 'direct-chat',
            fileId: fileUri,
            file: { filename: 'Shared clip.mp4' },
            senderEName: owner,
          },
        },
      ],
      referenced,
      viewer,
      owner,
      'direct-chat',
    );
    expect(referenced.has(fileUri)).toBe(true);

    const localReference = discoverFileRecordVideos(
      viewer,
      [
        {
          id: 'local-reference-after-message',
          ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          parsed: {
            isReference: true,
            canonicalOwnerEName: owner,
            canonicalFileId: 'clip-1',
          },
        },
      ],
      referenced,
      viewer,
    );

    expect(localReference).toEqual([
      expect.objectContaining({
        accessScope: 'shared',
        accessBasis: 'reference',
        sourceSpaceKey: owner,
        sourceReferenceId: 'local-reference-after-message',
        sourceReferenceFileId: 'clip-1',
      }),
    ]);
    expect(dedupeDiscoveredVideos([...messages, ...localReference])).toEqual([
      expect.objectContaining({
        key: `message:message-before-reference:${fileUri}`,
        accessBasis: 'reference',
        sourceSpaceKey: owner,
        sourceReferenceId: 'local-reference-after-message',
        sourceReferenceFileId: 'clip-1',
      }),
    ]);
  });

  it('keeps a CallSession on its resolved canonical vault when media lives elsewhere', () => {
    const calls = discoverCallRecordingVideos({
      viewerEName: viewer,
      sourceEName: owner,
      referenced: new Set(),
      sourceViewerChatGrantIds: new Map([['authorized-chat', 'viewer-chat-grant']]),
      sourceChatKind: 'direct',
      calls: [
        {
          id: 'canonical-call-session',
          ontology: 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd',
          sourceCallSessionVault: '@chat-owner.w3id',
          parsed: {
            participants: [viewer, owner],
            chatId: 'authorized-chat',
            recording: {
              mediaIsVideo: true,
              mediaUri: fileUri,
              recordingVault: '@recording-media.w3id',
            },
          },
        },
      ],
    });

    expect(calls).toEqual([
      expect.objectContaining({
        sourceCallSessionId: 'canonical-call-session',
        sourceCallSessionVault: '@chat-owner.w3id',
        sourceRecordingVault: '@recording-media.w3id',
      }),
    ]);
  });

  it('never returns a call recording the viewer did not join', () => {
    const payload = {
      participants: [owner],
      initiator: owner,
      recording: {
        mediaIsVideo: true,
        mediaUri: fileUri,
      },
    };
    expect(isAuthorizedCallParticipant(payload, viewer)).toBe(false);
    expect(
      discoverCallRecordingVideos({
        viewerEName: viewer,
        sourceEName: owner,
        referenced: new Set(),
        calls: [
          { id: 'call-1', ontology: 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd', parsed: payload },
        ],
      }),
    ).toEqual([]);
  });

  it('collapses duplicate bindings of the same file into one card', () => {
    const referenced = new Set<string>();
    const fromFile = discoverW3dsFileVideos(
      owner,
      [
        {
          id: 'clip-1',
          ontology: 'w3ds-file-v1',
          parsed: { contentType: 'video/mp4', filename: 'Same clip.mp4' },
        },
      ],
      referenced,
      owner,
    );
    const fromMessage = discoverVideoMessageVideos(
      [
        {
          id: 'message-1',
          ontology: '550e8400-e29b-41d4-a716-446655440004',
          parsed: {
            type: 'video',
            fileId: fileUri,
            file: { filename: 'Same clip.mp4' },
            senderEName: owner,
          },
        },
      ],
      new Set(),
      owner,
    );
    const merged = dedupeDiscoveredVideos([...fromFile, ...fromMessage]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe('video-message');
    expect(merged[0]?.fileUris).toEqual([fileUri]);
  });

  it('keeps a meaningful title when a generic higher-ranked binding points at the same file', () => {
    const genericCall: DiscoveredVideoRecord = {
      key: 'call:clip-1',
      fileUris: [fileUri],
      kind: 'call-recording',
      title: 'Untitled video',
      accessScope: 'personal',
      sourceId: 'call-recording',
    };
    const labelledMessage: DiscoveredVideoRecord = {
      key: 'message:clip-1',
      fileUris: [fileUri],
      kind: 'video-message',
      title: 'Weekend picnic',
      accessScope: 'personal',
      sourceId: 'video-message',
    };

    expect(dedupeDiscoveredVideos([genericCall, labelledMessage])).toEqual([labelledMessage]);
  });

  it('keeps a newly discovered direct Chat-grant hint when retaining a richer legacy card', () => {
    const legacy: DiscoveredVideoRecord = {
      key: 'message:legacy-clip',
      fileUris: [fileUri],
      kind: 'video-message',
      title: 'Customer interview',
      accessScope: 'shared',
      sourceId: 'video-message',
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      accessBasis: 'history',
    };
    const rediscovered: DiscoveredVideoRecord = {
      key: 'call:legacy-clip',
      fileUris: [fileUri],
      kind: 'call-recording',
      title: 'Untitled video',
      accessScope: 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'fresh-viewer-chat-grant',
      sourceCallSessionId: 'fresh-call-session',
      sourceCallSessionVault: '@friend.w3id',
      sourceRecordingVault: '@friend.w3id',
      sourceChatKind: 'direct',
      accessBasis: 'history',
    };

    expect(dedupeDiscoveredVideos([legacy, rediscovered])).toEqual([
      {
        ...legacy,
        sourceViewerChatGrantId: 'fresh-viewer-chat-grant',
        sourceCallSessionId: 'fresh-call-session',
        sourceCallSessionVault: '@friend.w3id',
        sourceRecordingVault: '@friend.w3id',
        sourceChatKind: 'direct',
      },
    ]);
  });

  it('promotes a matching viewer-vault File reference over a legacy direct recording proof', () => {
    const directRecording: DiscoveredVideoRecord = {
      key: 'call:direct-recording',
      fileUris: [fileUri],
      kind: 'call-recording',
      title: 'Client call',
      accessScope: 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: owner,
      sourceChatId: 'direct-chat',
      sourceChatKind: 'direct',
      accessBasis: 'history',
    };
    const viewerReference: DiscoveredVideoRecord = {
      key: 'file:@viewer.w3id:local-reference',
      fileUris: [fileUri],
      kind: 'file',
      title: 'Shared video',
      accessScope: 'shared',
      sourceId: 'file-record',
      sourceSpaceKey: owner,
      sourceReferenceId: 'local-reference',
      sourceReferenceFileId: 'clip-1',
      accessBasis: 'reference',
    };

    expect(dedupeDiscoveredVideos([viewerReference, directRecording])).toEqual([
      {
        ...directRecording,
        sourceSpaceKey: owner,
        sourceReferenceId: 'local-reference',
        sourceReferenceFileId: 'clip-1',
        accessBasis: 'reference',
      },
    ]);
  });

  it('does not promote a local File reference over a known group recording', () => {
    const groupRecording: DiscoveredVideoRecord = {
      key: 'call:group-recording',
      fileUris: [fileUri],
      kind: 'call-recording',
      title: 'Group call',
      accessScope: 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: owner,
      sourceChatId: 'group-chat',
      sourceChatKind: 'group',
      accessBasis: 'history',
    };
    const viewerReference: DiscoveredVideoRecord = {
      key: 'file:@viewer.w3id:group-reference',
      fileUris: [fileUri],
      kind: 'file',
      title: 'Shared video',
      accessScope: 'shared',
      sourceId: 'file-record',
      sourceSpaceKey: owner,
      sourceReferenceId: 'group-reference',
      sourceReferenceFileId: 'clip-1',
      accessBasis: 'reference',
    };

    expect(dedupeDiscoveredVideos([viewerReference, groupRecording])).toEqual([groupRecording]);
  });

  it('never transfers a GroupManifest pointer between different group bindings', () => {
    const firstGroup: DiscoveredVideoRecord = {
      key: 'call:first-group',
      fileUris: [fileUri],
      kind: 'call-recording',
      title: 'First group call',
      accessScope: 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: '@first-group.w3id',
      sourceChatId: 'group-chat',
      sourceChatKind: 'group',
      sourceGroupManifestId: 'first-manifest',
      accessBasis: 'history',
    };
    const secondGroup: DiscoveredVideoRecord = {
      ...firstGroup,
      key: 'call:second-group',
      title: 'Second group call',
      sourceSpaceKey: '@second-group.w3id',
      sourceGroupManifestId: 'second-manifest',
    };

    expect(dedupeDiscoveredVideos([firstGroup, secondGroup])).toEqual([
      expect.not.objectContaining({ sourceGroupManifestId: expect.any(String) }),
    ]);
  });

  it('retains the latest compatible GroupManifest pointer for the same group', () => {
    const stale: DiscoveredVideoRecord = {
      key: 'call:group-recording',
      fileUris: [fileUri],
      kind: 'call-recording',
      title: 'Group recording',
      accessScope: 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: '@group.w3id',
      sourceChatId: 'group-chat',
      sourceChatKind: 'group',
      sourceGroupManifestId: 'stale-manifest',
      accessBasis: 'history',
    };
    const current: DiscoveredVideoRecord = {
      ...stale,
      sourceGroupManifestId: 'current-manifest',
    };

    expect(dedupeDiscoveredVideos([stale, current])).toEqual([current]);
  });

  it('does not promote a malformed local reference with a mismatched canonical file id', () => {
    const directRecording: DiscoveredVideoRecord = {
      key: 'call:direct-recording',
      fileUris: [fileUri],
      kind: 'call-recording',
      title: 'Client call',
      accessScope: 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: owner,
      sourceChatId: 'direct-chat',
      sourceChatKind: 'direct',
      accessBasis: 'history',
    };
    const malformedReference: DiscoveredVideoRecord = {
      key: 'file:@viewer.w3id:bad-reference',
      fileUris: [fileUri],
      kind: 'file',
      title: 'Shared video',
      accessScope: 'shared',
      sourceId: 'file-record',
      sourceSpaceKey: owner,
      sourceReferenceId: 'bad-reference',
      sourceReferenceFileId: 'a-different-file',
      accessBasis: 'reference',
    };

    expect(dedupeDiscoveredVideos([malformedReference, directRecording])).toEqual([
      directRecording,
    ]);
  });

  it('replaces a retained first-segment CallSession card with its full recording on reindex', () => {
    const legacy: DiscoveredVideoRecord = {
      key: 'call:@friend.w3id:call-1',
      fileUris: ['w3ds://file?id=@friend.w3id/part-1'],
      kind: 'call-recording',
      title: 'Call recording',
      accessScope: 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      sourceCallSessionId: 'call-1',
      sourceCallSessionVault: '@friend.w3id',
      sourceChatKind: 'direct',
      accessBasis: 'history',
    };
    const reindexed: DiscoveredVideoRecord = {
      ...legacy,
      fileUris: [
        'w3ds://file?id=@friend.w3id/part-1',
        'w3ds://file?id=@friend.w3id/part-2',
        'w3ds://file?id=@friend.w3id/part-3',
      ],
    };

    expect(dedupeDiscoveredVideos([legacy, reindexed])).toEqual([reindexed]);
  });

  it('ignores non-video blobs so they never become cards', () => {
    expect(
      discoverW3dsFileVideos(
        owner,
        [
          {
            id: 'photo-1',
            ontology: 'w3ds-file-v1',
            parsed: { contentType: 'image/jpeg', filename: 'Still.jpg' },
          },
        ],
        new Set(),
        owner,
      ),
    ).toEqual([]);
  });

  it('inventories an official Message type=file attachment with mediaUrl when authorized', () => {
    expect(
      discoverVideoMessageVideos(
        [
          {
            id: 'file-message-1',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'file',
              mediaUrl: fileUri,
              file: { name: 'Shared briefing.mp4' },
            },
          },
        ],
        new Set(),
        viewer,
      ),
    ).toEqual([
      expect.objectContaining({
        sourceId: 'video-message',
        accessScope: 'shared',
        title: 'Shared Briefing',
        fileUris: [fileUri],
      }),
    ]);
  });

  it('keeps an attachment filename when the documented file reference is nested', () => {
    expect(
      discoverVideoMessageVideos(
        [
          {
            id: 'nested-file-message',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'file',
              attachment: { fileId: 'nested-clip', name: 'Friends with hats.mp4' },
            },
          },
        ],
        new Set(),
        owner,
        owner,
      ),
    ).toEqual([
      expect.objectContaining({
        title: 'Friends With Hats',
        fileUris: ['w3ds://file?id=@owner.w3id/nested-clip'],
      }),
    ]);
  });

  it('does not inventory zip, office, or other non-video file attachments as video', () => {
    expect(
      discoverVideoMessageVideos(
        [
          {
            id: 'zip-message',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'file',
              mediaUrl: 'w3ds://file?id=@owner.w3id/archive-1',
              mimeType: 'application/zip',
              file: { name: 'clips.zip' },
            },
          },
          {
            id: 'doc-message',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'file',
              mediaUrl: 'w3ds://file?id=@owner.w3id/doc-2',
              file: { name: 'notes.docx' },
            },
          },
        ],
        new Set(),
        viewer,
      ),
    ).toEqual([]);
  });

  it('does not drop a type=file video that still needs documented metaEnvelope resolution', () => {
    expect(
      discoverVideoMessageVideos(
        [
          {
            id: 'bare-file',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'file',
              mediaUrl: fileUri,
            },
          },
        ],
        new Set(),
        viewer,
      ),
    ).toEqual([]);
  });

  it('does not inventory an official image or pdf attachment as video', () => {
    expect(
      discoverVideoMessageVideos(
        [
          {
            id: 'photo-message',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'image',
              mediaUrl: 'w3ds://file?id=@owner.w3id/photo-1',
              mimeType: 'image/jpeg',
            },
          },
          {
            id: 'pdf-message',
            ontology: '550e8400-e29b-41d4-a716-446655440004',
            parsed: {
              type: 'file',
              mediaUrl: 'w3ds://file?id=@owner.w3id/doc-1',
              mimeType: 'application/pdf',
            },
          },
        ],
        new Set(),
        viewer,
      ),
    ).toEqual([]);
  });

  it('does not label a foreign canonical file as personal when its binding claims the viewer owns it', () => {
    expect(documentedRecordOwnerEName({ senderEName: owner }, [fileUri])).toBe(owner);
    expect(documentedRecordOwnerEName({ ownerId: owner }, [])).toBe(owner);
    expect(documentedRecordOwnerEName({ subject: owner }, [])).toBe(owner);
    expect(documentedRecordOwnerEName({}, [fileUri])).toBe(owner);
    expect(accessScopeForViewer(owner, owner)).toBe('personal');
    expect(accessScopeForViewer(viewer, owner)).toBe('shared');
    expect(accessScopeForViewer(viewer, undefined)).toBe('shared');

    const ownMessageInGroup = discoverVideoMessageVideos(
      [
        {
          id: 'mine-in-group',
          ontology: '550e8400-e29b-41d4-a716-446655440004',
          parsed: {
            type: 'video',
            fileId: 'w3ds://file?id=@group.w3id/clip-9',
            file: { filename: 'My group clip.mp4' },
            senderEName: viewer,
          },
        },
      ],
      new Set(),
      viewer,
      '@group.w3id',
    );
    expect(ownMessageInGroup).toEqual([
      expect.objectContaining({
        title: 'My Group Clip',
        accessScope: 'shared',
      }),
    ]);

    const ownCallInGroup = discoverCallRecordingVideos({
      viewerEName: viewer,
      sourceEName: '@group.w3id',
      referenced: new Set(),
      calls: [
        {
          id: 'call-mine',
          ontology: 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd',
          parsed: {
            initiator: viewer,
            participants: [viewer, owner],
            recording: {
              mediaIsVideo: true,
              mediaUri: 'w3ds://file?id=@group.w3id/call-mine',
            },
          },
        },
      ],
    });
    expect(ownCallInGroup).toEqual([
      expect.objectContaining({
        accessScope: 'shared',
        kind: 'call-recording',
      }),
    ]);
  });
});
