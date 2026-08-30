'use client';

import type { VideoApiClient } from '@w3ds/api-client';
import { videoProductSurfaceEnabled } from '@w3ds/api-client';
import {
  useInfiniteChannels,
  useInfinitePlaylists,
  useInfiniteVideos,
  useUserProfile,
} from '@w3ds/hooks';
import type { Channel, ChannelId, Playlist, UserProfileId, Video } from '@w3ds/types';
import { useMemo } from 'react';
import { UserProfilePage, type UserProfilePageProps } from './user-profile-page';
import type { UserProfileSectionState } from './user-profile-section';

const videosPageSize = 12;
const playlistsPageSize = 24;
const channelsPageSize = 50;

export interface UserProfilePageDataProps
  extends Omit<
    UserProfilePageProps,
    | 'channelsById'
    | 'playlists'
    | 'playlistsState'
    | 'profile'
    | 'state'
    | 'videoCount'
    | 'videos'
    | 'videosState'
  > {
  client: VideoApiClient;
  userId: UserProfileId;
}

export function resolveSectionState({
  isPending,
  error,
  hasItems,
}: {
  isPending: boolean;
  error: unknown;
  hasItems: boolean;
}): UserProfileSectionState {
  if (isPending) return 'loading';
  if (error) return 'error';
  return hasItems ? 'ready' : 'empty';
}

export function ownedChannelsForUser(
  channels: readonly Channel[],
  userId: UserProfileId,
): readonly Channel[] {
  return channels.filter((channel) => channel.ownerId === userId);
}

/** When ownership is a single channel the API already scoped the list; otherwise filter client-side. */
export function videosForOwnedChannels(
  videos: readonly Video[],
  ownedChannelIds: ReadonlySet<ChannelId>,
  primaryChannelId: ChannelId | undefined,
): readonly Video[] {
  return primaryChannelId ? videos : videos.filter((video) => ownedChannelIds.has(video.channelId));
}

export function playlistsForOwnedChannels(
  playlists: readonly Playlist[],
  ownedChannelIds: ReadonlySet<ChannelId>,
): readonly Playlist[] {
  return playlists.filter((playlist) => ownedChannelIds.has(playlist.channelId));
}

export function UserProfilePageData({ client, userId, ...props }: UserProfilePageDataProps) {
  const profileQuery = useUserProfile(client, userId);
  const profile = profileQuery.data;
  const channelsQuery = useInfiniteChannels(client, {}, channelsPageSize);
  const channelPages = channelsQuery.data?.pages;
  const ownedChannels = useMemo(
    () => ownedChannelsForUser(channelPages?.flatMap((page) => page.items) ?? [], userId),
    [channelPages, userId],
  );
  const ownedChannelIds = useMemo(
    () => new Set(ownedChannels.map((channel) => channel.id)),
    [ownedChannels],
  );
  const primaryChannelId = ownedChannels.length === 1 ? ownedChannels[0]?.id : undefined;
  const videosQuery = useInfiniteVideos(
    client,
    {
      ...(primaryChannelId ? { channelId: primaryChannelId } : {}),
      status: 'published',
      visibility: 'public',
    },
    videosPageSize,
  );
  const playlistsEnabled = videoProductSurfaceEnabled(client, 'playlists');
  const playlistsQuery = useInfinitePlaylists(client, {}, playlistsPageSize, playlistsEnabled);

  const videoPages = videosQuery.data?.pages;
  const playlistPages = playlistsQuery.data?.pages;

  const channelsById = useMemo(() => {
    const entries: Array<[string, Channel]> = ownedChannels.map((channel) => [channel.id, channel]);
    return Object.fromEntries(entries);
  }, [ownedChannels]);
  const videos = useMemo(
    () =>
      videosForOwnedChannels(
        videoPages?.flatMap((page) => page.items) ?? [],
        ownedChannelIds,
        primaryChannelId,
      ),
    [ownedChannelIds, primaryChannelId, videoPages],
  );
  const playlists = useMemo(
    () =>
      playlistsForOwnedChannels(
        playlistPages?.flatMap((page) => page.items) ?? [],
        ownedChannelIds,
      ),
    [ownedChannelIds, playlistPages],
  );
  const videoCount = useMemo(
    () => ownedChannels.reduce((total, channel) => total + channel.videoCount, 0),
    [ownedChannels],
  );

  const ownershipPending = channelsQuery.isPending;
  const ownershipError = channelsQuery.error;

  return (
    <UserProfilePage
      {...props}
      {...(profile ? { profile } : {})}
      videos={videos}
      channelsById={channelsById}
      playlists={playlists}
      videoCount={videoCount}
      videosState={resolveSectionState({
        isPending: ownershipPending || videosQuery.isPending,
        error: ownershipError ?? videosQuery.error,
        hasItems: videos.length > 0,
      })}
      playlistsState={resolveSectionState({
        isPending: ownershipPending || playlistsQuery.isPending,
        error: ownershipError ?? playlistsQuery.error,
        hasItems: playlists.length > 0,
      })}
      state={resolveSectionState({
        isPending: profileQuery.isPending,
        error: profileQuery.error,
        hasItems: Boolean(profile),
      })}
      hasMoreVideos={videosQuery.hasNextPage}
      isFetchingMoreVideos={videosQuery.isFetchingNextPage}
      onLoadMoreVideos={() => void videosQuery.fetchNextPage()}
      onRetryVideos={() => {
        void channelsQuery.refetch();
        void videosQuery.refetch();
      }}
      onRetryPlaylists={() => {
        void channelsQuery.refetch();
        void playlistsQuery.refetch();
      }}
      {...(playlistsEnabled ? { tabs: ['videos', 'playlists', 'about'] as const } : {})}
      {...(profileQuery.error ? { onRetry: () => void profileQuery.refetch() } : {})}
    />
  );
}
