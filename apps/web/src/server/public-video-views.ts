import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

/** Repeat refreshes and replays inside this window share one counted view. */
export const PUBLIC_VIEW_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

export function readViewCountPepper(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.W3DS_AUTH_JWT_SECRET?.trim();
  if (secret) return secret;
  return 'vidak-test-view-count-pepper';
}

export function hashPublicViewerKey(input: {
  pepper: string;
  publicVideoId: string;
  clientAddress: string;
  userAgent: string;
}): string {
  return createHash('sha256')
    .update('vidak-public-view\0')
    .update(input.pepper)
    .update('\0')
    .update(input.publicVideoId.trim())
    .update('\0')
    .update(normalizeViewerMaterial(input.clientAddress))
    .update('\0')
    .update(normalizeViewerMaterial(input.userAgent))
    .digest('hex');
}

export function hashedPublicViewerKeyFromRequest(
  request: NextRequest,
  publicVideoId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const clientAddress = forwarded
    ? (forwarded.split(',')[0]?.trim() ?? '')
    : (request.headers.get('x-real-ip')?.trim() ?? '');
  const userAgent = request.headers.get('user-agent') ?? '';
  return hashPublicViewerKey({
    pepper: readViewCountPepper(env),
    publicVideoId,
    clientAddress,
    userAgent,
  });
}

function normalizeViewerMaterial(value: string): string {
  return value.trim().slice(0, 512);
}
