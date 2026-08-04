import { describe, expect, it } from 'vitest';
import { isPublicVideoId, publicMediaContentPath, publicVideoWatchPath } from './public-media-path';

describe('public media path helpers', () => {
  it('builds watch and media paths from opaque public ids only', () => {
    expect(publicVideoWatchPath('pub_abc')).toBe('/watch/pub_abc');
    expect(publicVideoWatchPath('pub/a')).toBe('/watch/pub%2Fa');
    expect(publicMediaContentPath('pub_abc', 'asset-1')).toBe(
      '/api/videos/public/pub_abc/media/asset-1/content',
    );
    expect(publicMediaContentPath('pub_abc', 'asset/1')).toBe(
      '/api/videos/public/pub_abc/media/asset%2F1/content',
    );
    expect(publicMediaContentPath('pub_abc', 'asset-1')).not.toMatch(/storageKey|drafts\//);
    expect(isPublicVideoId('pub_abc')).toBe(true);
    expect(isPublicVideoId('video-draft-1')).toBe(false);
  });
});
