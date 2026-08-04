import { describe, expect, it } from 'vitest';
import {
  draftMediaAssetPath,
  draftMediaContentPath,
  draftMediaUploadPath,
} from './draft-media-path';

describe('draft media path helpers', () => {
  it('builds same-origin authenticated paths without public URL hosts', () => {
    expect(draftMediaUploadPath('draft/1')).toBe('/api/videos/drafts/draft%2F1/media');
    expect(draftMediaAssetPath('draft-1', 'asset/2')).toBe(
      '/api/videos/drafts/draft-1/media/asset%2F2',
    );
    expect(draftMediaContentPath('draft-1', 'asset-1')).toBe(
      '/api/videos/drafts/draft-1/media/asset-1/content',
    );
    expect(draftMediaContentPath('draft-1', 'asset-1')).not.toMatch(/^https?:\/\//);
  });
});
