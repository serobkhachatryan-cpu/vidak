'use client';

import { useChannel, useInfinitePublicVideos } from '@w3ds/hooks';
import type { Video } from '@w3ds/types';
import {
  Button,
  EmptyState,
  ErrorState,
  Grid,
  Page,
  Spinner,
  VidakLogo,
  VideoCard,
  VideoCardSkeleton,
} from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';

function FeedVideoCard({ video }: { video: Video }) {
  const { data: channel } = useChannel(videoApiClient, video.channelId);
  return <VideoCard video={video} {...(channel ? { channel } : {})} />;
}

function FeedGridSkeleton() {
  return (
    <Grid columns={5} gap={6} aria-label="Loading videos">
      {Array.from({ length: 10 }, (_, index) => (
        <VideoCardSkeleton key={index} />
      ))}
    </Grid>
  );
}

export function HomeFeed() {
  const router = useRouter();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage, isPending, refetch } =
    useInfinitePublicVideos(videoApiClient, 1);

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
    <ApplicationShell currentHref="/">
      <Page
        title="Home"
        description="Public videos people have chosen to share."
        containerSize="full"
      >
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
            icon={<VidakLogo title="" aria-hidden="true" className="h-12 w-auto text-foreground" />}
            title="Start with your videos"
            description="Find video you can access through your eVaults, or upload a video you want to keep private or publish."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => router.push('/your-videos')}>Find my videos</Button>
                <Button variant="secondary" onClick={() => router.push('/upload')}>
                  Upload a video
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <Grid columns={5} gap={6}>
              {videos.map((video) => (
                <FeedVideoCard key={video.publicVideoId ?? video.id} video={video} />
              ))}
            </Grid>
            <div
              ref={loadMoreRef}
              className="flex min-h-20 items-center justify-center"
              aria-live="polite"
            >
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
    </ApplicationShell>
  );
}
