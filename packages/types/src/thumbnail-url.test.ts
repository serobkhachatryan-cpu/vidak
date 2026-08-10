import { describe, expect, it } from 'vitest';
import {
  isEphemeralThumbnailUrl,
  isRenderableThumbnailUrl,
  normalizePersistedThumbnailUrl,
} from './thumbnail-url';

describe('thumbnail URL helpers', () => {
  it('detects ephemeral blob and data URLs', () => {
    expect(isEphemeralThumbnailUrl('blob:https://vidak.example/abc')).toBe(true);
    expect(isEphemeralThumbnailUrl('data:image/png;base64,aaa')).toBe(true);
    expect(isEphemeralThumbnailUrl('https://cdn.example/t.jpg')).toBe(false);
    expect(isEphemeralThumbnailUrl('/api/videos/public/pub_1/thumbnail')).toBe(false);
  });

  it('never persists ephemeral or invalid thumbnail URLs', () => {
    expect(normalizePersistedThumbnailUrl('blob:https://vidak.example/abc')).toBe('');
    expect(normalizePersistedThumbnailUrl('data:image/jpeg;base64,abc')).toBe('');
    expect(normalizePersistedThumbnailUrl('   ')).toBe('');
    expect(normalizePersistedThumbnailUrl('not a url')).toBe('');
    expect(normalizePersistedThumbnailUrl('https://cdn.example/t.jpg')).toBe(
      'https://cdn.example/t.jpg',
    );
    expect(normalizePersistedThumbnailUrl('/api/videos/drafts/v1/thumbnail')).toBe(
      '/api/videos/drafts/v1/thumbnail',
    );
  });

  it('only marks durable http(s) and same-origin paths as renderable', () => {
    expect(isRenderableThumbnailUrl('')).toBe(false);
    expect(isRenderableThumbnailUrl('blob:https://x/y')).toBe(false);
    expect(isRenderableThumbnailUrl('data:image/png;base64,x')).toBe(false);
    expect(isRenderableThumbnailUrl('https://cdn.example/t.jpg')).toBe(true);
    expect(isRenderableThumbnailUrl('/api/videos/public/pub_1/thumbnail')).toBe(true);
  });
});
