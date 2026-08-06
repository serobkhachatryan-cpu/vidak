/**
 * Builds Vidak-private ontology projection payloads from product entities.
 * Omits media URI fields unless the source is already a valid w3ds://file URI
 * (no external file upload/generation in this phase).
 */

import type { Video } from '@w3ds/types';
import type {
  SyncChannelInput,
  SyncCommentInput,
  SyncPlaylistInput,
  SyncVideoInput,
} from './w3ds-private-adapter-sync-types';
import { VIDAK_PRIVATE_SCHEMA_IDS } from './w3ds-private-ontology';

const eNamePattern = /^@[^\s@]+$/;
const w3dsFileUriPattern = /^w3ds:\/\/file\?id=@[^/\s]+\/[^\s]+$/;
const ontologyHandlePattern = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export class W3dsPrivateAdapterProjectionError extends Error {
  readonly code: string;

  constructor(message: string, code = 'invalid_projection') {
    super(message);
    this.name = 'W3dsPrivateAdapterProjectionError';
    this.code = code;
  }
}

export function assertValidOwnerEName(ownerEName: string): string {
  const trimmed = ownerEName.trim();
  if (!eNamePattern.test(trimmed)) {
    throw new W3dsPrivateAdapterProjectionError(
      'Private adapter projections require a valid owner eName (e.g. @user.w3id).',
      'invalid_owner_ename',
    );
  }
  return trimmed;
}

/**
 * Pass through existing w3ds://file URIs only. HTTP URLs, storage keys, and
 * filesystem paths are omitted — never invent remote file envelopes.
 */
export function optionalW3dsFileUri(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!w3dsFileUriPattern.test(trimmed)) return undefined;
  return trimmed;
}

/** Normalize product handles to the private Channel ontology pattern. */
export function toPrivateOntologyHandle(handle: string): string {
  const raw = handle.trim().toLocaleLowerCase();
  let normalized = raw
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .replace(/_+/g, '_');
  if (!normalized || !/^[a-z0-9]/.test(normalized)) {
    normalized = `c${normalized}`;
  }
  normalized = normalized.slice(0, 63);
  if (!ontologyHandlePattern.test(normalized)) {
    throw new W3dsPrivateAdapterProjectionError(
      'Channel handle cannot be projected onto the private Channel schema.',
      'invalid_channel_handle',
    );
  }
  return normalized;
}

export function buildChannelProjectionPayload(
  input: SyncChannelInput,
  globalId: string,
): Record<string, unknown> {
  const ownerEName = assertValidOwnerEName(input.ownerEName);
  const channel = input.channel;
  if (!channel?.id?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Channel id is required.', 'invalid_entity');
  }
  if (!channel.name?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Channel name is required.', 'invalid_entity');
  }
  const createdAt = channel.createdAt?.trim();
  if (!createdAt) {
    throw new W3dsPrivateAdapterProjectionError('Channel createdAt is required.', 'invalid_entity');
  }
  const updatedAt = (input.updatedAt ?? channel.createdAt).trim();
  const avatarFileUri = optionalW3dsFileUri(channel.avatarUrl);
  const bannerFileUri = optionalW3dsFileUri(channel.bannerUrl);

  return {
    id: globalId,
    ownerEName,
    handle: toPrivateOntologyHandle(channel.handle),
    name: channel.name.trim().slice(0, 200),
    ...(channel.description !== undefined
      ? { description: String(channel.description).slice(0, 5000) }
      : {}),
    ...(avatarFileUri ? { avatarFileUri } : {}),
    ...(bannerFileUri ? { bannerFileUri } : {}),
    subscriberCount: Math.max(0, Math.floor(channel.subscriberCount ?? 0)),
    videoCount: Math.max(0, Math.floor(channel.videoCount ?? 0)),
    createdAt,
    updatedAt,
  };
}

