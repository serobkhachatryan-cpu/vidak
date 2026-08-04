import { MockVideoApiClient } from '@w3ds/api-client';
import { describe, expect, it } from 'vitest';
import { DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE } from './draft-before-upload';
import { resolveVideoContentType } from './resolve-video-content-type';

describe('creator upload media integration helpers', () => {
  it('resolves allowlisted content types for extension-only files', () => {
    expect(resolveVideoContentType({ name: 'talk.mp4', type: '' })).toBe('video/mp4');
    expect(resolveVideoContentType({ name: 'talk.webm', type: '' })).toBe('video/webm');
    expect(resolveVideoContentType({ name: 'talk.mov', type: '' })).toBe('video/quicktime');
  });

  it('uploads media only after a draft exists and supports remove + content path', async () => {
    const client = new MockVideoApiClient({ delayMs: 0 });
    const draft = await client.createDraft({ title: 'Saved draft' });
    const body = new Blob(['bytes'], { type: 'video/mp4' });
    const progress: number[] = [];

    const asset = await client.uploadDraftMedia(
      draft.id,
      {
        name: 'clip.mp4',
        size: body.size,
        type: resolveVideoContentType({ name: 'clip.mp4', type: 'video/mp4' }),
        body,
      },
      { onProgress: (event) => progress.push(event.percent) },
    );

    expect(asset.videoId).toBe(draft.id);
    expect(asset.uploadState).toBe('ready');
    expect(progress.at(-1)).toBe(100);
    expect(client.draftMediaContentPath(draft.id, asset.id)).toMatch(
      /^\/api\/videos\/drafts\/.+\/media\/.+\/content$/,
    );

    await client.deleteDraftMedia(draft.id, asset.id);
    await expect(client.getDraftMedia(draft.id, asset.id)).rejects.toThrow(/was not found/i);
  });

  it('surfaces an actionable error when draft persistence fails before upload', async () => {
    const createDraft = async () => {
      throw new Error('invalid_session');
    };
    await expect(createDraft()).rejects.toThrow(/invalid_session/i);
    expect(DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE).toMatch(/details were kept/i);
  });
});
