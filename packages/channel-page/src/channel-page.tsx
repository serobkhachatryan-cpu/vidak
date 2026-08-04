'use client';

import type { VideoApiClient } from '@w3ds/api-client';
import { useChannel, useInfinitePlaylists, useInfiniteVideos, useUserProfile } from '@w3ds/hooks';
import type { Channel, ChannelId, Playlist, Video } from '@w3ds/types';
import {
  AppShell,
  type AppShellProps,
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Grid,
  Heading,
  Page,
  PlaylistSearchResult,
  SearchResultSkeleton,
  Skeleton,
  Text,
  VideoCard,
  VideoCardSkeleton,
} from '@w3ds/ui';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';

const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ');
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Uploads at or below this duration belong to the Shorts tab instead of the Videos tab. */
export const SHORT_MAX_DURATION_SECONDS = 60;

export type ChannelPageState = 'ready' | 'loading' | 'empty' | 'error';
export type ChannelSectionState = 'ready' | 'loading' | 'empty' | 'error';
export type ChannelTabId = 'videos' | 'shorts' | 'playlists' | 'about';

export const channelTabLabels: Record<ChannelTabId, string> = {
  videos: 'Videos',
  shorts: 'Shorts',
  playlists: 'Playlists',
  about: 'About',
};

const channelTabOrder = ['videos', 'shorts', 'playlists', 'about'] as const;

const skeletonKeys = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

function formatDate(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        date,
      );
}

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

function ChannelBanner({ channel }: { channel: Channel }) {
  const bannerSize = 'h-28 w-full rounded-xl sm:h-40 lg:h-56';
  return channel.bannerUrl ? (
    <img
      src={channel.bannerUrl}
      alt={`${channel.name} channel banner`}
      className={cx(bannerSize, 'object-cover')}
    />
  ) : (
    <div
      role="img"
      aria-label={`${channel.name} channel banner`}
      className={cx(
        bannerSize,
        'bg-gradient-to-r from-primary/40 via-primary/15 to-surface-raised',
      )}
    />
  );
}

