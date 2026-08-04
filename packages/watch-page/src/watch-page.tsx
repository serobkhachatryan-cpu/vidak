import type { VideoApiClient } from '@w3ds/api-client';
import { useChannel, useVideo, useVideos } from '@w3ds/hooks';
import type { Channel, Video, VideoId } from '@w3ds/types';
import {
  AppShell,
  type AppShellProps,
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Page,
  Skeleton,
  Tag,
  Text,
  VideoCard,
  VideoCardSkeleton,
} from '@w3ds/ui';
import type { ReactNode } from 'react';

const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ');

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        date,
      );
}

function metadata(video: Video): string {
  const date = formatDate(video.publishedAt);
  return [compactNumber.format(video.viewCount), 'views', date && `Uploaded ${date}`]
    .filter(Boolean)
    .join(' · ');
}

export type WatchPageState = 'ready' | 'loading' | 'empty' | 'error';

export interface WatchPageActions {
  onSubscribe?: () => void;
  onLike?: () => void;
  onDislike?: () => void;
  onShare?: () => void;
  onSave?: () => void;
}

export interface WatchPageProps {
  video?: Video;
  channel?: Channel;
  relatedVideos?: readonly Video[];
  relatedChannels?: Readonly<Record<string, Pick<Channel, 'name' | 'handle' | 'avatarUrl'>>>;
  state?: WatchPageState;
  errorTitle?: ReactNode;
  errorDescription?: ReactNode;
  onRetry?: () => void;
  actions?: WatchPageActions;
  subscribed?: boolean;
  shell?: Omit<AppShellProps, 'children'>;
  theme?: 'light' | 'dark';
  className?: string;
}

export interface WatchPageDataProps
  extends Omit<
    WatchPageProps,
    'channel' | 'relatedChannels' | 'relatedVideos' | 'state' | 'video'
  > {
  client: VideoApiClient;
  videoId: VideoId;
}

function VideoPlayerPlaceholder({ title }: { title: string }) {
  return (
    <section
      aria-label={`Video player for ${title}`}
      className="relative aspect-video overflow-hidden rounded-xl bg-black text-white shadow-sm"
    >
      <div
        className="absolute inset-0 bg-gradient-to-br from-primary/40 via-black/70 to-black"
        aria-hidden="true"
      />
      <div className="relative flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <span
          aria-hidden="true"
          className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 text-2xl backdrop-blur"
        >
          ▶
        </span>
        <p className="font-sans text-sm text-white/80">Video player placeholder</p>
      </div>
    </section>
  );
}

function WatchPageSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading video"
      className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]"
    >
      <div className="space-y-5">
        <Skeleton className="aspect-video w-full rounded-xl" />
        <Skeleton className="h-8 w-4/5" />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Skeleton circle className="h-12 w-12" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton className="h-10 w-24" />
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
      <aside aria-label="Loading related videos" className="space-y-4">
        {['player', 'title', 'channel', 'description'].map((skeleton) => (
          <VideoCardSkeleton key={skeleton} />
        ))}
      </aside>
    </div>
  );
}

function RelatedVideos({
  videos,
  channels,
}: {
  videos: readonly Video[];
  channels: WatchPageProps['relatedChannels'];
}) {
  return (
    <aside aria-labelledby="related-videos-heading" className="space-y-4">
      <Heading id="related-videos-heading" as="h2" size="lg">
        Up next
      </Heading>
      {videos.length === 0 ? (
        <Text tone="muted" size="sm">
          There are no related videos yet.
        </Text>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
          {videos.map((relatedVideo) => {
            const relatedChannel = channels?.[relatedVideo.channelId];
            return (
              <VideoCard
                key={relatedVideo.id}
                video={relatedVideo}
                {...(relatedChannel ? { channel: relatedChannel } : {})}
              />
            );
          })}
        </div>
      )}
    </aside>
  );
}

