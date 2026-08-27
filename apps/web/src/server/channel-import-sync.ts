import { randomUUID } from 'node:crypto';
import type { ChannelImportProvider } from '@w3ds/types';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import {
  type ChannelImportProviderConfig,
  readChannelImportProviderConfig,
  readChannelImportSecurityConfig,
} from './channel-import-config';
import {
  decryptChannelImportCredential,
  encryptChannelImportCredential,
} from './channel-import-crypto';
import type { W3dsDatabase } from './db/client';
import {
  channelImportConnections,
  channelImportSyncJobs,
  type ImportedChannelVideoPlaybackStatus,
  type ImportedChannelVideoVisibility,
  importedChannels,
  importedChannelVideos,
} from './db/schema';

const providerRequestTimeoutMs = 10_000;
const syncLeaseMs = 2 * 60 * 1000;
const refreshLeewayMs = 60 * 1000;
const youtubePageSize = 50;
const vimeoPageSize = 100;

interface ClaimedSyncJob {
  jobId: string;
  importedChannelId: string;
  connectionId: string;
  provider: ChannelImportProvider;
  sourceChannelId: string;
  sourceCatalogueId?: string;
  nextCursor?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  accessTokenExpiresAt?: Date;
  attemptCount: number;
}

interface ProviderCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

interface SourceVideo {
  sourceVideoId: string;
  title: string;
  description?: string;
  sourceUrl: string;
  embedUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  sourceVisibility: ImportedChannelVideoVisibility;
  playbackStatus: ImportedChannelVideoPlaybackStatus;
  publishedAt?: Date;
}

interface SourcePage {
  videos: readonly SourceVideo[];
  nextCursor?: string;
}

export interface ChannelImportSyncServiceOptions {
  db: W3dsDatabase;
  fetch?: typeof globalThis.fetch;
  createId?: () => string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

/** A safe failure that says whether a creator needs to reconnect their provider. */
class ChannelImportSyncError extends Error {
  constructor(public readonly needsReconnect: boolean) {
    super('Channel import sync failed.');
  }
}

/**
 * Processes one bounded provider catalogue page per invocation. Credentials
 * remain encrypted at rest and never leave this server-side service.
 */
export class ChannelImportSyncService {
  private readonly db: W3dsDatabase;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;

  constructor(options: ChannelImportSyncServiceOptions) {
    this.db = options.db;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
  }

  async runNextBatch(): Promise<'processed' | 'idle' | 'disabled'> {
    const security = readChannelImportSecurityConfig(this.env);
    if (!security) return 'disabled';
    const now = this.now();
    const job = await this.claimNextJob(now);
    if (!job) return 'idle';

    try {
      const config = readChannelImportProviderConfig(job.provider, this.env);
      if (!config) throw new ChannelImportSyncError(true);
      const credential = await this.readUsableCredential(job, config, security.encryptionKey, now);
      const page = await this.readSourcePage(job, credential.accessToken);
      await this.completePage(job, page, now);
      return 'processed';
    } catch (error) {
      await this.failJob(job, error instanceof ChannelImportSyncError && error.needsReconnect, now);
      return 'processed';
    }
  }

