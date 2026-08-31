import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  classifyAuthorizedMedia,
  classifyResolvedEnvelope,
  constructW3dsFileUri,
  documentedMediaFileUris,
  mergeDocumentedEnvelopeFields,
} from './media-eligibility';

const vault = '@owner.w3id';
const fileUri = 'w3ds://file?id=@owner.w3id/clip-1';

describe('documented media eligibility', () => {
  it('accepts type=file with a video filename without waiting on MIME', () => {
    expect(
      classifyAuthorizedMedia({
        payload: { type: 'file', mediaUrl: fileUri, file: { name: 'Briefing.mp4' } },
      }),
    ).toEqual({ status: 'accept', fileUri });
  });

  it('does not discard type=file without filename or MIME; it resolves via w3ds://file', () => {
    expect(
      classifyAuthorizedMedia({
        payload: { type: 'file', mediaUrl: fileUri },
        vaultOwnerEName: vault,
      }),
    ).toEqual({ status: 'resolve', fileUri });
  });

  it('constructs a documented file URI from an envelope id on the authorized vault', () => {
    expect(constructW3dsFileUri(vault, 'clip-1')).toBe(fileUri);
    expect(documentedMediaFileUris({ type: 'file', fileId: 'clip-1' }, vault)).toEqual([fileUri]);
    expect(
      classifyAuthorizedMedia({
        payload: { type: 'file', fileId: 'clip-1' },
        vaultOwnerEName: vault,
      }),
    ).toEqual({ status: 'resolve', fileUri });
  });

  it('resolves a documented mediaUrl stored on envelopes rather than parsed', () => {
    const payload = mergeDocumentedEnvelopeFields({ type: 'file' }, [
      { fieldKey: 'mediaUrl', value: fileUri, valueType: 'string' },
    ]);
    expect(payload.mediaUrl).toBe(fileUri);
    expect(classifyAuthorizedMedia({ payload, vaultOwnerEName: vault })).toEqual({
      status: 'resolve',
      fileUri,
    });
  });

  it('never treats an arbitrary HTTPS URL as playable media', () => {
    expect(
      classifyAuthorizedMedia({
        payload: {
          type: 'file',
          mediaUrl: 'https://cdn.example/video.mp4',
          file: { name: 'video.mp4' },
        },
      }),
    ).toEqual({ status: 'unresolved', reason: 'missing_w3ds_file_uri' });
  });

  it('excludes explicit non-video attachments', () => {
    expect(
      classifyAuthorizedMedia({
        payload: {
          type: 'file',
          mediaUrl: fileUri,
          mimeType: 'application/zip',
          file: { name: 'clips.zip' },
        },
      }),
    ).toEqual({ status: 'exclude', reason: 'non_video' });
  });

  it('accepts a resolved w3ds-file-v1 envelope with video contentType', () => {
    expect(
      classifyResolvedEnvelope({
        fileUri,
        ontology: 'w3ds-file-v1',
        payload: { contentType: 'video/mp4', filename: 'take.mp4' },
      }),
    ).toEqual({ status: 'accept', fileUri });
  });
});
