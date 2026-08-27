import type { ImportedChannelVideo } from '@w3ds/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

function errorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return fallback;
}

export async function listImportedVideos(): Promise<readonly ImportedChannelVideo[]> {
  const response = await fetch('/api/channel-imports/videos', { credentials: 'same-origin' });
  const body = await readJson(response);
  if (!response.ok || !isRecord(body) || !Array.isArray(body.items)) {
    throw new Error(errorMessage(body, 'Could not load imported videos.'));
  }
  return body.items as unknown as readonly ImportedChannelVideo[];
}

export async function getImportedVideo(videoId: string): Promise<ImportedChannelVideo> {
  const response = await fetch(`/api/channel-imports/videos/${encodeURIComponent(videoId)}`, {
    credentials: 'same-origin',
  });
  const body = await readJson(response);
  if (!response.ok || !isRecord(body) || !isRecord(body.item)) {
    throw new Error(errorMessage(body, 'Could not load imported video.'));
  }
  return body.item as unknown as ImportedChannelVideo;
}
