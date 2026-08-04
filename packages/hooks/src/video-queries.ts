import { type UseQueryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getNextPageParam, type VideoApiClient } from '@w3ds/api-client';
import type {
  Channel,
  ChannelId,
  Comment,
  CommentId,
  CommentListFilters,
  CursorPage,
  PaginationParams,
  Playlist,
  PlaylistId,
  SearchFilters,
  UserProfile,
  UserProfileId,
  Video,
  VideoId,
  VideoListFilters,
} from '@w3ds/types';

export const videoQueryKeys = {
  all: ['video'] as const,
  video: (id: VideoId) => [...videoQueryKeys.all, 'detail', id] as const,
  publicVideo: (publicVideoId: string) =>
    [...videoQueryKeys.all, 'public-detail', publicVideoId] as const,
  videos: (filters: VideoListFilters = {}) => [...videoQueryKeys.all, 'list', filters] as const,
  publicVideos: () => [...videoQueryKeys.all, 'public-list'] as const,
  channels: (filters: SearchFilters = {}) => [...videoQueryKeys.all, 'channels', filters] as const,
  playlists: (filters: SearchFilters = {}) =>
    [...videoQueryKeys.all, 'playlists', filters] as const,
  channel: (id: ChannelId) => [...videoQueryKeys.all, 'channel', id] as const,
  playlist: (id: PlaylistId) => [...videoQueryKeys.all, 'playlist', id] as const,
  userProfile: (id: UserProfileId) => [...videoQueryKeys.all, 'profile', id] as const,
  comments: (videoId: VideoId, filters: CommentListFilters = {}) =>
    [...videoQueryKeys.all, 'comments', videoId, filters] as const,
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
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listVideos(filters, {
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: pageSize,
      }),
    getNextPageParam,
  });
}

/** Anonymous public discovery (`published` + `public` only). */
export function useInfinitePublicVideos(client: VideoApiClient, pageSize = 20) {
  return useInfiniteQuery({
    queryKey: videoQueryKeys.publicVideos(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listPublicVideos({
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: pageSize,
      }),
    getNextPageParam,
  });
}

/**
 * Loads a published public/unlisted video by opaque `publicVideoId`.
 * Returns undefined (empty UI) for drafts, private, unpublished, or missing ids.
 */
export function usePublicVideo(
  client: VideoApiClient,
  publicVideoId: string,
  options: Omit<UseQueryOptions<Video | undefined>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: videoQueryKeys.publicVideo(publicVideoId),
    queryFn: () => client.getPublicVideo(publicVideoId),
    ...options,
  });
}

export function useInfiniteChannels(
  client: VideoApiClient,
  filters: SearchFilters = {},
  pageSize = 20,
) {
  return useInfiniteQuery({
    queryKey: videoQueryKeys.channels(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listChannels(filters, {
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: pageSize,
      }),
    getNextPageParam,
  });
}

export function useInfinitePlaylists(
  client: VideoApiClient,
  filters: SearchFilters = {},
  pageSize = 20,
) {
  return useInfiniteQuery({
    queryKey: videoQueryKeys.playlists(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listPlaylists(filters, {
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: pageSize,
      }),
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
  filters: CommentListFilters = {},
  pageSize = 20,
) {
  return useInfiniteQuery({
    queryKey: videoQueryKeys.comments(videoId, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listComments(videoId, filters, {
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: pageSize,
      }),
    getNextPageParam,
  });
}

export function useCommentReplies(
  client: VideoApiClient,
  videoId: VideoId,
  parentId: CommentId,
  options: Omit<UseQueryOptions<CursorPage<Comment>>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: [...videoQueryKeys.comments(videoId, { parentId }), 'replies'] as const,
    queryFn: () => client.listComments(videoId, { parentId }),
    ...options,
  });
}
