import type { AuthUser } from '@w3ds/auth';
import type { ImportedChannelVideo } from '@w3ds/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import 'server-only';
import { getW3dsDatabase } from './db/client';
import { channelImportConnections, importedChannels, importedChannelVideos } from './db/schema';
import { getW3dsAuthService } from './w3ds-auth';

function videoFromRow(row: {
  id: string;
  importedChannelId: string;
  provider: 'youtube' | 'vimeo';
  sourceVideoId: string;
  title: string;
  description: string | null;
  sourceUrl: string;
  embedUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  sourceVisibility: 'public' | 'unlisted' | 'private' | 'unknown';
  playbackStatus: 'embedded' | 'source_only';
  publishedAt: Date | null;
}): ImportedChannelVideo {
  return {
    id: row.id,
    importedChannelId: row.importedChannelId,
    provider: row.provider,
    sourceVideoId: row.sourceVideoId,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    sourceUrl: row.sourceUrl,
    ...(row.embedUrl ? { embedUrl: row.embedUrl } : {}),
    ...(row.thumbnailUrl ? { thumbnailUrl: row.thumbnailUrl } : {}),
    ...(row.durationSeconds !== null ? { durationSeconds: row.durationSeconds } : {}),
    sourceVisibility: row.sourceVisibility,
    playbackStatus: row.playbackStatus,
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
  };
}

export class ChannelImportCatalogError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 404,
  ) {
    super(message);
  }
}

/** Private, owner-scoped access to metadata-only source catalogues. */
export class ChannelImportCatalogService {
  constructor(
    private readonly resolveUser: (accessToken: string) => Promise<AuthUser> = async (
      accessToken,
    ) => (await getW3dsAuthService().getSession(accessToken)).user,
  ) {}

  async listVideos(accessToken: string, limit: number): Promise<ImportedChannelVideo[]> {
    const user = await this.requireUser(accessToken);
    const db = getW3dsDatabase();
    const rows = await db
      .select({
        id: importedChannelVideos.id,
        importedChannelId: importedChannelVideos.importedChannelId,
        provider: channelImportConnections.provider,
        sourceVideoId: importedChannelVideos.sourceVideoId,
        title: importedChannelVideos.title,
        description: importedChannelVideos.description,
        sourceUrl: importedChannelVideos.sourceUrl,
        embedUrl: importedChannelVideos.embedUrl,
        thumbnailUrl: importedChannelVideos.thumbnailUrl,
        durationSeconds: importedChannelVideos.durationSeconds,
        sourceVisibility: importedChannelVideos.sourceVisibility,
        playbackStatus: importedChannelVideos.playbackStatus,
        publishedAt: importedChannelVideos.publishedAt,
      })
      .from(importedChannelVideos)
      .innerJoin(importedChannels, eq(importedChannelVideos.importedChannelId, importedChannels.id))
      .innerJoin(
        channelImportConnections,
        eq(importedChannels.connectionId, channelImportConnections.id),
      )
      .where(
        and(
          eq(channelImportConnections.ownerId, user.id),
          isNull(channelImportConnections.revokedAt),
        ),
      )
      .orderBy(desc(importedChannelVideos.publishedAt), desc(importedChannelVideos.updatedAt))
      .limit(clampLimit(limit));
    return rows.map(videoFromRow);
  }

  async findVideo(accessToken: string, videoId: string): Promise<ImportedChannelVideo> {
    const user = await this.requireUser(accessToken);
    const db = getW3dsDatabase();
    const [row] = await db
      .select({
        id: importedChannelVideos.id,
        importedChannelId: importedChannelVideos.importedChannelId,
        provider: channelImportConnections.provider,
        sourceVideoId: importedChannelVideos.sourceVideoId,
        title: importedChannelVideos.title,
        description: importedChannelVideos.description,
        sourceUrl: importedChannelVideos.sourceUrl,
        embedUrl: importedChannelVideos.embedUrl,
        thumbnailUrl: importedChannelVideos.thumbnailUrl,
        durationSeconds: importedChannelVideos.durationSeconds,
        sourceVisibility: importedChannelVideos.sourceVisibility,
        playbackStatus: importedChannelVideos.playbackStatus,
        publishedAt: importedChannelVideos.publishedAt,
      })
      .from(importedChannelVideos)
      .innerJoin(importedChannels, eq(importedChannelVideos.importedChannelId, importedChannels.id))
      .innerJoin(
        channelImportConnections,
        eq(importedChannels.connectionId, channelImportConnections.id),
      )
      .where(
        and(
          eq(importedChannelVideos.id, videoId),
          eq(channelImportConnections.ownerId, user.id),
          isNull(channelImportConnections.revokedAt),
        ),
      )
      .limit(1);
    if (!row) throw new ChannelImportCatalogError('Imported video not found.', 404);
    return videoFromRow(row);
  }

  private async requireUser(accessToken: string): Promise<AuthUser> {
    if (!accessToken.trim())
      throw new ChannelImportCatalogError('Authentication is required.', 401);
    try {
      return await this.resolveUser(accessToken);
    } catch {
      throw new ChannelImportCatalogError('Authentication is required.', 401);
    }
  }
}

let sharedService: ChannelImportCatalogService | undefined;

export function getChannelImportCatalogService(): ChannelImportCatalogService {
  if (!sharedService) sharedService = new ChannelImportCatalogService();
  return sharedService;
}

function clampLimit(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 50;
}
