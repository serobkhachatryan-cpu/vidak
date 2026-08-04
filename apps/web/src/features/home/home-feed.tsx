'use client';

import { useChannel, useInfiniteVideos } from '@w3ds/hooks';
import {
  AppShell,
  Button,
  EmptyState,
  ErrorState,
  Grid,
  Header,
  Page,
  Sidebar,
  Spinner,
  VideoCard,
  VideoCardSkeleton,
} from '@w3ds/ui';
import type { Video } from '@w3ds/types';
import { useEffect, useRef, useState } from 'react';
import { videoApiClient } from '../../lib/video-api-client';

const navigation = [
  { label: 'Home', href: '/', current: true, icon: '⌂' },
  { label: 'Subscriptions', href: '/subscriptions', icon: '◉' },
  { label: 'Library', href: '/library', icon: '▣' },
];

function FeedVideoCard({ video }: { video: Video }) {
  const { data: channel } = useChannel(videoApiClient, video.channelId);
  return <VideoCard video={video} {...(channel ? { channel } : {})} />;
}

function FeedGridSkeleton() {
  return (
    <Grid columns={5} gap={6} aria-label="Loading videos">
      {Array.from({ length: 10 }, (_, index) => <VideoCardSkeleton key={index} />)}
    </Grid>
  );
}

export function HomeFeed() {
  const [darkMode, setDarkMode] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteVideos(videoApiClient, { status: 'published', visibility: 'public' }, 1);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [darkMode]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void fetchNextPage();
      },
      { rootMargin: '240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const videos = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <AppShell
      header={
        <Header
          brand={<a href="/" className="rounded font-sans text-lg font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">W3DS Video</a>}
          onMenuClick={() => setMobileNavigationOpen(true)}
          actions={
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={darkMode}
              aria-label={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
              onClick={() => setDarkMode((current) => !current)}
            >
              {darkMode ? 'Light mode' : 'Dark mode'}
            </Button>
          }
        />
      }
      sidebar={<Sidebar items={navigation} />}
      mobileNavigation={<Sidebar items={navigation} />}
      mobileNavigationOpen={mobileNavigationOpen}
      onMobileNavigationClose={() => setMobileNavigationOpen(false)}
      mobileNavigationTitle="Browse"
    >
      <Page title="Home" description="Fresh videos from the W3DS community." containerSize="full">
        {isPending ? (
          <FeedGridSkeleton />
        ) : error ? (
          <ErrorState
            title="Could not load videos"
            description="Please check your connection and try again."
            retry={() => void refetch()}
          />
        ) : videos.length === 0 ? (
          <EmptyState
            icon="◌"
            title="No videos to show"
            description="New public videos will appear here."
          />
        ) : (
          <>
            <Grid columns={5} gap={6}>
              {videos.map((video) => <FeedVideoCard key={video.id} video={video} />)}
            </Grid>
            <div ref={loadMoreRef} className="flex min-h-20 items-center justify-center" aria-live="polite">
              {isFetchingNextPage && (
                <span className="flex items-center gap-2 font-sans text-sm text-muted-foreground">
                  <Spinner size="sm" aria-hidden="true" />
                  Loading more videos
                </span>
              )}
            </div>
          </>
        )}
      </Page>
    </AppShell>
  );
}
