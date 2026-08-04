import { type UseQueryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VideoApiClient } from '@w3ds/api-client';
import type {
  ConnectedAccount,
  ConnectedAccountProvider,
  UpdateProfileInput,
  UpdateUserPreferencesInput,
  UploadAvatarInput,
  UserPreferences,
  UserProfileId,
} from '@w3ds/types';
import { videoQueryKeys } from './video-queries';

export const settingsQueryKeys = {
  all: ['settings'] as const,
  preferences: (id: UserProfileId) => [...settingsQueryKeys.all, 'preferences', id] as const,
  connectedAccounts: (id: UserProfileId) =>
    [...settingsQueryKeys.all, 'connected-accounts', id] as const,
  sessions: (userId: string) => [...settingsQueryKeys.all, 'sessions', userId] as const,
};

export function useUserPreferences(
  client: VideoApiClient,
  userId: UserProfileId,
  options: Omit<UseQueryOptions<UserPreferences>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: settingsQueryKeys.preferences(userId),
    queryFn: () => client.getUserPreferences(userId),
    ...options,
  });
}

export function useConnectedAccounts(
  client: VideoApiClient,
  userId: UserProfileId,
  options: Omit<UseQueryOptions<readonly ConnectedAccount[]>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery({
    queryKey: settingsQueryKeys.connectedAccounts(userId),
    queryFn: () => client.listConnectedAccounts(userId),
    ...options,
  });
}

export function useUpdateUserPreferences(client: VideoApiClient, userId: UserProfileId) {
  const queryClient = useQueryClient();
  const queryKey = settingsQueryKeys.preferences(userId);

  return useMutation({
    mutationFn: (input: UpdateUserPreferencesInput) => client.updateUserPreferences(userId, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<UserPreferences>(queryKey);
      if (previous) {
        queryClient.setQueryData<UserPreferences>(queryKey, {
          appearance: input.appearance ?? previous.appearance,
          language: input.language ?? previous.language,
          notifications: { ...previous.notifications, ...input.notifications },
          privacy: { ...previous.privacy, ...input.privacy },
        });
      }
      return previous ? { previous } : {};
    },
    onError: (_error, _input, context) => {
      if (context && 'previous' in context && context.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useUpdateUserProfile(client: VideoApiClient, userId: UserProfileId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) => client.updateUserProfile(userId, input),
    onSuccess: (profile) => {
      queryClient.setQueryData(videoQueryKeys.userProfile(userId), profile);
    },
  });
}

export function useUploadUserAvatar(client: VideoApiClient, userId: UserProfileId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadAvatarInput) => client.uploadUserAvatar(userId, input),
    onSuccess: (profile) => {
      queryClient.setQueryData(videoQueryKeys.userProfile(userId), profile);
    },
  });
}

export function useConnectAccount(client: VideoApiClient, userId: UserProfileId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: ConnectedAccountProvider) => client.connectAccount(userId, provider),
    onSuccess: (accounts) => {
      queryClient.setQueryData(settingsQueryKeys.connectedAccounts(userId), accounts);
    },
  });
}

export function useDisconnectAccount(client: VideoApiClient, userId: UserProfileId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: ConnectedAccountProvider) => client.disconnectAccount(userId, provider),
    onSuccess: (accounts) => {
      queryClient.setQueryData(settingsQueryKeys.connectedAccounts(userId), accounts);
    },
  });
}