export function buildVideoProjectionPayload(
  input: SyncVideoInput,
  globalId: string,
  channelGlobalId: string,
): Record<string, unknown> {
  const ownerEName = assertValidOwnerEName(input.ownerEName);
  const video = input.video;
  if (!video?.id?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Video id is required.', 'invalid_entity');
  }
  if (!video.title?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Video title is required.', 'invalid_entity');
  }
  if (!video.status) {
    throw new W3dsPrivateAdapterProjectionError('Video status is required.', 'invalid_entity');
  }
  if (!video.visibility) {
    throw new W3dsPrivateAdapterProjectionError('Video visibility is required.', 'invalid_entity');
  }
  if (!video.createdAt?.trim() || !video.updatedAt?.trim()) {
    throw new W3dsPrivateAdapterProjectionError(
      'Video createdAt and updatedAt are required.',
      'invalid_entity',
    );
  }
  if (!channelGlobalId.trim()) {
    throw new W3dsPrivateAdapterProjectionError(
      'Video projections require a mapped channel global id.',
      'missing_channel_mapping',
    );
  }

  const mediaFileUri = optionalW3dsFileUri(
    (video as Video & { mediaFileUri?: string }).mediaFileUri,
  );
  const thumbnailFileUri = optionalW3dsFileUri(video.thumbnailUrl);

  return {
    id: globalId,
    ownerEName,
    channelId: channelGlobalId,
    title: video.title.trim().slice(0, 500),
    ...(video.description !== undefined
      ? { description: String(video.description).slice(0, 10000) }
      : {}),
    status: video.status,
    visibility: video.visibility,
    durationSeconds: Math.max(0, Math.floor(video.durationSeconds ?? 0)),
    ...(mediaFileUri ? { mediaFileUri } : {}),
    ...(thumbnailFileUri ? { thumbnailFileUri } : {}),
    ...(video.category ? { category: video.category } : {}),
    ...(video.language ? { language: video.language } : {}),
    tags: [...new Set((video.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 50),
    ...(video.publicVideoId ? { publicVideoId: video.publicVideoId } : {}),
    ...(video.publishedAt ? { publishedAt: video.publishedAt } : {}),
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
    viewCount: Math.max(0, Math.floor(video.viewCount ?? 0)),
    likeCount: Math.max(0, Math.floor(video.likeCount ?? 0)),
    commentCount: Math.max(0, Math.floor(video.commentCount ?? 0)),
  };
}

export function buildPlaylistProjectionPayload(
  input: SyncPlaylistInput,
  globalId: string,
  channelGlobalId: string,
  videoGlobalIdsByLocalId: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const ownerEName = assertValidOwnerEName(input.ownerEName);
  const playlist = input.playlist;
  if (!playlist?.id?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Playlist id is required.', 'invalid_entity');
  }
  if (!playlist.title?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Playlist title is required.', 'invalid_entity');
  }
  if (!playlist.visibility) {
    throw new W3dsPrivateAdapterProjectionError(
      'Playlist visibility is required.',
      'invalid_entity',
    );
  }
  if (!playlist.createdAt?.trim() || !playlist.updatedAt?.trim()) {
    throw new W3dsPrivateAdapterProjectionError(
      'Playlist createdAt and updatedAt are required.',
      'invalid_entity',
    );
  }
  if (!channelGlobalId.trim()) {
    throw new W3dsPrivateAdapterProjectionError(
      'Playlist projections require a mapped channel global id.',
      'missing_channel_mapping',
    );
  }

  const items = (playlist.items ?? []).map((item) => {
    const videoGlobalId = videoGlobalIdsByLocalId.get(item.videoId);
    if (!videoGlobalId) {
      throw new W3dsPrivateAdapterProjectionError(
        `Playlist item video ${item.videoId} has no private projection mapping.`,
        'missing_video_mapping',
      );
    }
    return {
      videoId: videoGlobalId,
      position: Math.max(0, Math.floor(item.position)),
      addedAt: item.addedAt,
    };
  });

  const thumbnailFileUri = optionalW3dsFileUri(playlist.thumbnailUrl);

  return {
    id: globalId,
    ownerEName,
    channelId: channelGlobalId,
    title: playlist.title.trim().slice(0, 500),
    ...(playlist.description !== undefined
      ? { description: String(playlist.description).slice(0, 5000) }
      : {}),
    visibility: playlist.visibility,
    ...(thumbnailFileUri ? { thumbnailFileUri } : {}),
    items,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
  };
}

export function buildCommentProjectionPayload(
  input: SyncCommentInput,
  globalId: string,
  videoGlobalId: string,
  parentGlobalId?: string,
): Record<string, unknown> {
  const ownerEName = assertValidOwnerEName(input.ownerEName);
  const comment = input.comment;
  if (!comment?.id?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Comment id is required.', 'invalid_entity');
  }
  if (!comment.body?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Comment body is required.', 'invalid_entity');
  }
  if (!comment.createdAt?.trim()) {
    throw new W3dsPrivateAdapterProjectionError('Comment createdAt is required.', 'invalid_entity');
  }
  if (!videoGlobalId.trim()) {
    throw new W3dsPrivateAdapterProjectionError(
      'Comment projections require a mapped video global id.',
      'missing_video_mapping',
    );
  }

  return {
    id: globalId,
    ownerEName,
    videoId: videoGlobalId,
    ...(parentGlobalId ? { parentId: parentGlobalId } : {}),
    body: comment.body.trim().slice(0, 10000),
    ...(input.visibility ? { visibility: input.visibility } : {}),
    createdAt: comment.createdAt,
    ...(comment.updatedAt ? { updatedAt: comment.updatedAt } : {}),
    likeCount: Math.max(0, Math.floor(comment.likeCount ?? 0)),
    replyCount: Math.max(0, Math.floor(comment.replyCount ?? 0)),
  };
}

export function privateSchemaIdForEntity(
  entityType: 'channel' | 'video' | 'playlist' | 'comment',
): string {
  switch (entityType) {
    case 'channel':
      return VIDAK_PRIVATE_SCHEMA_IDS.Channel;
    case 'video':
      return VIDAK_PRIVATE_SCHEMA_IDS.Video;
    case 'playlist':
      return VIDAK_PRIVATE_SCHEMA_IDS.Playlist;
    case 'comment':
      return VIDAK_PRIVATE_SCHEMA_IDS.Comment;
  }
}
