#!/usr/bin/env node
/**
 * Read-only post-deploy production smoke test.
 *
 * It deliberately uses only anonymous GET requests and reports aggregate
 * counts. It never logs titles, identifiers, source URLs, cookies, or media
 * bytes. Run it after a successful deployment:
 *
 *   VIDAK_SMOKE_ORIGIN=https://vidak.postplatforms.com pnpm smoke:production
 */

const REQUIRED_DOCUMENT_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'referrer-policy',
];

const PRIVATE_ENDPOINTS = [
  '/api/evault/videos',
  '/api/videos/mine',
  '/api/auth/me',
  '/api/support/reports',
];

const FORBIDDEN_PUBLIC_FIELDS = new Set([
  'ownerid',
  'ownerename',
  'ename',
  'evaultid',
  'evaulturi',
  'storageid',
  'storageurl',
  'sourceurl',
]);

export class ProductionSmokeError extends Error {}

function fail(message) {
  throw new ProductionSmokeError(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function asPage(body, label) {
  const items = Array.isArray(body) ? body : body?.items;
  assert(Array.isArray(items), `${label} did not return a page of items.`);
  return {
    items,
    nextCursor:
      typeof body?.nextCursor === 'string' && body.nextCursor ? body.nextCursor : undefined,
  };
}

function hasForbiddenPublicField(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenPublicField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
    return FORBIDDEN_PUBLIC_FIELDS.has(normalized) || hasForbiddenPublicField(nested);
  });
}

function smokeUrl(origin, path) {
  const url = new URL(path, origin);
  assert(url.origin === origin.origin, 'Public content was not served from Vidak.');
  return url;
}

function usableSearchTerm(title) {
  return title.match(/[\p{L}\p{N}]{2,}/u)?.[0] ?? undefined;
}

function isPlaceholderTitle(title) {
  return /^(?:untitled video|img[ _-]?\d+|dsc[ _-]?\d+)$/i.test(title.trim());
}

