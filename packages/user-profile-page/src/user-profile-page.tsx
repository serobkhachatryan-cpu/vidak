'use client';

import type { Channel, Playlist, UserProfile, Video } from '@w3ds/types';
import {
  AppShell,
  type AppShellProps,
  EmptyState,
  ErrorState,
  Grid,
  Page,
  Skeleton,
  VideoCardSkeleton,
} from '@w3ds/ui';
import { type ReactNode, useId, useState } from 'react';
import { cx } from './styles';
import { UserProfileHeader, userProfileBannerClassName } from './user-profile-header';
import { AboutPanel, PlaylistsPanel, VideosPanel } from './user-profile-panels';
import { LoadingRegion, skeletonKeys, type UserProfileSectionState } from './user-profile-section';
import {
  type UserProfileTabId,
  UserProfileTabs,
  userProfilePanelId,
  userProfileTabId,
} from './user-profile-tabs';

/** The profile page and each of its sections share the same set of view states. */
export type UserProfilePageState = UserProfileSectionState;

export interface UserProfilePageProps {
  profile?: UserProfile;
  videos?: readonly Video[];
  channelsById?: Readonly<Record<string, Channel>>;
  playlists?: readonly Playlist[];
  /** Total uploaded videos attributed to this profile. Defaults to the loaded videos length. */
  videoCount?: number;
  state?: UserProfilePageState;
  videosState?: UserProfileSectionState;
  playlistsState?: UserProfileSectionState;
  activeTab?: UserProfileTabId;
  defaultTab?: UserProfileTabId;
  onTabChange?: (tab: UserProfileTabId) => void;
  following?: boolean;
  defaultFollowing?: boolean;
  onFollowingChange?: (following: boolean) => void;
  onShare?: () => void;
  errorTitle?: ReactNode;
  errorDescription?: ReactNode;
  onRetry?: () => void;
  onRetryVideos?: () => void;
  onRetryPlaylists?: () => void;
  onLoadMoreVideos?: () => void;
  hasMoreVideos?: boolean;
  isFetchingMoreVideos?: boolean;
  shell?: Omit<AppShellProps, 'children'>;
  theme?: 'light' | 'dark';
  className?: string;
}

function UserProfilePageSkeleton() {
  return (
    <LoadingRegion label="Loading profile">
      <div className="space-y-6">
        <Skeleton className={userProfileBannerClassName} />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Skeleton circle className="h-20 w-20 shrink-0 sm:h-28 sm:w-28" />
            <div className="space-y-2">
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-10 w-20" />
            <Skeleton className="h-10 w-10" />
          </div>
        </div>
        <Skeleton className="h-12 w-full" />
        <Grid columns={5} gap={6}>
          {skeletonKeys('profile-page-video', 10).map((key) => (
            <VideoCardSkeleton key={key} />
          ))}
        </Grid>
      </div>
    </LoadingRegion>
  );
}

export function UserProfilePage({
  profile,
  videos = [],
  channelsById = {},
  playlists = [],
  videoCount,
  state = profile ? 'ready' : 'empty',
  videosState = 'ready',
  playlistsState = 'ready',
  activeTab,
  defaultTab = 'videos',
  onTabChange,
  following,
  defaultFollowing = false,
  onFollowingChange,
  onShare,
  errorTitle = 'Could not load this profile',
  errorDescription = 'Please check your connection and try again.',
  onRetry,
  onRetryVideos,
  onRetryPlaylists,
  onLoadMoreVideos,
  hasMoreVideos,
  isFetchingMoreVideos,
  shell,
  theme,
  className,
}: UserProfilePageProps) {
  const scope = useId();
  const [selectedTab, setSelectedTab] = useState<UserProfileTabId>(defaultTab);
  const [ownFollowing, setOwnFollowing] = useState(defaultFollowing);
  const currentTab = activeTab ?? selectedTab;
  const isFollowing = following ?? ownFollowing;

  const changeTab = (tab: UserProfileTabId) => {
    if (activeTab === undefined) setSelectedTab(tab);
    onTabChange?.(tab);
  };

  const toggleFollowing = () => {
    const next = !isFollowing;
    if (following === undefined) setOwnFollowing(next);
    onFollowingChange?.(next);
  };

  const shareProfile = () => {
    if (onShare) {
      onShare();
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && profile) {
      void navigator.share({
        title: profile.displayName,
        text: `Check out @${profile.handle} on W3DS`,
        ...(typeof window !== 'undefined' ? { url: window.location.href } : {}),
      });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined') {
      void navigator.clipboard.writeText(window.location.href);
    }
  };

  // Mock interaction: the viewer's own follow is reflected optimistically.
  const followerCount = (profile?.subscriberCount ?? 0) + (isFollowing ? 1 : 0);
  const followingCount = profile?.followingCount ?? 0;
  const totalVideos = videoCount ?? videos.length;

  const content =
    state === 'loading' ? (
      <UserProfilePageSkeleton />
    ) : state === 'error' ? (
      <ErrorState
        title={errorTitle}
        description={errorDescription}
        {...(onRetry ? { retry: onRetry } : {})}
      />
    ) : state === 'empty' || !profile ? (
      <EmptyState
        icon="◌"
        title="Profile unavailable"
        description="This profile may have been removed or renamed."
      />
    ) : (
      <div className="space-y-6">
        <UserProfileHeader
          profile={profile}
          followerCount={followerCount}
          followingCount={followingCount}
          videoCount={totalVideos}
          following={isFollowing}
          onFollowToggle={toggleFollowing}
          onShare={shareProfile}
        />
        <UserProfileTabs scope={scope} activeTab={currentTab} onChange={changeTab} />
        <div
          role="tabpanel"
          id={userProfilePanelId(scope, currentTab)}
          aria-labelledby={userProfileTabId(scope, currentTab)}
        >
          {currentTab === 'videos' && (
            <VideosPanel
              videos={videos}
              channelsById={channelsById}
              state={videosState}
              onRetry={onRetryVideos}
              onLoadMore={onLoadMoreVideos}
              hasMore={hasMoreVideos}
              isFetchingMore={isFetchingMoreVideos}
            />
          )}
          {currentTab === 'playlists' && (
            <PlaylistsPanel
              playlists={playlists}
              state={playlistsState}
              onRetry={onRetryPlaylists}
            />
          )}
          {currentTab === 'about' && (
            <AboutPanel
              profile={profile}
              followerCount={followerCount}
              followingCount={followingCount}
              videoCount={totalVideos}
            />
          )}
        </div>
      </div>
    );

  const page = <Page containerSize="xl">{content}</Page>;

  return (
    <div data-theme={theme} className={cx(theme === 'dark' && 'dark', className)}>
      {shell ? <AppShell {...shell}>{page}</AppShell> : page}
    </div>
  );
}
