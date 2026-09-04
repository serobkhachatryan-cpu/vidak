import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { DiscoveredVideoRecord } from './adapters';
import { assembleVideoSpaceCatalogue, type VideoSpaceStreamGrantInput } from './catalogue';
import { createInventoryCompletenessTracker } from './completeness';
import { documentedVideoSourceIds } from './documented-sources';

const personal: DiscoveredVideoRecord = {
  key: 'w3ds-file:@owner.w3id:clip-1',
  fileUris: ['w3ds://file?id=@owner.w3id/clip-1'],
  kind: 'file',
  title: 'Studio take',
  createdAt: '2026-08-02T00:00:00.000Z',
  accessScope: 'personal',
  sourceId: 'w3ds-file',
};

const shared: DiscoveredVideoRecord = {
  key: 'call:@friend.w3id:call-1',
  fileUris: ['w3ds://file?id=@friend.w3id/call-1'],
  kind: 'call-recording',
  title: 'Call recording · 2026-08-01',
  createdAt: '2026-08-01T00:00:00.000Z',
  accessScope: 'shared',
  sourceId: 'call-recording',
  sourceSpaceKey: '@friend.w3id',
  sourceChatId: 'chat-1',
  accessBasis: 'history',
};

describe('assembleVideoSpaceCatalogue', () => {
  it('documents the W3DS/Messenger sources this inventory already reads', () => {
    expect([...documentedVideoSourceIds]).toEqual([
      'w3ds-file',
      'file-record',
      'call-recording',
      'video-message',
    ]);
  });

  it('keeps indexed videos when a shared space is incomplete', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.expectSpace();
    tracker.expectSpace();
    tracker.indexSpace();
    tracker.markRetryClass('unavailable');
    const snapshot = assembleVideoSpaceCatalogue({
      records: [personal],
      completeness: tracker.snapshot(),
      viewerEName: '@owner.w3id',
      toStreamId: (grant) => `stream:${grant.fileUri}`,
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.title).toBe('Studio take');
    expect(snapshot.items[0]?.visibility).toBe('private');
    expect(snapshot.completeness.complete).toBe(false);
    expect(snapshot.completeness.retryNeeded).toBe(true);
    expect(snapshot.completeness.indexed).toBe(1);
    expect(snapshot.completeness.expected).toBe(2);
  });

  it('dedupes the same file and prefers the personal copy', () => {
    const snapshot = assembleVideoSpaceCatalogue({
      records: [{ ...shared, fileUris: personal.fileUris }, personal],
      completeness: createInventoryCompletenessTracker().snapshot(),
      viewerEName: '@owner.w3id',
      toStreamId: () => 'stream',
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.accessScope).toBe('personal');
  });

  it('mints a viewer-bound stream grant for a shared card with its verified source context', () => {
    const grants: VideoSpaceStreamGrantInput[] = [];
    const snapshot = assembleVideoSpaceCatalogue({
      records: [shared],
      completeness: createInventoryCompletenessTracker().snapshot(),
      viewerEName: '@owner.w3id',
      toStreamId: (grant) => {
        grants.push(grant);
        return 'shared-stream';
      },
    });
    expect(snapshot.items[0]?.accessScope).toBe('shared');
    expect(snapshot.items[0]?.streamIds).toEqual(['shared-stream']);
    expect(grants).toEqual([
      {
        fileUri: 'w3ds://file?id=@friend.w3id/call-1',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'chat-1',
        accessBasis: 'history',
      },
    ]);
  });

  it('mints a shared File-reference grant with only its server-side reference proof', () => {
    const grants: VideoSpaceStreamGrantInput[] = [];
    const { sourceChatId: _chat, ...sharedWithoutChat } = shared;
    const reference: DiscoveredVideoRecord = {
      ...sharedWithoutChat,
      key: 'file:@owner.w3id/local-reference',
      kind: 'file',
      sourceSpaceKey: '@friend.w3id',
      sourceReferenceId: 'local-reference',
      sourceReferenceFileId: 'canonical-file',
      accessBasis: 'reference',
    };
    const snapshot = assembleVideoSpaceCatalogue({
      records: [reference],
      completeness: createInventoryCompletenessTracker().snapshot(),
      viewerEName: '@owner.w3id',
      toStreamId: (grant) => {
        grants.push(grant);
        return 'reference-stream';
      },
    });

    expect(snapshot.items[0]?.streamIds).toEqual(['reference-stream']);
    expect(grants).toEqual([
      {
        fileUri: 'w3ds://file?id=@friend.w3id/call-1',
        accessScope: 'shared',
        sourceSpaceKey: '@friend.w3id',
        sourceReferenceId: 'local-reference',
        sourceReferenceFileId: 'canonical-file',
        accessBasis: 'reference',
      },
    ]);
  });

  it('relabels stale generic ontology titles with the verified ownership scope', () => {
    const snapshot = assembleVideoSpaceCatalogue({
      records: [{ ...personal, title: 'Video' }],
      completeness: createInventoryCompletenessTracker().snapshot(),
      viewerEName: '@owner.w3id',
      toStreamId: () => 'stream',
    });
    expect(snapshot.items[0]?.title).toBe('Private video');

    const sharedSnapshot = assembleVideoSpaceCatalogue({
      records: [{ ...shared, title: 'Untitled video' }],
      completeness: createInventoryCompletenessTracker().snapshot(),
      viewerEName: '@owner.w3id',
      toStreamId: () => 'stream',
    });
    expect(sharedSnapshot.items[0]?.title).toBe('Shared video');
  });
});
