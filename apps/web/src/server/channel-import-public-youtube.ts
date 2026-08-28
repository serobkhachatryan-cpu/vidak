import 'server-only';

const youtubeChannelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const providerRequestTimeoutMs = 10_000;
const maximumFeedBytes = 1_000_000;

export interface PublicYouTubeVideo {
  sourceVideoId: string;
  title: string;
  sourceUrl: string;
  thumbnailUrl: string;
  publishedAt?: Date;
}

export interface PublicYouTubeChannelFeed {
  sourceChannelId: string;
  title: string;
  sourceUrl: string;
  videos: readonly PublicYouTubeVideo[];
}

/** A deliberate, source-agnostic error safe to show to a creator. */
export class PublicYouTubeChannelError extends Error {
  constructor(message = 'Enter a public YouTube channel link in the form youtube.com/channel/UC…') {
    super(message);
  }
}

/**
 * Public feeds are intentionally limited to canonical channel IDs. Handles and
 * search pages require an API key or scraping, neither of which belongs in a
 * privacy-respecting import path.
 */
export function parsePublicYouTubeChannelId(input: unknown): string {
  if (typeof input !== 'string') throw new PublicYouTubeChannelError();
  const value = input.trim();
  if (youtubeChannelIdPattern.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicYouTubeChannelError();
  }
  if (url.protocol !== 'https:' || !isYouTubeHost(url.hostname)) {
    throw new PublicYouTubeChannelError();
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const channelId = segments.length === 2 && segments[0] === 'channel' ? segments[1] : undefined;
  if (!channelId || !youtubeChannelIdPattern.test(channelId)) throw new PublicYouTubeChannelError();
  return channelId;
}

/**
 * Reads YouTube's documented Atom feed for one public channel. The request URL
 * is constructed from a validated ID, so this never fetches a user-controlled
 * host and cannot become an SSRF primitive.
 */
export async function readPublicYouTubeChannelFeed(
  channelIdInput: unknown,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<PublicYouTubeChannelFeed> {
  const sourceChannelId = parsePublicYouTubeChannelId(channelIdInput);
  const url = new URL('https://www.youtube.com/feeds/videos.xml');
  url.searchParams.set('channel_id', sourceChannelId);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/atom+xml, application/xml;q=0.9' },
      signal: AbortSignal.timeout(providerRequestTimeoutMs),
    });
  } catch {
    throw new PublicYouTubeChannelError('Could not reach that public YouTube channel.');
  }
  if (!response.ok)
    throw new PublicYouTubeChannelError('Could not find that public YouTube channel.');
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumFeedBytes) {
    throw new PublicYouTubeChannelError('That public YouTube channel response is too large.');
  }
  const xml = await response.text().catch(() => '');
  if (xml.length === 0 || Buffer.byteLength(xml, 'utf8') > maximumFeedBytes) {
    throw new PublicYouTubeChannelError('Could not read that public YouTube channel.');
  }
  return parsePublicYouTubeChannelFeed(xml, sourceChannelId);
}

export function parsePublicYouTubeChannelFeed(
  xml: string,
  sourceChannelId: string,
): PublicYouTubeChannelFeed {
  if (!xml.includes('<feed'))
    throw new PublicYouTubeChannelError('Could not read that public YouTube channel.');

  const entryBlocks = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].slice(0, 15);
  const videos = entryBlocks.flatMap((match) => {
    const entry = match[1] ?? '';
    const sourceVideoId = readXmlTag(entry, 'yt:videoId');
    const title = readXmlTag(entry, 'title');
    if (!sourceVideoId || !title || !/^[A-Za-z0-9_-]{6,}$/.test(sourceVideoId)) return [];
    const publishedAt = readDate(readXmlTag(entry, 'published'));
    return [
      {
        sourceVideoId,
        title,
        sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(sourceVideoId)}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${encodeURIComponent(sourceVideoId)}/hqdefault.jpg`,
        ...(publishedAt ? { publishedAt } : {}),
      },
    ];
  });
  const author = readXmlBlock(xml, 'author');
  const title =
    (author ? readXmlTag(author, 'name') : undefined) ?? `YouTube channel ${sourceChannelId}`;
  return {
    sourceChannelId,
    title,
    sourceUrl: `https://www.youtube.com/channel/${encodeURIComponent(sourceChannelId)}`,
    videos,
  };
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com';
}

function readXmlBlock(xml: string, name: string): string | undefined {
  const escaped = name.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  return new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i').exec(xml)?.[1];
}

function readXmlTag(xml: string, name: string): string | undefined {
  const escaped = name.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i').exec(xml);
  if (!match?.[1]) return undefined;
  const value = decodeXml(match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim());
  return value || undefined;
}
function decodeXml(value: string): string {
  return value
    .replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|amp|lt|gt|quot|apos);/gi, (entity, hex, decimal) => {
      if (hex || decimal) {
        const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '';
      }
      return (
        { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[
          entity.toLowerCase()
        ] ?? entity
      );
    })
    .replace(/<[^>]*>/g, '')
    .trim();
}

function readDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
