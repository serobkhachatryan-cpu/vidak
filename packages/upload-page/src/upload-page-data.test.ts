import { MockVideoApiClient } from '@w3ds/api-client';
import type { CreateVideoDraftInput, DraftMediaAsset, Video, VideoId } from '@w3ds/types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCreateDraftInput,
  DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE,
  DRAFT_SAVE_FAILED_MESSAGE,
  DraftUploadError,
  gateDraftCreateForUpload,
  isDraftUploadError,
} from './draft-before-upload';
import { resolveVideoContentType } from './resolve-video-content-type';
import { emptyUploadDraft } from './upload-page';

/**
 * Mirrors UploadPageData's draft→media orchestration without mounting React:
 * never call media upload until a durable draft ID exists; single-flight create.
 */
async function persistDraftThenUploadMedia(options: {
  client: {
    createDraft: (input: CreateVideoDraftInput) => Promise<Video>;
    uploadDraftMedia: (
      videoId: VideoId,
      file: {
        name: string;
        size: number;
        type: string;
        body: Blob;
      },
    ) => Promise<DraftMediaAsset>;
  };
  file: { name: string; size: number; type: string; body: Blob };
  draftTitle?: string;
  existingDraftId?: VideoId;
}): Promise<{ videoId: VideoId; asset: DraftMediaAsset; createCalls: number; mediaCalls: number }> {
  let draftId = options.existingDraftId;
  let createCalls = 0;
  let mediaCalls = 0;
  let createInFlight: Promise<VideoId> | undefined;

  const ensureSavedDraft = async (): Promise<VideoId> => {
    if (draftId) return draftId;
    if (createInFlight) return createInFlight;

    const gate = gateDraftCreateForUpload({
      fileName: options.file.name,
      draftTitle: options.draftTitle ?? '',
    });
    if (!gate.ok) {
      throw new DraftUploadError('draft_required', DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE);
    }

    createInFlight = (async () => {
      createCalls += 1;
      try {
        const video = await options.client.createDraft(
          buildCreateDraftInput(gate.title, emptyUploadDraft()),
        );
        draftId = video.id;
        return video.id;
      } catch (cause) {
        if (isDraftUploadError(cause)) throw cause;
        throw new DraftUploadError('draft_save_failed', DRAFT_SAVE_FAILED_MESSAGE, { cause });
      } finally {
        createInFlight = undefined;
      }
    })();

    return createInFlight;
  };

  const videoId = await ensureSavedDraft();
  mediaCalls += 1;
  const asset = await options.client.uploadDraftMedia(videoId, {
    name: options.file.name,
    size: options.file.size,
    type: options.file.type,
    body: options.file.body,
  });
  return { videoId, asset, createCalls, mediaCalls };
}

describe('creator upload draft→media lifecycle', () => {
  it('resolves allowlisted content types for extension-only files', () => {
    expect(resolveVideoContentType({ name: 'talk.mp4', type: '' })).toBe('video/mp4');
    expect(resolveVideoContentType({ name: 'talk.webm', type: '' })).toBe('video/webm');
    expect(resolveVideoContentType({ name: 'talk.mov', type: '' })).toBe('video/quicktime');
  });

  it('persists a draft once before media upload and supports remove + content path', async () => {
    const client = new MockVideoApiClient({ delayMs: 0 });
    const body = new Blob(['bytes'], { type: 'video/mp4' });
    const result = await persistDraftThenUploadMedia({
      client,
      file: {
        name: 'clip.mp4',
        size: body.size,
        type: resolveVideoContentType({ name: 'clip.mp4', type: 'video/mp4' }),
        body,
      },
    });

    expect(result.createCalls).toBe(1);
    expect(result.mediaCalls).toBe(1);
    expect(result.asset.videoId).toBe(result.videoId);
    expect(result.asset.uploadState).toBe('ready');
    expect(client.draftMediaContentPath(result.videoId, result.asset.id)).toMatch(
      /^\/api\/videos\/drafts\/.+\/media\/.+\/content$/,
    );

    await client.deleteDraftMedia(result.videoId, result.asset.id);
    await expect(client.getDraftMedia(result.videoId, result.asset.id)).rejects.toThrow(
      /was not found/i,
    );
  });

  it('never calls media upload when draft create fails', async () => {
    const uploadDraftMedia = vi.fn();
    const client = {
      createDraft: vi.fn(async () => {
        throw new Error('invalid_session');
      }),
      uploadDraftMedia,
    };

    const body = new Blob(['bytes'], { type: 'video/mp4' });
    await expect(
      persistDraftThenUploadMedia({
        client,
        file: { name: 'clip.mp4', size: body.size, type: 'video/mp4', body },
      }),
    ).rejects.toMatchObject({
      kind: 'draft_save_failed',
      message: DRAFT_SAVE_FAILED_MESSAGE,
    });
    expect(uploadDraftMedia).not.toHaveBeenCalled();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent draft creation before media upload', async () => {
    let createStarts = 0;
    let releaseCreate!: (video: Video) => void;
    const createGate = new Promise<Video>((resolve) => {
      releaseCreate = resolve;
    });

    const createDraft = vi.fn(async (_input: CreateVideoDraftInput) => {
      createStarts += 1;
      return createGate;
    });

    let draftId: VideoId | undefined;
    let createInFlight: Promise<VideoId> | undefined;
    let createCalls = 0;
    const ensure = () => {
      if (draftId) return Promise.resolve(draftId);
      if (createInFlight) return createInFlight;
      createInFlight = (async () => {
        createCalls += 1;
        const video = await createDraft(buildCreateDraftInput('Clip', emptyUploadDraft()));
        draftId = video.id;
        return video.id;
      })().finally(() => {
        createInFlight = undefined;
      });
      return createInFlight;
    };

    const first = ensure();
    const second = ensure();
    releaseCreate({
      id: 'draft-shared',
      channelId: 'channel-1',
      title: 'Clip',
      description: '',
      thumbnailUrl: '',
      durationSeconds: 0,
      status: 'draft',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: [],
    });

    await expect(Promise.all([first, second])).resolves.toEqual(['draft-shared', 'draft-shared']);
    expect(createCalls).toBe(1);
    expect(createStarts).toBe(1);
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it('skips createDraft when a durable draft ID already exists', async () => {
    const client = new MockVideoApiClient({ delayMs: 0 });
    const existing = await client.createDraft({ title: 'Existing' });
    const createSpy = vi.spyOn(client, 'createDraft');
    const body = new Blob(['bytes'], { type: 'video/mp4' });

    const result = await persistDraftThenUploadMedia({
      client,
      existingDraftId: existing.id,
      file: { name: 'clip.mp4', size: body.size, type: 'video/mp4', body },
    });

    expect(createSpy).not.toHaveBeenCalled();
    expect(result.createCalls).toBe(0);
    expect(result.videoId).toBe(existing.id);
    expect(result.asset.videoId).toBe(existing.id);
  });

  it('surfaces draft_required when create fields are incomplete (no media call)', async () => {
    const uploadDraftMedia = vi.fn();
    await expect(
      persistDraftThenUploadMedia({
        client: {
          createDraft: vi.fn(),
          uploadDraftMedia,
        },
        file: { name: '', size: 1, type: 'video/mp4', body: new Blob(['x']) },
        draftTitle: '',
      }),
    ).rejects.toMatchObject({ kind: 'draft_required' });
    expect(uploadDraftMedia).not.toHaveBeenCalled();
  });
});