  private async claimNextJob(now: Date): Promise<ClaimedSyncJob | undefined> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          jobId: channelImportSyncJobs.id,
          importedChannelId: importedChannels.id,
          connectionId: channelImportConnections.id,
          provider: channelImportConnections.provider,
          sourceChannelId: importedChannels.sourceChannelId,
          sourceCatalogueId: importedChannels.sourceCatalogueId,
          nextCursor: channelImportSyncJobs.nextCursor,
          encryptedAccessToken: channelImportConnections.encryptedAccessToken,
          encryptedRefreshToken: channelImportConnections.encryptedRefreshToken,
          accessTokenExpiresAt: channelImportConnections.accessTokenExpiresAt,
          attemptCount: channelImportSyncJobs.attemptCount,
        })
        .from(channelImportSyncJobs)
        .innerJoin(
          importedChannels,
          eq(channelImportSyncJobs.importedChannelId, importedChannels.id),
        )
        .innerJoin(
          channelImportConnections,
          eq(importedChannels.connectionId, channelImportConnections.id),
        )
        .where(
          and(
            isNull(channelImportConnections.revokedAt),
            or(
              eq(channelImportSyncJobs.status, 'queued'),
              and(
                eq(channelImportSyncJobs.status, 'processing'),
                lt(channelImportSyncJobs.lockedUntil, now),
              ),
            ),
          ),
        )
        .orderBy(asc(channelImportSyncJobs.updatedAt))
        .limit(1)
        .for('update');
      if (!candidate) return undefined;
      await tx
        .update(channelImportSyncJobs)
        .set({
          status: 'processing',
          attemptCount: candidate.attemptCount + 1,
          lockedUntil: new Date(now.getTime() + syncLeaseMs),
          updatedAt: now,
        })
        .where(eq(channelImportSyncJobs.id, candidate.jobId));
      return {
        jobId: candidate.jobId,
        importedChannelId: candidate.importedChannelId,
        connectionId: candidate.connectionId,
        provider: candidate.provider,
        sourceChannelId: candidate.sourceChannelId,
        ...(candidate.sourceCatalogueId ? { sourceCatalogueId: candidate.sourceCatalogueId } : {}),
        ...(candidate.nextCursor ? { nextCursor: candidate.nextCursor } : {}),
        encryptedAccessToken: candidate.encryptedAccessToken,
        ...(candidate.encryptedRefreshToken
          ? { encryptedRefreshToken: candidate.encryptedRefreshToken }
          : {}),
        ...(candidate.accessTokenExpiresAt
          ? { accessTokenExpiresAt: candidate.accessTokenExpiresAt }
          : {}),
        attemptCount: candidate.attemptCount + 1,
      };
    });
  }

  private async readUsableCredential(
    job: ClaimedSyncJob,
    config: ChannelImportProviderConfig,
    encryptionKey: Buffer,
    now: Date,
  ): Promise<ProviderCredential> {
    let accessToken: string;
    try {
      accessToken = decryptChannelImportCredential(job.encryptedAccessToken, encryptionKey);
    } catch {
      throw new ChannelImportSyncError(true);
    }
    const expiry = job.accessTokenExpiresAt;
    if (!expiry || expiry.getTime() > now.getTime() + refreshLeewayMs)
      return { accessToken, ...(expiry ? { expiresAt: expiry } : {}) };
    if (!job.encryptedRefreshToken) throw new ChannelImportSyncError(true);

    let refreshToken: string;
    try {
      refreshToken = decryptChannelImportCredential(job.encryptedRefreshToken, encryptionKey);
    } catch {
      throw new ChannelImportSyncError(true);
    }
    const refreshed = await this.refreshCredential(config, refreshToken, now);
    await this.db
      .update(channelImportConnections)
      .set({
        encryptedAccessToken: encryptChannelImportCredential(refreshed.accessToken, encryptionKey),
        ...(refreshed.refreshToken
          ? {
              encryptedRefreshToken: encryptChannelImportCredential(
                refreshed.refreshToken,
                encryptionKey,
              ),
            }
          : {}),
        accessTokenExpiresAt: refreshed.expiresAt ?? null,
        updatedAt: now,
      })
      .where(eq(channelImportConnections.id, job.connectionId));
    return refreshed;
  }

  private async refreshCredential(
    config: ChannelImportProviderConfig,
    refreshToken: string,
    now: Date,
  ): Promise<ProviderCredential> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
    if (config.provider === 'youtube') {
      body.set('client_id', config.clientId);
      body.set('client_secret', config.clientSecret);
    } else {
      headers.set(
        'Authorization',
        'Basic ' +
          Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64'),
      );
    }
    const payload = await this.fetchJson(config.tokenEndpoint, { method: 'POST', headers, body });
    const accessToken = readString(payload.access_token);
    if (!accessToken) throw new ChannelImportSyncError(true);
    const nextRefreshToken = readString(payload.refresh_token) ?? refreshToken;
    const expiresIn = readPositiveNumber(payload.expires_in);
    return {
      accessToken,
      refreshToken: nextRefreshToken,
      ...(expiresIn ? { expiresAt: new Date(now.getTime() + expiresIn * 1000) } : {}),
    };
  }

  private async readSourcePage(job: ClaimedSyncJob, accessToken: string): Promise<SourcePage> {
    if (job.provider === 'youtube') return this.readYouTubePage(job, accessToken);
    return this.readVimeoPage(job, accessToken);
  }

  private async readYouTubePage(job: ClaimedSyncJob, accessToken: string): Promise<SourcePage> {
    if (!job.sourceCatalogueId) throw new ChannelImportSyncError(false);
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('playlistId', job.sourceCatalogueId);
    url.searchParams.set('maxResults', String(youtubePageSize));
    if (job.nextCursor) url.searchParams.set('pageToken', job.nextCursor);
    const payload = await this.fetchJson(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const playlistItems = Array.isArray(payload.items) ? payload.items : [];
    const candidates = playlistItems.flatMap((item) => readYouTubePlaylistVideo(item));
    const details = await this.readYouTubeDetails(
      candidates.map((item) => item.sourceVideoId),
      accessToken,
    );
    const videos = candidates.map((candidate) => {
      const detail = details.get(candidate.sourceVideoId);
      const visibility = detail?.visibility ?? 'unknown';
      const canEmbed = visibility === 'public' || visibility === 'unlisted';
      return {
        ...candidate,
        ...(detail?.durationSeconds !== undefined
          ? { durationSeconds: detail.durationSeconds }
          : {}),
        sourceVisibility: visibility,
        ...(canEmbed
          ? {
              embedUrl:
                'https://www.youtube-nocookie.com/embed/' +
                encodeURIComponent(candidate.sourceVideoId),
              playbackStatus: 'embedded' as const,
            }
          : { playbackStatus: 'source_only' as const }),
      };
    });
    const nextCursor = readString(payload.nextPageToken);
    return { videos, ...(nextCursor ? { nextCursor } : {}) };
  }

  private async readYouTubeDetails(
    videoIds: readonly string[],
    accessToken: string,
  ): Promise<
    Map<string, { visibility: ImportedChannelVideoVisibility; durationSeconds?: number }>
  > {
    if (videoIds.length === 0) return new Map();
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'contentDetails,status');
    url.searchParams.set('id', videoIds.join(','));
    const payload = await this.fetchJson(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const result = new Map<
      string,
      { visibility: ImportedChannelVideoVisibility; durationSeconds?: number }
    >();
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      if (!isRecord(item)) continue;
      const id = readString(item.id);
      if (!id) continue;
      const status = isRecord(item.status) ? item.status : {};
      const contentDetails = isRecord(item.contentDetails) ? item.contentDetails : {};
      const durationSeconds = parseIsoDuration(readString(contentDetails.duration));
      result.set(id, {
        visibility: readVisibility(status.privacyStatus),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      });
    }
    return result;
  }

  private async readVimeoPage(job: ClaimedSyncJob, accessToken: string): Promise<SourcePage> {
    const page = parseVimeoPage(job.nextCursor);
    const url = new URL(
      `https://api.vimeo.com/users/${encodeURIComponent(job.sourceChannelId)}/videos`,
    );
    url.searchParams.set('per_page', String(vimeoPageSize));
    url.searchParams.set('page', String(page));
    const payload = await this.fetchJson(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const videos = (Array.isArray(payload.data) ? payload.data : []).flatMap((item) =>
      readVimeoVideo(item),
    );
    const paging = isRecord(payload.paging) ? payload.paging : {};
    const nextUrl = readString(paging.next);
    const nextCursor = nextUrl ? readVimeoNextPage(nextUrl) : undefined;
    return { videos, ...(nextCursor ? { nextCursor } : {}) };
  }

  private async fetchJson(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(input, {
        ...init,
        signal: AbortSignal.timeout(providerRequestTimeoutMs),
      });
    } catch {
      throw new ChannelImportSyncError(false);
    }
    if (!response.ok)
      throw new ChannelImportSyncError(response.status === 401 || response.status === 403);
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!isRecord(payload)) throw new ChannelImportSyncError(false);
    return payload;
  }

  private async completePage(job: ClaimedSyncJob, page: SourcePage, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const video of page.videos) {
        await tx
          .insert(importedChannelVideos)
          .values({
            id: this.createId(),
            importedChannelId: job.importedChannelId,
            sourceVideoId: video.sourceVideoId,
            title: video.title,
            ...(video.description ? { description: video.description } : {}),
            sourceUrl: video.sourceUrl,
            ...(video.embedUrl ? { embedUrl: video.embedUrl } : {}),
            ...(video.thumbnailUrl ? { thumbnailUrl: video.thumbnailUrl } : {}),
            ...(video.durationSeconds !== undefined
              ? { durationSeconds: video.durationSeconds }
              : {}),
            sourceVisibility: video.sourceVisibility,
            playbackStatus: video.playbackStatus,
            ...(video.publishedAt ? { publishedAt: video.publishedAt } : {}),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [importedChannelVideos.importedChannelId, importedChannelVideos.sourceVideoId],
            set: {
              title: video.title,
              ...(video.description ? { description: video.description } : {}),
              sourceUrl: video.sourceUrl,
              ...(video.embedUrl ? { embedUrl: video.embedUrl } : {}),
              ...(video.thumbnailUrl ? { thumbnailUrl: video.thumbnailUrl } : {}),
              ...(video.durationSeconds !== undefined
                ? { durationSeconds: video.durationSeconds }
                : {}),
              sourceVisibility: video.sourceVisibility,
              playbackStatus: video.playbackStatus,
              ...(video.publishedAt ? { publishedAt: video.publishedAt } : {}),
              updatedAt: now,
            },
          });
      }
      const rows = await tx
        .select({ id: importedChannelVideos.id })
        .from(importedChannelVideos)
        .where(eq(importedChannelVideos.importedChannelId, job.importedChannelId));
      await tx
        .update(importedChannels)
        .set({
          importedVideoCount: rows.length,
          status: page.nextCursor ? 'syncing' : 'ready',
          lastSyncedAt: now,
          failureReason: null,
          updatedAt: now,
        })
        .where(eq(importedChannels.id, job.importedChannelId));
      await tx
        .update(channelImportSyncJobs)
        .set({
          status: page.nextCursor ? 'queued' : 'completed',
          nextCursor: page.nextCursor ?? null,
          lockedUntil: null,
          failureReason: null,
          updatedAt: now,
        })
        .where(eq(channelImportSyncJobs.id, job.jobId));
    });
  }

  private async failJob(job: ClaimedSyncJob, needsReconnect: boolean, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(channelImportSyncJobs)
        .set({
          status: 'failed',
          lockedUntil: null,
          failureReason: 'provider_sync_failed',
          updatedAt: now,
        })
        .where(eq(channelImportSyncJobs.id, job.jobId));
      await tx
        .update(importedChannels)
        .set({
          status: needsReconnect ? 'needs_reconnect' : 'failed',
          failureReason: 'provider_sync_failed',
          updatedAt: now,
        })
        .where(eq(importedChannels.id, job.importedChannelId));
    });
  }
}

