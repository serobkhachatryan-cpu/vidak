'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, Heading, Skeleton, Text } from '@w3ds/ui';
import Link from 'next/link';
import { listImportedVideos } from './imported-video-api';

function providerName(provider: 'youtube' | 'vimeo'): string {
  return provider === 'youtube' ? 'YouTube' : 'Vimeo';
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        date,
      );
}

export function ImportedVideosLibrary() {
  const query = useQuery({
    queryKey: ['imported-channel-videos'],
    queryFn: listImportedVideos,
    retry: false,
  });

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading imported videos"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <EmptyState
        icon="!"
        title="Could not load imported videos"
        description="Refresh this page to try again."
      />
    );
  }

  if (query.data.length === 0) {
    return (
      <EmptyState
        icon="◌"
        title="No imported videos yet"
        description="Connect a YouTube or Vimeo channel in Settings. Vidak will add the authorised video catalogue here as it is scanned."
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {query.data.map((video) => (
        <Link
          key={video.id}
          href={`/watch/imported/${encodeURIComponent(video.id)}`}
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Card className="h-full overflow-hidden p-0 transition-shadow hover:shadow-md">
            <div className="aspect-video bg-muted">
              {video.thumbnailUrl ? (
                <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>
            <div className="space-y-2 p-4">
              <Text size="xs" tone="primary" className="font-semibold uppercase tracking-wide">
                From {providerName(video.provider)}
              </Text>
              <Heading as="h2" size="sm" className="line-clamp-2">
                {video.title}
              </Heading>
              <Text size="sm" tone="muted">
                {[
                  formatDate(video.publishedAt),
                  video.playbackStatus === 'embedded' ? 'Watch in Vidak' : 'Open on provider',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}
