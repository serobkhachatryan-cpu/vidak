import { describe, expect, it } from 'vitest';
import {
  buildCreateDraftInput,
  DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE,
  DRAFT_SAVE_FAILED_MESSAGE,
  DraftUploadError,
  gateDraftCreateForUpload,
  isDraftUploadError,
  resolveDraftCreateTitle,
} from './draft-before-upload';
import { emptyUploadDraft } from './upload-page';

describe('draft-before-upload', () => {
  it('resolves create title from explicit draft title first', () => {
    expect(resolveDraftCreateTitle('clip.mp4', '  My talk  ')).toBe('My talk');
  });

  it('derives create title from the file name when draft title is empty', () => {
    expect(resolveDraftCreateTitle('my_holiday-video.mp4', '')).toBe('My Holiday Video');
  });

  it('gates create when a file name or draft title is available', () => {
    expect(gateDraftCreateForUpload({ fileName: 'clip.mp4', draftTitle: '' })).toEqual({
      ok: true,
      title: 'Clip',
    });
    expect(gateDraftCreateForUpload({ fileName: undefined, draftTitle: 'Ready' })).toEqual({
      ok: true,
      title: 'Ready',
    });
  });

  it('blocks create when required draft fields are not yet available', () => {
    expect(gateDraftCreateForUpload({ fileName: undefined, draftTitle: '' })).toEqual({
      ok: false,
      reason: 'missing_required_fields',
    });
    expect(gateDraftCreateForUpload({ fileName: '   ', draftTitle: '  ' })).toEqual({
      ok: false,
      reason: 'missing_required_fields',
    });
  });

  it('builds a sparse create-draft payload from the form snapshot', () => {
    const draft = {
      ...emptyUploadDraft(),
      title: 'Ignored by builder title arg',
      description: 'Hello',
      tags: ['a'],
      category: 'education' as const,
      language: 'en' as const,
      visibility: 'unlisted' as const,
      thumbnailUrl: 'https://example.test/t.jpg',
    };
    expect(buildCreateDraftInput('Persisted title', draft)).toEqual({
      title: 'Persisted title',
      description: 'Hello',
      tags: ['a'],
      category: 'education',
      language: 'en',
      visibility: 'unlisted',
      thumbnailUrl: 'https://example.test/t.jpg',
    });
  });

  it('omits ephemeral blob thumbnail URLs from create-draft payloads', () => {
    const draft = {
      ...emptyUploadDraft(),
      title: 'IMG 1589',
      thumbnailUrl: 'blob:https://vidak.example/abc',
    };
    expect(buildCreateDraftInput('IMG 1589', draft)).toEqual({
      title: 'IMG 1589',
      visibility: 'public',
    });
    expect(buildCreateDraftInput('IMG 1589', draft)).not.toHaveProperty('thumbnailUrl');
  });

  it('keeps draft-required and draft-save failures distinct from media failures', () => {
    const required = new DraftUploadError('draft_required', DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE);
    const saveFailed = new DraftUploadError('draft_save_failed', DRAFT_SAVE_FAILED_MESSAGE);
    expect(isDraftUploadError(required)).toBe(true);
    expect(required.kind).toBe('draft_required');
    expect(saveFailed.kind).toBe('draft_save_failed');
    expect(isDraftUploadError(new Error('network'))).toBe(false);
    expect(DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE).toMatch(/save your draft before uploading/i);
    expect(DRAFT_SAVE_FAILED_MESSAGE).toMatch(/could not save your draft/i);
  });
});
