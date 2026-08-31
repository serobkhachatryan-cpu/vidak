import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  accessScopeForViewer,
  dedupeDiscoveredVideos,
  discoverCallRecordingVideos,
  discoverFileRecordVideos,
  discoverVideoMessageVideos,
  discoverW3dsFileVideos,
  documentedRecordOwnerEName,
  isAuthorizedCallParticipant,
} from './adapters';

const owner = '@owner.w3id';
const viewer = '@viewer.w3id';
const fileUri = 'w3ds://file?id=@owner.w3id/clip-1';

describe('video space adapters', () => {
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
        title: 'Studio take.mp4',
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
        title: 'Shared clip.webm',
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
        title: 'Shared briefing.mp4',
        fileUris: [fileUri],
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

  it('classifies ownership from documented subject/owner, not the discovery vault', () => {
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
        title: 'My group clip.mp4',
        accessScope: 'personal',
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
        accessScope: 'personal',
        kind: 'call-recording',
      }),
    ]);
  });
});
