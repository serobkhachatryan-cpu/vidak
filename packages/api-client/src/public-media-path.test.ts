import { describe, expect, it } from 'vitest';
import {
  isPublicVideoId,
  publicMediaContentPath,
  publicPrimaryMediaPath,
  publicVideoWatchPath,
} from './public-media-path';

describe('public media path helpers', () => {
  it('builds watch and media paths from opaque public ids only', () => {
    expect(publicVideoWatchPath('pub_abc')).toBe('/watch/pub_abc');
    expect(publicVideoWatchPath('pub/a')).toBe('/watch/pub%2Fa');
    expect(publicPrimaryMediaPath('pub_abc')).toBe('/api/videos/public/pub_abc/media');
    expect(publicPrimaryMediaPath('pub/a')).toBe('/api/videos/public/pub%2Fa/media');
    expect(publicMediaContentPath('pub_abc', 'asset-1')).toBe(
      '/api/videos/public/pub_abc/media/asset-1/content',
    );
    expect(publicMediaContentPath('pub_abc', 'asset/1')).toBe(
      '/api/videos/public/pub_abc/media/asset%2F1/content',
    );
    expect(publicMediaContentPath('pub_abc', 'asset-1')).not.toMatch(/storageKey|drafts\//);
    expect(publicPrimaryMediaPath('pub_abc')).not.toMatch(/storageKey|asset-|drafts\//);
    expect(isPublicVideoId('pub_abc')).toBe(true);
    expect(isPublicVideoId('video-draft-1')).toBe(false);
  });
});
