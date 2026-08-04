import {
  useInfiniteQuery,
  useQuery,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { getNextPageParam, type VideoApiClient } from '@w3ds/api-client';
import type {
  Channel,
  ChannelId,
  Comment,
  CursorPage,
  PaginationParams,
  Playlist,
  PlaylistId,
  UserProfile,
  UserProfileId,
  Video,
  VideoId,
  VideoListFilters,
} from '@w3ds/types';

export const videoQueryKeys = {
  all: ['video'] as const,
  video: (id: VideoId) => [...videoQueryKeys.all, 'detail', id] as const,
  videos: (filters: VideoListFilters = {}) => [...videoQueryKeys.all, 'list', filters] as const,
  channel: (id: ChannelId) => [...videoQueryKeys.all, 'channel', id] as const,
  playlist: (id: PlaylistId) => [...videoQueryKeys.all, 'playlist', id] as const,
  userProfile: (id: UserProfileId) => [...videoQueryKeys.all, 'profile', id] as const,
  comments: (videoId: VideoId) => [...videoQueryKeys.all, 'comments', videoId] as const,
};

export function useVideo(
  client: VideoApiClient,
  id: VideoId,
  options: Omit<UseQueryOptions<Video | undefined>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: videoQueryKeys.video(id),
    queryFn: () => client.getVideo(id),
    ...options,
  });
}

export function useVideos(
  client: VideoApiClient,
  filters: VideoListFilters = {},
  pagination: PaginationParams = {},
  options: Omit<UseQueryOptions<CursorPage<Video>>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: [...videoQueryKeys.videos(filters), pagination] as const,
    queryFn: () => client.listVideos(filters, pagination),
    ...options,
  });
}

export function useInfiniteVideos(
  client: VideoApiClient,
  filters: VideoListFilters = {},
  pageSize = 20,
) {
  return useInfiniteQuery({
    queryKey: videoQueryKeys.videos(filters),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.listVideos(filters, { cursor: pageParam, limit: pageSize }),
    getNextPageParam,
  });
}

export function useChannel(
  client: VideoApiClient,
  id: ChannelId,
  options: Omit<UseQueryOptions<Channel | undefined>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: videoQueryKeys.channel(id),
    queryFn: () => client.getChannel(id),
    ...options,
  });
}

export function usePlaylist(
  client: VideoApiClient,
  id: PlaylistId,
  options: Omit<UseQueryOptions<Playlist | undefined>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: videoQueryKeys.playlist(id),
    queryFn: () => client.getPlaylist(id),
    ...options,
  });
}

export function useUserProfile(
  client: VideoApiClient,
  id: UserProfileId,
  options: Omit<UseQueryOptions<UserProfile | undefined>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: videoQueryKeys.userProfile(id),
    queryFn: () => client.getUserProfile(id),
    ...options,
  });
}

export function useInfiniteVideoComments(
  client: VideoApiClient,
  videoId: VideoId,
  pageSize = 20,
) {
  return useInfiniteQuery({
    queryKey: videoQueryKeys.comments(videoId),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.listComments(videoId, { cursor: pageParam, limit: pageSize }),
    getNextPageParam,
  });
}