function SubscribeButton({
  subscribed,
  onToggle,
  channelName,
}: {
  subscribed: boolean;
  onToggle: () => void;
  channelName: string;
}) {
  return (
    <Button
      variant={subscribed ? 'secondary' : 'primary'}
      onClick={onToggle}
      aria-pressed={subscribed}
      aria-label={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} ${channelName}`}
      className="shrink-0"
    >
      {subscribed ? 'Subscribed' : 'Subscribe'}
    </Button>
  );
}

function ChannelHeader({
  channel,
  isVerified,
  subscriberCount,
  subscribed,
  onSubscribeToggle,
}: {
  channel: Channel;
  isVerified: boolean;
  subscriberCount: number;
  subscribed: boolean;
  onSubscribeToggle: () => void;
}) {
  const summary = [
    `@${channel.handle}`,
    `${compactNumber.format(subscriberCount)} subscribers`,
    `${compactNumber.format(channel.videoCount)} videos`,
  ].join(' · ');

  return (
    <header className="space-y-4">
      <ChannelBanner channel={channel} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar
            {...(channel.avatarUrl ? { src: channel.avatarUrl } : {})}
            alt=""
            name={channel.name}
            size="xl"
            className="sm:h-28 sm:w-28 sm:text-2xl"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Heading as="h1" size="xl">
                {channel.name}
              </Heading>
              {isVerified && (
                <Badge tone="muted" aria-label="Verified channel">
                  <span aria-hidden="true" className="mr-1">
                    ✓
                  </span>
                  Verified
                </Badge>
              )}
            </div>
            <Text size="sm" tone="muted" className="mt-1">
              {summary}
            </Text>
            {channel.description && (
              <Text size="sm" tone="muted" className="mt-2 line-clamp-2 max-w-2xl">
                {channel.description}
              </Text>
            )}
          </div>
        </div>
        <SubscribeButton
          subscribed={subscribed}
          onToggle={onSubscribeToggle}
          channelName={channel.name}
        />
      </div>
    </header>
  );
}

function ChannelTabs({
  activeTab,
  onChange,
}: {
  activeTab: ChannelTabId;
  onChange: (tab: ChannelTabId) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const total = channelTabOrder.length;
    const current = channelTabOrder.indexOf(activeTab);
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % total
        : event.key === 'ArrowLeft'
          ? (current + total - 1) % total
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? total - 1
              : -1;
    const nextTab = next < 0 ? undefined : channelTabOrder[next];
    if (!nextTab) return;
    event.preventDefault();
    onChange(nextTab);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(next)?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Channel sections"
      onKeyDown={onKeyDown}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {channelTabOrder.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`channel-tab-${tab}`}
          aria-selected={activeTab === tab}
          aria-controls={`channel-panel-${tab}`}
          tabIndex={activeTab === tab ? 0 : -1}
          onClick={() => onChange(tab)}
          className={cx(
            'shrink-0 border-b-2 px-4 py-3 font-sans text-sm font-semibold transition-colors duration-fast',
            focusRing,
            activeTab === tab
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {channelTabLabels[tab]}
        </button>
      ))}
    </div>
  );
}

function LoadMoreUploads({
  label,
  onLoadMore,
  hasMore = false,
  isFetchingMore = false,
}: {
  label: string;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isFetchingMore?: boolean | undefined;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !onLoadMore || !hasMore || isFetchingMore) return;
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { rootMargin: '240px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, onLoadMore]);

  if (!hasMore && !isFetchingMore) return null;
  return (
    <div ref={sentinelRef} className="mt-6 flex justify-center" aria-live="polite">
      <Button variant="secondary" size="sm" onClick={onLoadMore} isLoading={isFetchingMore}>
        {label}
      </Button>
    </div>
  );
}

function ShortCard({ video }: { video: Video }) {
  const href = `/watch/${video.id}`;
  return (
    <article className="group min-w-0">
      <a
        href={href}
        aria-label={`Watch ${video.title}`}
        className={cx('block overflow-hidden rounded-lg bg-muted', focusRing)}
      >
        <img
          src={video.thumbnailUrl}
          alt=""
          loading="lazy"
          className="aspect-[9/16] w-full object-cover transition-transform duration-normal group-hover:scale-[1.03]"
        />
      </a>
      <a
        href={href}
        className={cx(
          'mt-2 line-clamp-2 block font-sans text-sm font-semibold text-foreground hover:text-primary',
          focusRing,
        )}
      >
        {video.title}
      </a>
      <p className="mt-1 font-sans text-xs text-muted-foreground">
        {compactNumber.format(video.viewCount)} views
      </p>
    </article>
  );
}

function ShortCardSkeleton() {
  return (
    <div role="status" aria-label="Loading short" className="min-w-0">
      <Skeleton className="aspect-[9/16] w-full" />
      <Skeleton className="mt-2 h-4 w-10/12" />
      <Skeleton className="mt-2 h-3 w-6/12" />
    </div>
  );
}

function VideosPanel({
  channel,
  videos,
  state,
  onRetry,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: {
  channel: Channel;
  videos: readonly Video[];
  state: ChannelSectionState;
  onRetry?: (() => void) | undefined;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isFetchingMore?: boolean | undefined;
}) {
  if (state === 'loading') {
    return (
      <Grid columns={4} gap={6} aria-label="Loading videos">
        {skeletonKeys('video', 8).map((key) => (
          <VideoCardSkeleton key={key} />
        ))}
      </Grid>
    );
  }
  if (state === 'error') {
    return (
      <ErrorState
        title="Could not load videos"
        description="Please check your connection and try again."
        {...(onRetry ? { retry: onRetry } : {})}
      />
    );
  }
  if (state === 'empty' || videos.length === 0) {
    return (
      <EmptyState
        icon="◌"
        title="No videos yet"
        description="Published videos from this channel will appear here."
      />
    );
  }
  return (
    <>
      <Grid columns={4} gap={6}>
        {videos.map((video) => (
          <VideoCard key={video.id} video={video} channel={channel} />
        ))}
      </Grid>
      <LoadMoreUploads
        label="Load more videos"
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isFetchingMore={isFetchingMore}
      />
    </>
  );
}

function ShortsPanel({
  shorts,
  state,
  onRetry,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: {
  shorts: readonly Video[];
  state: ChannelSectionState;
  onRetry?: (() => void) | undefined;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isFetchingMore?: boolean | undefined;
}) {
  const gridClassName = 'grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6';

  if (state === 'loading') {
    return (
      <div role="status" aria-label="Loading shorts" className={gridClassName}>
        {skeletonKeys('short', 6).map((key) => (
          <ShortCardSkeleton key={key} />
        ))}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <ErrorState
        title="Could not load shorts"
        description="Please check your connection and try again."
        {...(onRetry ? { retry: onRetry } : {})}
      />
    );
  }
  if (state === 'empty' || shorts.length === 0) {
    return (
      <EmptyState
        icon="▯"
        title="No shorts yet"
        description="Vertical videos up to a minute long will appear here."
      />
    );
  }
  return (
    <>
      <div className={gridClassName}>
        {shorts.map((short) => (
          <ShortCard key={short.id} video={short} />
        ))}
      </div>
      <LoadMoreUploads
        label="Load more shorts"
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isFetchingMore={isFetchingMore}
      />
    </>
  );
}

function PlaylistsPanel({
  playlists,
  state,
  onRetry,
}: {
  playlists: readonly Playlist[];
  state: ChannelSectionState;
  onRetry?: (() => void) | undefined;
}) {
  if (state === 'loading') {
    return (
      <Grid columns={2} gap={4} aria-label="Loading playlists">
        {skeletonKeys('playlist', 4).map((key) => (
          <SearchResultSkeleton key={key} type="playlists" />
        ))}
      </Grid>
    );
  }
  if (state === 'error') {
    return (
      <ErrorState
        title="Could not load playlists"
        description="Please check your connection and try again."
        {...(onRetry ? { retry: onRetry } : {})}
      />
    );
  }
  if (state === 'empty' || playlists.length === 0) {
    return (
      <EmptyState
        icon="≣"
        title="No playlists yet"
        description="Playlists created by this channel will appear here."
      />
    );
  }
  return (
    <Grid columns={2} gap={4}>
      {playlists.map((playlist) => (
        <PlaylistSearchResult key={playlist.id} playlist={playlist} />
      ))}
    </Grid>
  );
}

function AboutPanel({ channel, subscriberCount }: { channel: Channel; subscriberCount: number }) {
  const joinedAt = formatDate(channel.createdAt);
  const details = [
    { label: 'Handle', value: `@${channel.handle}` },
    { label: 'Subscribers', value: `${compactNumber.format(subscriberCount)} subscribers` },
    { label: 'Videos', value: `${compactNumber.format(channel.videoCount)} videos` },
    ...(joinedAt ? [{ label: 'Joined', value: joinedAt }] : []),
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-label="Channel description" className="rounded-lg bg-surface-raised p-4">
        <Heading as="h2" size="sm">
          Description
        </Heading>
        <Text size="sm" className="mt-3 whitespace-pre-wrap">
          {channel.description ?? 'This channel has not added a description yet.'}
        </Text>
      </section>
      <section aria-label="Channel details" className="rounded-lg bg-surface-raised p-4">
        <Heading as="h2" size="sm">
          Details
        </Heading>
        <dl className="mt-3 space-y-3">
          {details.map((detail) => (
            <div key={detail.label}>
              <dt className="font-sans text-xs uppercase tracking-wide text-muted-foreground">
                {detail.label}
              </dt>
              <dd className="font-sans text-sm text-foreground">{detail.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function ChannelPageSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading channel" className="space-y-6">
      <Skeleton className="h-28 w-full rounded-xl sm:h-40 lg:h-56" />
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
  const [selectedTab, setSelectedTab] = useState<ChannelTabId>(defaultTab);
  const [ownSubscribed, setOwnSubscribed] = useState(defaultSubscribed);
  const currentTab = activeTab ?? selectedTab;
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
        <ChannelTabs activeTab={currentTab} onChange={changeTab} />
        <div
          role="tabpanel"
          id={`channel-panel-${currentTab}`}
          aria-labelledby={`channel-tab-${currentTab}`}
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

export function ChannelPageData({ client, channelId, ...props }: ChannelPageDataProps) {
  const channelQuery = useChannel(client, channelId);
  const channel = channelQuery.data;
  const ownerQuery = useUserProfile(client, channel?.ownerId ?? '', {
    enabled: Boolean(channel),
  });
  const uploadsQuery = useInfiniteVideos(
    client,
    { channelId, status: 'published', visibility: 'public' },
    12,
  );
  const playlistsQuery = useInfinitePlaylists(client, {}, 24);

  const uploads = uploadsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const videos = uploads.filter((video) => video.durationSeconds > SHORT_MAX_DURATION_SECONDS);
  const shorts = uploads.filter((video) => video.durationSeconds <= SHORT_MAX_DURATION_SECONDS);
  const playlists = (playlistsQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (playlist) => playlist.channelId === channelId,
  );

  const uploadsState = (items: readonly Video[]): ChannelSectionState =>
    uploadsQuery.isPending
      ? 'loading'
      : uploadsQuery.error
        ? 'error'
        : items.length > 0
          ? 'ready'
          : 'empty';

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
      playlistsState={
        playlistsQuery.isPending
          ? 'loading'
          : playlistsQuery.error
            ? 'error'
            : playlists.length > 0
              ? 'ready'
              : 'empty'
      }
      state={
        channelQuery.isPending
          ? 'loading'
          : channelQuery.error
            ? 'error'
            : channel
              ? 'ready'
              : 'empty'
      }
      hasMoreUploads={uploadsQuery.hasNextPage}
      isFetchingMoreUploads={uploadsQuery.isFetchingNextPage}
      onLoadMoreUploads={() => void uploadsQuery.fetchNextPage()}
      onRetryUploads={() => void uploadsQuery.refetch()}
      onRetryPlaylists={() => void playlistsQuery.refetch()}
      {...(channelQuery.error ? { onRetry: () => void channelQuery.refetch() } : {})}
    />
  );
}
