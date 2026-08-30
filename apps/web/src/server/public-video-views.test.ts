import { describe, expect, it } from 'vitest';
import { hashPublicViewerKey } from './public-video-views';

describe('public viewer key hashing', () => {
  it('stores only a digest and never the raw IP, eName, or token', () => {
    const digest = hashPublicViewerKey({
      pepper: 'super-secret-pepper-value',
      publicVideoId: 'pub_1',
      clientAddress: '203.0.113.9',
      userAgent: 'Bearer secret-token @owner.w3id',
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain('203.0.113.9');
    expect(digest).not.toContain('owner.w3id');
    expect(digest).not.toContain('secret-token');
    expect(digest).not.toContain('super-secret-pepper-value');
  });

  it('changes when the viewer address changes', () => {
    const shared = {
      pepper: 'pepper',
      publicVideoId: 'pub_1',
      userAgent: 'VidakTest/1.0',
    };
    expect(hashPublicViewerKey({ ...shared, clientAddress: '203.0.113.1' })).not.toBe(
      hashPublicViewerKey({ ...shared, clientAddress: '203.0.113.2' }),
    );
  });
});