function WatchContent({
  video,
  channel,
  relatedVideos = [],
  relatedChannels,
  actions,
  subscribed = false,
}: Required<Pick<WatchPageProps, 'video'>> &
  Omit<
    WatchPageProps,
    | 'video'
    | 'state'
    | 'shell'
    | 'theme'
    | 'className'
    | 'errorTitle'
    | 'errorDescription'
    | 'onRetry'
  >) {
  const channelName = channel?.name ?? 'Unknown channel';
  const date = formatDate(video.publishedAt);

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-5">
        <VideoPlayerPlaceholder title={video.title} />
        <div>
          <Heading as="h1" size="xl">
            {video.title}
          </Heading>
          <Text size="sm" tone="muted" className="mt-2">
            {metadata(video)}
          </Text>
        </div>

        <div className="flex flex-col gap-4 border-y border-border py-4 sm:flex-row sm:items-center sm:justify-between">
          <a
            href={`/channel/${video.channelId}`}
            className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Avatar
              {...(channel?.avatarUrl ? { src: channel.avatarUrl } : {})}
              alt=""
              name={channelName}
              size="lg"
            />
            <span className="min-w-0">
              <span className="block truncate font-sans font-semibold text-foreground">
                {channelName}
              </span>
              <span className="block text-sm text-muted-foreground">
                {compactNumber.format(channel?.subscriberCount ?? 0)} subscribers
              </span>
            </span>
          </a>
          <Button
            variant={subscribed ? 'secondary' : 'primary'}
            onClick={actions?.onSubscribe}
            aria-pressed={subscribed}
          >
            {subscribed ? 'Subscribed' : 'Subscribe'}
          </Button>
        </div>

        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Video actions</legend>
          <Button
            variant="secondary"
            size="sm"
            onClick={actions?.onLike}
            aria-label={`Like (${compactNumber.format(video.likeCount)})`}
          >
            <span aria-hidden="true">👍</span> {compactNumber.format(video.likeCount)}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={actions?.onDislike}
            aria-label="Dislike video"
          >
            <span aria-hidden="true">👎</span>
            <span className="sr-only">Dislike</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={actions?.onShare}>
            <span aria-hidden="true">↗</span> Share
          </Button>
          <Button variant="secondary" size="sm" onClick={actions?.onSave}>
            <span aria-hidden="true">＋</span> Save
          </Button>
        </fieldset>

        <section aria-label="Video description" className="rounded-lg bg-surface-raised p-4">
          <Text size="sm" className="font-semibold">
            {compactNumber.format(video.viewCount)} views{date ? ` · Uploaded ${date}` : ''}
          </Text>
          <Text size="sm" className="mt-3 whitespace-pre-wrap">
            {video.description}
          </Text>
          {video.tags.length > 0 && (
            <ul aria-label="Video tags" className="mt-4 flex flex-wrap gap-2">
              {video.tags.map((tag) => (
                <li key={tag}>
                  <Tag>#{tag}</Tag>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <RelatedVideos videos={relatedVideos} channels={relatedChannels} />
    </div>
  );
}

export function WatchPage({
  video,
  channel,
  relatedVideos,
  relatedChannels,
  state = video ? 'ready' : 'empty',
  errorTitle = 'Could not load this video',
  errorDescription = 'Please check your connection and try again.',
  onRetry,
  actions,
  subscribed,
  shell,
  theme,
  className,
}: WatchPageProps) {
  const content =
    state === 'loading' ? (
      <WatchPageSkeleton />
    ) : state === 'error' ? (
      <ErrorState
        title={errorTitle}
        description={errorDescription}
        {...(onRetry ? { retry: onRetry } : {})}
      />
    ) : state === 'empty' || !video ? (
      <EmptyState
        icon="◌"
        title="Video unavailable"
        description="This video may have been removed or is private."
      />
    ) : (
      <WatchContent
        video={video}
        {...(channel ? { channel } : {})}
        {...(relatedVideos ? { relatedVideos } : {})}
        {...(relatedChannels ? { relatedChannels } : {})}
        {...(actions ? { actions } : {})}
        {...(subscribed === undefined ? {} : { subscribed })}
      />
    );

  return (
    <div data-theme={theme} className={cx(theme === 'dark' && 'dark', className)}>
      <AppShell {...shell}>
        <Page containerSize="full">{content}</Page>
      </AppShell>
    </div>
  );
}

export function WatchPageData({ client, videoId, ...props }: WatchPageDataProps) {
  const videoQuery = useVideo(client, videoId);
  const video = videoQuery.data;
  const channelQuery = useChannel(client, video?.channelId ?? '', { enabled: Boolean(video) });
  const relatedVideosQuery = useVideos(
    client,
    { status: 'published', visibility: 'public' },
    { limit: 8 },
    { enabled: Boolean(video) },
  );
  const relatedVideos = (relatedVideosQuery.data?.items ?? []).filter(
    (item) => item.id !== videoId,
  );

  return (
    <WatchPage
      {...props}
      {...(video ? { video } : {})}
      {...(channelQuery.data ? { channel: channelQuery.data } : {})}
      relatedVideos={relatedVideos}
      relatedChannels={channelQuery.data ? { [channelQuery.data.id]: channelQuery.data } : {}}
      state={
        videoQuery.isPending ? 'loading' : videoQuery.error ? 'error' : video ? 'ready' : 'empty'
      }
      {...(videoQuery.error ? { onRetry: () => void videoQuery.refetch() } : {})}
    />
  );
}
