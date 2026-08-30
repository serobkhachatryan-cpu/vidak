'use client';

import type { Channel, Playlist, Video } from '@w3ds/types';
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
import { ChannelHeader, channelBannerClassName } from './channel-header';
import { AboutPanel, PlaylistsPanel, ShortsPanel, VideosPanel } from './channel-panels';
import { type ChannelSectionState, LoadingRegion, skeletonKeys } from './channel-section';
import {
  type ChannelTabId,
  ChannelTabs,
  channelCatalogueTabOrder,
  channelPanelId,
  channelTabId,
} from './channel-tabs';
import { cx } from './styles';

/** The channel page and each of its sections share the same set of view states. */
export type ChannelPageState = ChannelSectionState;

export interface ChannelPageProps {
  channel?: Channel;
  /** Renders the verified badge next to the channel name. */
  isVerified?: boolean;
  videos?: readonly Video[];
  shorts?: readonly Video[];
  playlists?: readonly Playlist[];
  state?: ChannelPageState;
  videosState?: ChannelSectionState;
  shortsState?: ChannelSectionState;
  playlistsState?: ChannelSectionState;
  activeTab?: ChannelTabId;
  defaultTab?: ChannelTabId;
  tabs?: readonly ChannelTabId[];
  onTabChange?: (tab: ChannelTabId) => void;
  subscribed?: boolean;
  defaultSubscribed?: boolean;
  onSubscribedChange?: (subscribed: boolean) => void;
  errorTitle?: ReactNode;
  errorDescription?: ReactNode;
  onRetry?: () => void;
  onRetryUploads?: () => void;
  onRetryPlaylists?: () => void;
  onLoadMoreUploads?: () => void;
  hasMoreUploads?: boolean;
  isFetchingMoreUploads?: boolean;
  shell?: Omit<AppShellProps, 'children'>;
  theme?: 'light' | 'dark';
  className?: string;
}

function ChannelPageSkeleton() {
  return (
    <LoadingRegion label="Loading channel">
      <div className="space-y-6">
        <Skeleton className={channelBannerClassName} />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Skeleton circle className="h-20 w-20 shrink-0 sm:h-28 sm:w-28" />
            <div className="space-y-2">
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
          <Skeleton className="h-10 w-28" />
        </div>
        <Skeleton className="h-12 w-full" />
        <Grid columns={4} gap={6}>
          {skeletonKeys('channel-video', 8).map((key) => (
            <VideoCardSkeleton key={key} />
          ))}
        </Grid>
      </div>
    </LoadingRegion>
  );
}

export function ChannelPage({
  channel,
  isVerified = false,
  videos = [],
  shorts = [],
  playlists = [],
  state = channel ? 'ready' : 'empty',
  videosState = 'ready',
  shortsState = 'ready',
  playlistsState = 'ready',
  activeTab,
  defaultTab = 'videos',
  tabs = channelCatalogueTabOrder,
  onTabChange,
  subscribed,
  defaultSubscribed = false,
  onSubscribedChange,
  errorTitle = 'Could not load this channel',
  errorDescription = 'Please check your connection and try again.',
  onRetry,
  onRetryUploads,
  onRetryPlaylists,
  onLoadMoreUploads,
  hasMoreUploads,
  isFetchingMoreUploads,
  shell,
  theme,
  className,
}: ChannelPageProps) {
  const scope = useId();
  const [selectedTab, setSelectedTab] = useState<ChannelTabId>(defaultTab);
  const [ownSubscribed, setOwnSubscribed] = useState(defaultSubscribed);
  const currentTab =
    (tabs.includes(activeTab ?? selectedTab) ? (activeTab ?? selectedTab) : tabs[0]) ?? 'videos';
  const isSubscribed = subscribed ?? ownSubscribed;

  const changeTab = (tab: ChannelTabId) => {
    if (activeTab === undefined) setSelectedTab(tab);
    onTabChange?.(tab);
  };

  const toggleSubscription = () => {
    const next = !isSubscribed;
    if (subscribed === undefined) setOwnSubscribed(next);
    onSubscribedChange?.(next);
  };

  // Mock interaction: the viewer's own subscription is reflected optimistically.
  const subscriberCount = (channel?.subscriberCount ?? 0) + (isSubscribed ? 1 : 0);

  const content =
    state === 'loading' ? (
      <ChannelPageSkeleton />
    ) : state === 'error' ? (
      <ErrorState
        title={errorTitle}
        description={errorDescription}
        {...(onRetry ? { retry: onRetry } : {})}
      />
    ) : state === 'empty' || !channel ? (
      <EmptyState
        icon="◌"
        title="Channel unavailable"
        description="This channel may have been removed or renamed."
      />
    ) : (
      <div className="space-y-6">
        <ChannelHeader
          channel={channel}
          isVerified={isVerified}
          subscriberCount={subscriberCount}
          subscribed={isSubscribed}
          onSubscribeToggle={toggleSubscription}
        />
        <ChannelTabs scope={scope} activeTab={currentTab} onChange={changeTab} tabs={tabs} />
        <div
          role="tabpanel"
          id={channelPanelId(scope, currentTab)}
          aria-labelledby={channelTabId(scope, currentTab)}
        >
          {currentTab === 'videos' && (
            <VideosPanel
              channel={channel}
              videos={videos}
              state={videosState}
              onRetry={onRetryUploads}
              onLoadMore={onLoadMoreUploads}
              hasMore={hasMoreUploads}
              isFetchingMore={isFetchingMoreUploads}
            />
          )}
          {currentTab === 'shorts' && (
            <ShortsPanel
              shorts={shorts}
              state={shortsState}
              onRetry={onRetryUploads}
              onLoadMore={onLoadMoreUploads}
              hasMore={hasMoreUploads}
              isFetchingMore={isFetchingMoreUploads}
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
            <AboutPanel channel={channel} subscriberCount={subscriberCount} />
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
