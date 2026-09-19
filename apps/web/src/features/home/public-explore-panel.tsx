'use client';

import { useInfinitePublicVideos } from '@w3ds/hooks';
import type { Video } from '@w3ds/types';
import {
  Button,
  EmptyState,
  ErrorState,
  Grid,
  Spinner,
  Text,
  VideoCard,
  VideoCardSkeleton,
} from '@w3ds/ui';
import { useEffect, useRef } from 'react';
import { videoApiClient } from '../../lib/video-api-client';

/** Public catalogue shared by the anonymous home and signed-in Explore tab. */
export function PublicExplorePanel() {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfinitePublicVideos(videoApiClient, 20);

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

  if (isPending) {
    return (
      <Grid columns={5} gap={6} aria-label="Loading public videos">
        {Array.from({ length: 10 }, (_, index) => (
          <VideoCardSkeleton key={index} />
        ))}
      </Grid>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load public videos"
        description="Public discovery is separate from your private library."
        retry={() => void refetch()}
      />
    );
  }

  if (videos.length === 0) {
    return (
      <EmptyState
        title="No public videos published in Vidak yet"
        description="This list contains videos people published publicly in Vidak. Link-only and private videos are not listed here."
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Refresh public catalogue
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Text size="sm" tone="muted">
          Public videos published in Vidak. Link-only and private videos are not listed here.
        </Text>
        <Button
          size="sm"
          variant="secondary"
          isLoading={isFetching}
          loadingText="Refreshing"
          onClick={() => void refetch()}
        >
          Refresh public catalogue
        </Button>
      </div>
      <Grid columns={5} gap={6}>
        {videos.map((video) => (
          <PublicVideoCard key={video.publicVideoId ?? video.id} video={video} />
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
  );
}

function PublicVideoCard({ video }: { video: Video }) {
  return <VideoCard video={video} {...(video.channel ? { channel: video.channel } : {})} />;
}