function readYouTubePlaylistVideo(value: unknown): SourceVideo[] {
  if (!isRecord(value)) return [];
  const contentDetails = isRecord(value.contentDetails) ? value.contentDetails : {};
  const snippet = isRecord(value.snippet) ? value.snippet : {};
  const sourceVideoId = readString(contentDetails.videoId);
  const title = readString(snippet.title);
  if (!sourceVideoId || !title) return [];
  const thumbnails = isRecord(snippet.thumbnails) ? snippet.thumbnails : {};
  const high = isRecord(thumbnails.high) ? thumbnails.high : {};
  const medium = isRecord(thumbnails.medium) ? thumbnails.medium : {};
  const publishedAt = parseDate(contentDetails.videoPublishedAt) ?? parseDate(snippet.publishedAt);
  const description = readString(snippet.description);
  const thumbnailUrl = readHttpsUrl(high.url) ?? readHttpsUrl(medium.url);
  return [
    {
      sourceVideoId,
      title,
      ...(description ? { description } : {}),
      sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(sourceVideoId)}`,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      sourceVisibility: 'unknown',
      playbackStatus: 'source_only',
      ...(publishedAt ? { publishedAt } : {}),
    },
  ];
}

function readVimeoVideo(value: unknown): SourceVideo[] {
  if (!isRecord(value)) return [];
  const uri = readString(value.uri);
  const sourceVideoId = uri?.match(/^\/videos\/([^/]+)$/)?.[1];
  const title = readString(value.name);
  const sourceUrl =
    readVimeoSourceUrl(value.link) ??
    `https://vimeo.com/${encodeURIComponent(sourceVideoId ?? '')}`;
  if (!sourceVideoId || !title) return [];
  const privacy = isRecord(value.privacy) ? value.privacy : {};
  const visibility = readVimeoVisibility(privacy.view);
  const embedUrl = readVimeoEmbedUrl(value.player_embed_url);
  const canEmbed = Boolean(embedUrl) && (visibility === 'public' || visibility === 'unlisted');
  const pictures = isRecord(value.pictures) ? value.pictures : {};
  const sizes = Array.isArray(pictures.sizes) ? pictures.sizes : [];
  const thumbnailUrl = sizes
    .slice()
    .reverse()
    .map((item) => (isRecord(item) ? readHttpsUrl(item.link) : undefined))
    .find((item): item is string => Boolean(item));
  const publishedAt = parseDate(value.release_time) ?? parseDate(value.created_time);
  const description = readString(value.description);
  const durationSeconds = readNonNegativeInteger(value.duration);
  return [
    {
      sourceVideoId,
      title,
      ...(description ? { description } : {}),
      sourceUrl,
      ...(canEmbed && embedUrl ? { embedUrl } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      sourceVisibility: visibility,
      playbackStatus: canEmbed ? 'embedded' : 'source_only',
      ...(publishedAt ? { publishedAt } : {}),
    },
  ];
}

function parseVimeoPage(value: string | undefined): number {
  const page = Number.parseInt(value ?? '1', 10);
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
}

function readVimeoNextPage(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://api.vimeo.com');
    const page = parseVimeoPage(url.searchParams.get('page') ?? undefined);
    return String(page);
  } catch {
    return undefined;
  }
}

function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return undefined;
  const hours = Number.parseInt(match[1] ?? '0', 10);
  const minutes = Number.parseInt(match[2] ?? '0', 10);
  const seconds = Number.parseInt(match[3] ?? '0', 10);
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : undefined;
}

function parseDate(value: unknown): Date | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readVisibility(value: unknown): ImportedChannelVideoVisibility {
  return value === 'public' || value === 'unlisted' || value === 'private' ? value : 'unknown';
}

function readVimeoVisibility(value: unknown): ImportedChannelVideoVisibility {
  if (value === 'anybody') return 'public';
  if (value === 'unlisted') return 'unlisted';
  if (value === 'nobody' || value === 'disable') return 'private';
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readVimeoSourceUrl(value: unknown): string | undefined {
  const url = readHttpsUrl(value);
  if (!url) return undefined;
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'vimeo.com' || hostname.endsWith('.vimeo.com') ? url : undefined;
  } catch {
    return undefined;
  }
}

function readVimeoEmbedUrl(value: unknown): string | undefined {
  const url = readHttpsUrl(value);
  if (!url) return undefined;
  try {
    return new URL(url).hostname === 'player.vimeo.com' ? url : undefined;
  } catch {
    return undefined;
  }
}

function readHttpsUrl(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
