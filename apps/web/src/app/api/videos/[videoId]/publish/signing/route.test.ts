import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { resolvePublicOrigin } from '../../../../../../server/public-origin';

vi.mock('server-only', () => ({}));

describe('signed video publication offer route', () => {
  it('uses the configured public origin rather than an internal reverse-proxy listener', () => {
    const request = new NextRequest('http://localhost:3910/api/videos/video-1/publish/signing');
    expect(
      resolvePublicOrigin(request, {
        trustedOrigins: ['https://vidak-production.up.railway.app'],
      }),
    ).toBe('https://vidak-production.up.railway.app');
  });
});
