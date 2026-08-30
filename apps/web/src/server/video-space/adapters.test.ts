import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  dedupeDiscoveredVideos,
  discoverCallRecordingVideos,
  discoverFileRecordVideos,
  discoverVideoMessageVideos,
  discoverW3dsFileVideos,
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
        'personal',
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
        'shared',
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
      'personal',
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
          },
        },
      ],
      new Set(),
      'personal',
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
        'personal',
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
        'shared',
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
        'shared',
      ),
    ).toEqual([]);
  });
});
