import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { resolveSigningPublicOrigin } from './route';

vi.mock('server-only', () => ({}));

describe('signed video publication offer route', () => {
  it('uses the configured public origin rather than an internal reverse-proxy listener', () => {
    const request = new NextRequest('http://localhost:3910/api/videos/video-1/publish/signing');
    expect(
      resolveSigningPublicOrigin(request, {
        trustedOrigins: ['https://vidak-production.up.railway.app'],
      }),
    ).toBe('https://vidak-production.up.railway.app');
  });
});
