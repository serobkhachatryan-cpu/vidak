'use client';

import { useQuery } from '@tanstack/react-query';
import { Button, Card, EmptyState, Heading, Page, Skeleton, Text } from '@w3ds/ui';
import Link from 'next/link';
import { ApplicationShell } from '../../components/application-shell';
import { getImportedVideo } from './imported-video-api';

function providerName(provider: 'youtube' | 'vimeo'): string {
  return provider === 'youtube' ? 'YouTube' : 'Vimeo';
}

function formatDuration(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const minutes = Math.floor(value / 60);
  const seconds = String(value % 60).padStart(2, '0');
  return `${String(minutes)}:${seconds}`;
}

export function ImportedVideoWatchPage({ videoId }: { videoId: string }) {
  const query = useQuery({
    queryKey: ['imported-channel-video', videoId],
    queryFn: () => getImportedVideo(videoId),
    retry: false,
  });

  return (
    <ApplicationShell currentHref="/library">
      <Page
        title={query.data?.title ?? 'Imported video'}
        description="A video from an authorised source channel."
        containerSize="xl"
      >
        {query.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label="Loading imported video"
            className="space-y-4"
          >
            <Skeleton className="aspect-video w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : query.isError || !query.data ? (
          <EmptyState
            icon="!"
            title="Imported video unavailable"
            description="The video may have been removed from the connected provider."
          />
        ) : (
          <div className="space-y-5">
            {query.data.playbackStatus === 'embedded' && query.data.embedUrl ? (
              <div className="aspect-video overflow-hidden rounded-md bg-black">
                <iframe
                  title={query.data.title}
                  src={query.data.embedUrl}
                  className="h-full w-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                  allowFullScreen
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
            ) : (
              <Card className="space-y-3">
                <Heading as="h2" size="md">
                  This video stays private on {providerName(query.data.provider)}.
                </Heading>
                <Text tone="muted">
                  Vidak did not copy or expose it. Open the provider while signed in to the account
                  that owns this channel.
                </Text>
                <a href={query.data.sourceUrl} target="_blank" rel="noreferrer">
                  <Button>Open on {providerName(query.data.provider)}</Button>
                </a>
              </Card>
            )}
            <div className="space-y-3">
              <Text size="sm" tone="primary" className="font-semibold uppercase tracking-wide">
                From {providerName(query.data.provider)} · {query.data.sourceVisibility}
              </Text>
              <Heading as="h1" size="lg">
                {query.data.title}
              </Heading>
              {formatDuration(query.data.durationSeconds) ? (
                <Text size="sm" tone="muted">
                  Duration {formatDuration(query.data.durationSeconds)}
                </Text>
              ) : null}
              {query.data.description ? (
                <Text className="max-w-3xl whitespace-pre-wrap">{query.data.description}</Text>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <a
                  href={query.data.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-semibold text-primary underline underline-offset-4"
                >
                  Open original
                </a>
                <Link
                  href="/library"
                  className="text-sm font-semibold text-primary underline underline-offset-4"
                >
                  Back to library
                </Link>
              </div>
            </div>
          </div>
        )}
      </Page>
    </ApplicationShell>
  );
}