async function getJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, { redirect: 'manual' });
  assert(response.ok, `${label} returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    fail(`${label} did not return JSON.`);
  }
}

async function checkPublicMedia(fetchImpl, origin, video) {
  const publicVideoId = typeof video?.publicVideoId === 'string' ? video.publicVideoId : video?.id;
  assert(
    typeof publicVideoId === 'string' && publicVideoId,
    'A public video is missing its public id.',
  );
  const title = typeof video?.title === 'string' ? video.title.trim() : '';
  assert(title && !isPlaceholderTitle(title), 'A public video has an unusable title.');
  assert(
    typeof video?.durationSeconds === 'number' &&
      Number.isFinite(video.durationSeconds) &&
      video.durationSeconds > 0,
    'A public video has an invalid duration.',
  );
  assert(
    typeof video?.thumbnailUrl === 'string' && video.thumbnailUrl,
    'A public video has no poster URL.',
  );

  const thumbnailResponse = await fetchImpl(smokeUrl(origin, video.thumbnailUrl), {
    redirect: 'manual',
  });
  assert(
    thumbnailResponse.status === 200 &&
      (thumbnailResponse.headers.get('content-type') ?? '').startsWith('image/'),
    'A public video poster is unavailable.',
  );
  await thumbnailResponse.body?.cancel().catch(() => undefined);

  const mediaPath =
    typeof video?.mediaContentUrl === 'string' && video.mediaContentUrl
      ? video.mediaContentUrl
      : `/api/videos/public/${encodeURIComponent(publicVideoId)}/media`;
  const mediaResponse = await fetchImpl(smokeUrl(origin, mediaPath), {
    headers: { Range: 'bytes=0-1' },
    redirect: 'manual',
  });
  assert(
    mediaResponse.status === 206 &&
      (mediaResponse.headers.get('content-type') ?? '').startsWith('video/') &&
      Boolean(mediaResponse.headers.get('content-range')),
    'A public video does not support range playback.',
  );
  await mediaResponse.body?.cancel().catch(() => undefined);
  return title;
}

/** Executes the read-only checks. Exported for integration tooling. */
export async function runProductionSmoke({ origin: configuredOrigin, fetchImpl = fetch } = {}) {
  assert(configuredOrigin, 'VIDAK_SMOKE_ORIGIN is required.');
  let origin;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    fail('VIDAK_SMOKE_ORIGIN must be an absolute HTTPS URL.');
  }
  assert(origin.protocol === 'https:', 'VIDAK_SMOKE_ORIGIN must use HTTPS.');

  const documentResponse = await fetchImpl(smokeUrl(origin, '/'), { redirect: 'manual' });
  assert(documentResponse.ok, `The home document returned HTTP ${documentResponse.status}.`);
  for (const header of REQUIRED_DOCUMENT_HEADERS) {
    assert(documentResponse.headers.has(header), `The home document is missing ${header}.`);
  }
  await documentResponse.body?.cancel().catch(() => undefined);

  const [live, ready, channelsBody, videosBody] = await Promise.all([
    getJson(fetchImpl, smokeUrl(origin, '/api/health/live'), 'Liveness check'),
    getJson(fetchImpl, smokeUrl(origin, '/api/health/ready'), 'Readiness check'),
    getJson(fetchImpl, smokeUrl(origin, '/api/channels/public?limit=100'), 'Public channels'),
    getJson(fetchImpl, smokeUrl(origin, '/api/videos/public?limit=100'), 'Public videos'),
  ]);
  assert(live?.status === 'ok', 'Liveness check returned an invalid status.');
  assert(ready?.status === 'ready', 'Readiness check returned an invalid status.');

  const channels = asPage(channelsBody, 'Public channels');
  const videos = asPage(videosBody, 'Public videos');
  assert(
    !hasForbiddenPublicField(channels.items),
    'Public channel data exposes a private identity field.',
  );
  assert(
    !hasForbiddenPublicField(videos.items),
    'Public video data exposes a private identity field.',
  );

  const titles = await Promise.all(
    videos.items.map((video) => checkPublicMedia(fetchImpl, origin, video)),
  );
  const searchTerm = titles.map(usableSearchTerm).find(Boolean);
  let searchChecked = false;
  if (searchTerm) {
    const search = asPage(
      await getJson(
        fetchImpl,
        smokeUrl(origin, `/api/videos/public?limit=100&search=${encodeURIComponent(searchTerm)}`),
        'Public video search',
      ),
      'Public video search',
    );
    assert(search.items.length > 0, 'Public video search returned no matching result.');
    assert(
      search.items.every((video) =>
        String(video?.title ?? '')
          .toLocaleLowerCase()
          .includes(searchTerm.toLocaleLowerCase()),
      ),
      'Public video search was not filtered on the server.',
    );
    if (search.nextCursor) {
      const nextPage = asPage(
        await getJson(
          fetchImpl,
          smokeUrl(
            origin,
            `/api/videos/public?limit=100&search=${encodeURIComponent(searchTerm)}&cursor=${encodeURIComponent(search.nextCursor)}`,
          ),
          'Public video search continuation',
        ),
        'Public video search continuation',
      );
      assert(
        nextPage.items.every((video) =>
          String(video?.title ?? '')
            .toLocaleLowerCase()
            .includes(searchTerm.toLocaleLowerCase()),
        ),
        'Public video search pagination was not filtered on the server.',
      );
    }
    searchChecked = true;
  }

  const privateStatuses = await Promise.all(
    PRIVATE_ENDPOINTS.map(async (path) => {
      const response = await fetchImpl(smokeUrl(origin, path), { redirect: 'manual' });
      await response.body?.cancel().catch(() => undefined);
      return response.status;
    }),
  );
  assert(
    privateStatuses.every((status) => status === 401),
    'An anonymous request reached a private endpoint.',
  );

  return {
    publicChannels: channels.items.length,
    publicVideos: videos.items.length,
    checkedPublicPosters: videos.items.length,
    checkedPublicPlayback: videos.items.length,
    searchChecked,
  };
}

async function main() {
  const summary = await runProductionSmoke({ origin: process.env.VIDAK_SMOKE_ORIGIN });
  console.log(`production smoke passed — ${JSON.stringify(summary)}`);
}

const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Production smoke failed.';
    console.error(`production smoke failed — ${message}`);
    process.exit(1);
  });
}
