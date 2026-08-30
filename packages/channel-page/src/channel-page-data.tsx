'use client';

import type { VideoApiClient } from '@w3ds/api-client';
import { videoProductSurfaceEnabled } from '@w3ds/api-client';
import { useChannel, useInfinitePlaylists, useInfiniteVideos, useUserProfile } from '@w3ds/hooks';
import type { ChannelId, Video } from '@w3ds/types';
import { useMemo } from 'react';
import { ChannelPage, type ChannelPageProps } from './channel-page';
import type { ChannelSectionState } from './channel-section';

/** Uploads at or below this duration belong to the Shorts tab instead of the Videos tab. */
export const SHORT_MAX_DURATION_SECONDS = 60;

const uploadsPageSize = 12;
const playlistsPageSize = 24;

export interface ChannelPageDataProps
  extends Omit<
    ChannelPageProps,
    | 'channel'
    | 'isVerified'
    | 'playlists'
    | 'playlistsState'
    | 'shorts'
    | 'shortsState'
    | 'state'
    | 'videos'
    | 'videosState'
  > {
  client: VideoApiClient;
  channelId: ChannelId;
}

export function partitionUploads(uploads: readonly Video[]): {
  videos: readonly Video[];
  shorts: readonly Video[];
} {
  return {
    videos: uploads.filter((video) => video.durationSeconds > SHORT_MAX_DURATION_SECONDS),
    shorts: uploads.filter((video) => video.durationSeconds <= SHORT_MAX_DURATION_SECONDS),
  };
}

export function resolveSectionState({
  isPending,
  error,
  hasItems,
}: {
  isPending: boolean;
  error: unknown;
  hasItems: boolean;
}): ChannelSectionState {
  if (isPending) return 'loading';
  if (error) return 'error';
  return hasItems ? 'ready' : 'empty';
}

export function ChannelPageData({ client, channelId, ...props }: ChannelPageDataProps) {
  const channelQuery = useChannel(client, channelId);
  const channel = channelQuery.data;
  const ownerQuery = useUserProfile(client, channel?.ownerId ?? '', {
    enabled: Boolean(channel),
  });
  const uploadsQuery = useInfiniteVideos(
    client,
    { channelId, status: 'published', visibility: 'public' },
    uploadsPageSize,
  );
  const playlistsEnabled = videoProductSurfaceEnabled(client, 'playlists');
  const playlistsQuery = useInfinitePlaylists(client, {}, playlistsPageSize, playlistsEnabled);

  const uploadPages = uploadsQuery.data?.pages;
  const playlistPages = playlistsQuery.data?.pages;

  const { videos, shorts } = useMemo(
    () => partitionUploads(uploadPages?.flatMap((page) => page.items) ?? []),
    [uploadPages],
  );
  const playlists = useMemo(
    () =>
      (playlistPages?.flatMap((page) => page.items) ?? []).filter(
        (playlist) => playlist.channelId === channelId,
      ),
    [channelId, playlistPages],
  );

  const uploadsState = (items: readonly Video[]) =>
    resolveSectionState({
      isPending: uploadsQuery.isPending,
      error: uploadsQuery.error,
      hasItems: items.length > 0,
    });

  return (
    <ChannelPage
      {...props}
      {...(channel ? { channel } : {})}
      isVerified={ownerQuery.data?.isVerified ?? false}
      videos={videos}
      shorts={shorts}
      playlists={playlists}
      videosState={uploadsState(videos)}
      shortsState={uploadsState(shorts)}
      playlistsState={resolveSectionState({
        isPending: playlistsQuery.isPending,
        error: playlistsQuery.error,
        hasItems: playlists.length > 0,
      })}
      state={resolveSectionState({
        isPending: channelQuery.isPending,
        error: channelQuery.error,
        hasItems: Boolean(channel),
      })}
      hasMoreUploads={uploadsQuery.hasNextPage}
      isFetchingMoreUploads={uploadsQuery.isFetchingNextPage}
      onLoadMoreUploads={() => void uploadsQuery.fetchNextPage()}
      onRetryUploads={() => void uploadsQuery.refetch()}
      onRetryPlaylists={() => void playlistsQuery.refetch()}
      {...(playlistsEnabled ? { tabs: ['videos', 'shorts', 'playlists', 'about'] as const } : {})}
      {...(channelQuery.error ? { onRetry: () => void channelQuery.refetch() } : {})}
    />
  );
}
