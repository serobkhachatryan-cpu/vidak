'use client';

import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { isPublicVideoId, type VideoApiClient, videoProductSurfaceEnabled } from '@w3ds/api-client';
import { useInfiniteVideoComments, usePublicVideo, useVideo, videoQueryKeys } from '@w3ds/hooks';
import type {
  Channel,
  Comment,
  CommentId,
  CommentReaction,
  CommentRichText,
  CommentSort,
  PublicChannelProjection,
  Video,
  VideoId,
  VideoMediaRendition,
} from '@w3ds/types';
import { presentPublicChannel } from '@w3ds/types';
import {
  AppShell,
  type AppShellProps,
  Avatar,
  Button,
  Comments,
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPublicViewRecorder, replacePublicVideoInPages } from './meaningful-playback';

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
  onComment?: (body: string, richText: readonly CommentRichText[]) => void | Promise<void>;
  onReply?: (
    comment: Comment,
    body: string,
    richText: readonly CommentRichText[],
  ) => void | Promise<void>;
  onCommentReaction?: (comment: Comment, reaction: CommentReaction | undefined) => void;
}

export interface WatchPageProps {
  video?: Video;
  channel?:
    | PublicChannelProjection
    | Pick<Channel, 'name' | 'handle' | 'avatarUrl' | 'subscriberCount' | 'id'>;
  /** Same-origin public or owner media content path for playable bytes. */
  mediaSrc?: string;
  mediaState?: 'loading' | 'ready' | 'error';
  relatedVideos?: readonly Video[];
  relatedChannels?: Readonly<Record<string, Pick<Channel, 'name' | 'handle' | 'avatarUrl' | 'id'>>>;
  onMeaningfulPlayback?: (currentTime: number, duration: number) => void;
  onRetryMedia?: () => void;
  onBrowseVideos?: () => void;
  onPlaybackHelp?: () => void;
  state?: WatchPageState;
  errorTitle?: ReactNode;
  errorDescription?: ReactNode;
  onRetry?: () => void;
  actions?: WatchPageActions;
  subscribed?: boolean;
  comments?: readonly Comment[];
  commentAuthors?: Readonly<
    Record<
      string,
      { displayName: string; handle: string; avatarUrl?: string; isVerified: boolean } | undefined
    >
  >;
  commentReplies?: Readonly<Record<CommentId, readonly Comment[] | undefined>>;
  commentsState?: 'ready' | 'loading' | 'empty' | 'error' | 'unavailable';
  commentSort?: CommentSort;
  onCommentSortChange?: (sort: CommentSort) => void;
  onLoadMoreComments?: () => void;
  hasMoreComments?: boolean;
  isFetchingMoreComments?: boolean;
  onLoadCommentReplies?: (comment: Comment) => void;
  onRetryComments?: () => void;
  shell?: Omit<AppShellProps, 'children'>;
  theme?: 'light' | 'dark';
  className?: string;
}

export interface WatchPageDataProps
  extends Omit<
    WatchPageProps,
    | 'channel'
    | 'relatedChannels'
    | 'relatedVideos'
    | 'state'
    | 'video'
    | 'mediaSrc'
    | 'mediaState'
    | 'onRetryMedia'
  > {
  client: VideoApiClient;
  videoId: VideoId;
}

function buildQualityOptions(
  mediaSrc?: string,
  renditions: readonly VideoMediaRendition[] = [],
): readonly VideoMediaRendition[] {
  const options = renditions.filter((rendition) => rendition.mediaContentUrl.trim());
  if (options.length > 0) return options;
  return mediaSrc
    ? [
        {
          id: 'original',
          label: 'Original',
          kind: 'original',
          mediaContentUrl: mediaSrc,
          isDefault: true,
        },
      ]
    : [];
}

function formatQualityLabel(rendition: VideoMediaRendition): string {
  const contentType = rendition.contentType?.replace(/^video\//, '').toUpperCase();
  const height = rendition.height ? `${rendition.height}p` : undefined;
  return [rendition.label, height, contentType].filter(Boolean).join(' · ');
}

const playbackSpeeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3] as const;

function formatPlaybackSpeed(speed: number): string {
  return `${String(speed)}x`;
}

function VideoQualityMenu({
  qualityOptions,
  selectedQualityId,
  onQualityChange,
}: {
  qualityOptions: readonly VideoMediaRendition[];
  selectedQualityId: string;
  onQualityChange: (qualityId: string) => void;
}) {
  const automaticQuality =
    qualityOptions.find((rendition) => rendition.isDefault) ?? qualityOptions[0];
  if (!automaticQuality) return null;
  if (qualityOptions.length === 1) {
    return (
      <div
        className="flex h-9 items-center gap-2 rounded-md bg-black/80 px-3 font-sans text-xs font-semibold text-white shadow-sm backdrop-blur"
        data-testid="video-quality-indicator"
      >
        <span>Quality</span>
        <span className="text-white/70">{formatQualityLabel(automaticQuality)}</span>
      </div>
    );
  }

  const selectedQuality =
    selectedQualityId === 'auto'
      ? automaticQuality
      : (qualityOptions.find((rendition) => rendition.id === selectedQualityId) ??
        automaticQuality);
  const chooseQuality = (qualityId: string, target: HTMLElement) => {
    onQualityChange(qualityId);
    target.closest('details')?.removeAttribute('open');
  };

  return (
    <details className="relative">
      <summary
        aria-label="Video quality"
        className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md bg-black/80 px-3 font-sans text-xs font-semibold text-white shadow-sm backdrop-blur hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white [&::-webkit-details-marker]:hidden"
        data-testid="video-quality-menu-toggle"
      >
        <span>Quality</span>
        <span className="text-white/70">
          {selectedQualityId === 'auto' ? 'Auto' : formatQualityLabel(selectedQuality)}
        </span>
      </summary>
      <div
        role="menu"
        className="absolute top-11 right-0 w-56 overflow-hidden rounded-lg bg-zinc-800 py-1 text-sm text-white shadow-xl ring-1 ring-white/15"
        data-testid="video-quality-menu"
      >
        <p className="border-b border-white/15 px-4 py-3 font-sans text-sm font-semibold">
          Quality
        </p>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selectedQualityId === 'auto'}
          onClick={(event) => chooseQuality('auto', event.currentTarget)}
          className={cx(
            'flex w-full items-center justify-between px-4 py-3 text-left font-sans hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
            selectedQualityId === 'auto' && 'bg-white/15',
          )}
        >
          <span>Auto</span>
          <span className="text-xs text-white/60">Default</span>
        </button>
        <hr className="my-1 border-white/10" />
        {qualityOptions.map((rendition) => (
          <button
            key={rendition.id}
            type="button"
            role="menuitemradio"
            aria-checked={rendition.id === selectedQuality.id && selectedQualityId !== 'auto'}
            onClick={(event) => chooseQuality(rendition.id, event.currentTarget)}
            className="flex w-full items-center justify-between px-4 py-3 text-left font-sans hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
          >
            <span>{formatQualityLabel(rendition)}</span>
            <span className="text-xs text-white/60">
              {rendition.isDefault ? 'Default' : 'Available'}
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}

function VideoPlaybackSpeedMenu({
  playbackSpeed,
  onPlaybackSpeedChange,
}: {
  playbackSpeed: number;
  onPlaybackSpeedChange: (speed: number) => void;
}) {
  const choosePlaybackSpeed = (speed: number, target: HTMLElement) => {
    onPlaybackSpeedChange(speed);
    target.closest('details')?.removeAttribute('open');
  };

  return (
    <details className="relative">
      <summary
        aria-label="Playback speed"
        className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md bg-black/80 px-3 font-sans text-xs font-semibold text-white shadow-sm backdrop-blur hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white [&::-webkit-details-marker]:hidden"
        data-testid="video-playback-speed-menu-toggle"
      >
        <span>Speed</span>
        <span className="text-white/70">{formatPlaybackSpeed(playbackSpeed)}</span>
      </summary>
      <div
        role="menu"
        className="absolute top-11 right-0 w-44 overflow-hidden rounded-lg bg-zinc-800 py-1 text-sm text-white shadow-xl ring-1 ring-white/15"
        data-testid="video-playback-speed-menu"
      >
        <p className="border-b border-white/15 px-4 py-3 font-sans text-sm font-semibold">
          Playback speed
        </p>
        {playbackSpeeds.map((speed) => {
          const isSelected = speed === playbackSpeed;
          return (
            <button
              key={speed}
              type="button"
              role="menuitemradio"
              aria-checked={isSelected}
              onClick={(event) => choosePlaybackSpeed(speed, event.currentTarget)}
              className={cx(
                'flex w-full items-center justify-between px-4 py-3 text-left font-sans hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
                isSelected && 'bg-white/15',
              )}
            >
              <span>{formatPlaybackSpeed(speed)}</span>
              {speed === 1 && <span className="text-xs text-white/60">Normal</span>}
            </button>
          );
        })}
      </div>
    </details>
  );
}

function VideoPlayer({
  title,
  mediaSrc,
  mediaState,
  mediaRenditions,
  onMeaningfulPlayback,
  onRetryMedia,
  onBrowseVideos,
  onPlaybackHelp,
}: {
  title: string;
  mediaSrc?: string;
  mediaState?: 'loading' | 'ready' | 'error';
  mediaRenditions?: readonly VideoMediaRendition[];
  onMeaningfulPlayback?: (currentTime: number, duration: number) => void;
  onRetryMedia?: () => void;
  onBrowseVideos?: () => void;
  onPlaybackHelp?: () => void;
}) {
  const qualityOptions = useMemo(
    () => buildQualityOptions(mediaSrc, mediaRenditions),
    [mediaSrc, mediaRenditions],
  );
  const automaticQuality =
    qualityOptions.find((rendition) => rendition.isDefault) ?? qualityOptions[0];
  const [selectedQualityId, setSelectedQualityId] = useState('auto');
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [measuredQualityHeights, setMeasuredQualityHeights] = useState<Record<string, number>>({});
  const [failedPlaybackSource, setFailedPlaybackSource] = useState<string | undefined>();
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const qualityOptionsForMenu = useMemo(
    () =>
      qualityOptions.map((rendition) => {
        const height = measuredQualityHeights[rendition.id];
        return height ? { ...rendition, height } : rendition;
      }),
    [measuredQualityHeights, qualityOptions],
  );

  useEffect(() => {
    if (
      selectedQualityId !== 'auto' &&
      !qualityOptions.some((rendition) => rendition.id === selectedQualityId)
    ) {
      setSelectedQualityId('auto');
    }
  }, [qualityOptions, selectedQualityId]);

  const selectedQuality =
    selectedQualityId === 'auto'
      ? automaticQuality
      : (qualityOptions.find((rendition) => rendition.id === selectedQualityId) ??
        automaticQuality);
  const selectedMediaSrc = selectedQuality?.mediaContentUrl ?? mediaSrc;
  const playbackError = Boolean(failedPlaybackSource) && failedPlaybackSource === selectedMediaSrc;
  const playbackSrc = selectedMediaSrc
    ? withPlaybackAttempt(selectedMediaSrc, playbackAttempt)
    : undefined;
  const changePlaybackSpeed = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) videoRef.current.playbackRate = speed;
  };

  const retryPlayback = () => {
    setFailedPlaybackSource(undefined);
    setPlaybackAttempt((attempt) => attempt + 1);
    onRetryMedia?.();
  };

  if (mediaState === 'loading') {
    return (
      <PlayerMessage
        title={title}
        testId="public-video-player-loading"
        heading="Preparing video…"
        description="Vidak is preparing the public playback source."
      />
    );
  }

  if (mediaState === 'error') {
    return (
      <PlayerMessage
        title={title}
        testId="public-video-player-error"
        heading="Could not prepare this video"
        description="The public playback source could not be refreshed. Try again, or get help if the problem continues."
        actions={
          <PlaybackRecoveryActions
            retryLabel="Retry video"
            onRetry={onRetryMedia}
            onBrowseVideos={onBrowseVideos}
            onPlaybackHelp={onPlaybackHelp}
          />
        }
      />
    );
  }

  if (playbackError) {
    return (
      <PlayerMessage
        title={title}
        testId="public-video-player-error"
        heading="Could not play this video"
        description="The public playback source did not respond. Retry playback once, or get help if the problem continues."
        actions={
          <PlaybackRecoveryActions
            retryLabel="Retry playback"
            onRetry={retryPlayback}
            onBrowseVideos={onBrowseVideos}
            onPlaybackHelp={onPlaybackHelp}
          />
        }
      />
    );
  }

  if (playbackSrc) {
    return (
      <section
        aria-label={`Video player for ${title}`}
        className="relative aspect-video rounded-xl bg-black text-white shadow-sm"
      >
        <div className="absolute inset-0 overflow-hidden rounded-xl">
          <video
            key={playbackSrc}
            ref={videoRef}
            className="h-full w-full"
            controls
            playsInline
            preload="metadata"
            src={playbackSrc}
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = playbackSpeed;
              const height = event.currentTarget.videoHeight;
              if (!height || !selectedQuality) return;
              setMeasuredQualityHeights((current) =>
                current[selectedQuality.id] === height
                  ? current
                  : { ...current, [selectedQuality.id]: height },
              );
            }}
            onTimeUpdate={(event) => {
              onMeaningfulPlayback?.(event.currentTarget.currentTime, event.currentTarget.duration);
            }}
            onEnded={(event) => {
              onMeaningfulPlayback?.(event.currentTarget.currentTime, event.currentTarget.duration);
            }}
            onError={() => setFailedPlaybackSource(selectedMediaSrc)}
            data-testid="public-video-player"
          >
            <track kind="captions" />
          </video>
        </div>
        <div className="absolute top-3 right-3 z-10 flex items-start gap-2">
          <VideoPlaybackSpeedMenu
            playbackSpeed={playbackSpeed}
            onPlaybackSpeedChange={changePlaybackSpeed}
          />
          {qualityOptions.length > 0 && (
            <VideoQualityMenu
              qualityOptions={qualityOptionsForMenu}
              selectedQualityId={selectedQualityId}
              onQualityChange={setSelectedQualityId}
            />
          )}
        </div>
      </section>
    );
  }

  return (
    <PlayerMessage
      title={title}
      testId="public-video-player-unavailable"
      heading="This video has no playable media"
      description="Vidak has no public playback source for this video."
      actions={
        <PlaybackRecoveryActions onBrowseVideos={onBrowseVideos} onPlaybackHelp={onPlaybackHelp} />
      }
    />
  );
}

function withPlaybackAttempt(source: string, attempt: number): string {
  const [path, fragment] = source.split('#', 2);
  const separator = path?.includes('?') ? '&' : '?';
  return `${path ?? source}${separator}attempt=${attempt}${fragment ? `#${fragment}` : ''}`;
}

function PlaybackRecoveryActions({
  retryLabel,
  onRetry,
  onBrowseVideos,
  onPlaybackHelp,
}: {
  retryLabel?: string | undefined;
  onRetry?: (() => void) | undefined;
  onBrowseVideos?: (() => void) | undefined;
  onPlaybackHelp?: (() => void) | undefined;
}) {
  if (!onRetry && !onBrowseVideos && !onPlaybackHelp) return null;
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel ?? 'Try again'}
        </Button>
      ) : null}
      {onBrowseVideos ? (
        <Button variant="ghost" onClick={onBrowseVideos}>
          Browse public videos
        </Button>
      ) : null}
      {onPlaybackHelp ? (
        <Button variant="ghost" onClick={onPlaybackHelp}>
          Get help with playback
        </Button>
      ) : null}
    </div>
  );
}

function PlayerMessage({
  title,
  testId,
  heading,
  description,
  actions,
}: {
  title: string;
  testId: string;
  heading: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <section
      aria-label={`Video player for ${title}`}
      className="relative aspect-video overflow-hidden rounded-xl bg-black text-white shadow-sm"
      data-testid={testId}
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
        <div className="space-y-1">
          <p className="font-sans font-semibold text-white">{heading}</p>
          <p className="font-sans text-sm text-white/80">{description}</p>
        </div>
        {actions}
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
            const relatedChannel = channels?.[relatedVideo.channelId] ?? relatedVideo.channel;
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
  mediaSrc,
  mediaState,
  relatedVideos = [],
  relatedChannels,
  onMeaningfulPlayback,
  onRetryMedia,
  onBrowseVideos,
  onPlaybackHelp,
  actions,
  subscribed = false,
  comments = [],
  commentAuthors,
  commentReplies,
  commentsState = 'ready',
  commentSort,
  onCommentSortChange,
  onLoadMoreComments,
  hasMoreComments,
  isFetchingMoreComments,
  onLoadCommentReplies,
  onRetryComments,
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
  const resolvedChannel = channel ?? video.channel;
  const presentation = presentPublicChannel(resolvedChannel);
  const channelName = presentation.label;
  const date = formatDate(video.publishedAt);
  const channelHref = presentation.href;
  const hasRealChannel = Boolean(presentation.href);

  const channelIdentity = (
    <>
      <Avatar
        {...(resolvedChannel?.avatarUrl ? { src: resolvedChannel.avatarUrl } : {})}
        alt=""
        name={channelName}
        size="lg"
      />
      <span className="min-w-0">
        <span className="block truncate font-sans font-semibold text-foreground">
          {channelName}
        </span>
        {hasRealChannel ? (
          <span className="block text-sm text-muted-foreground">
            {compactNumber.format(
              typeof resolvedChannel?.subscriberCount === 'number'
                ? resolvedChannel.subscriberCount
                : 0,
            )}{' '}
            subscribers
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-5">
        <VideoPlayer
          title={video.title}
          {...(mediaSrc !== undefined ? { mediaSrc } : {})}
          {...(mediaState ? { mediaState } : {})}
          {...(video.mediaRenditions ? { mediaRenditions: video.mediaRenditions } : {})}
          {...(onMeaningfulPlayback ? { onMeaningfulPlayback } : {})}
          {...(onRetryMedia ? { onRetryMedia } : {})}
          {...(onBrowseVideos ? { onBrowseVideos } : {})}
          {...(onPlaybackHelp ? { onPlaybackHelp } : {})}
        />
        <div>
          <Heading as="h1" size="xl">
            {video.title}
          </Heading>
          <Text size="sm" tone="muted" className="mt-2">
            {metadata(video)}
          </Text>
        </div>

        <div className="flex flex-col gap-4 border-y border-border py-4 sm:flex-row sm:items-center sm:justify-between">
          {channelHref ? (
            <a
              href={channelHref}
              className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {channelIdentity}
            </a>
          ) : (
            <div className="flex min-w-0 items-center gap-3">{channelIdentity}</div>
          )}
          {actions?.onSubscribe ? (
            <Button
              variant={subscribed ? 'secondary' : 'primary'}
              onClick={actions.onSubscribe}
              aria-pressed={subscribed}
            >
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </Button>
          ) : null}
        </div>

        {actions?.onLike || actions?.onDislike || actions?.onShare || actions?.onSave ? (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Video actions</legend>
            {actions.onLike ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={actions.onLike}
                aria-label={`Like (${compactNumber.format(video.likeCount)})`}
              >
                <span aria-hidden="true">👍</span> {compactNumber.format(video.likeCount)}
              </Button>
            ) : null}
            {actions.onDislike ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={actions.onDislike}
                aria-label="Dislike video"
              >
                <span aria-hidden="true">👎</span>
                <span className="sr-only">Dislike</span>
              </Button>
            ) : null}
            {actions.onShare ? (
              <Button variant="secondary" size="sm" onClick={actions.onShare}>
                <span aria-hidden="true">↗</span> Share
              </Button>
            ) : null}
            {actions.onSave ? (
              <Button variant="secondary" size="sm" onClick={actions.onSave}>
                <span aria-hidden="true">＋</span> Save
              </Button>
            ) : null}
          </fieldset>
        ) : null}

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
        <Comments
          comments={comments}
          authors={commentAuthors}
          repliesByParent={commentReplies}
          state={commentsState}
          {...(commentsState === 'unavailable' ? {} : { totalCount: video.commentCount })}
          sort={commentSort ?? 'top'}
          onSortChange={onCommentSortChange}
          onSubmit={actions?.onComment}
          onReply={actions?.onReply}
          onReaction={actions?.onCommentReaction}
          onLoadReplies={onLoadCommentReplies}
          onRetry={onRetryComments}
          onLoadMore={onLoadMoreComments}
          hasNextPage={hasMoreComments}
          isFetchingNextPage={isFetchingMoreComments}
        />
      </div>
      <RelatedVideos videos={relatedVideos} channels={relatedChannels} />
    </div>
  );
}

export function WatchPage({
  video,
  channel,
  mediaSrc,
  mediaState,
  relatedVideos,
  relatedChannels,
  onMeaningfulPlayback,
  onRetryMedia,
  onBrowseVideos,
  onPlaybackHelp,
  state = video ? 'ready' : 'empty',
  errorTitle = 'Could not load this video',
  errorDescription = 'Please check your connection and try again.',
  onRetry,
  actions,
  subscribed,
  comments,
  commentAuthors,
  commentReplies,
  commentsState,
  commentSort,
  onCommentSortChange,
  onLoadMoreComments,
  hasMoreComments,
  isFetchingMoreComments,
  onLoadCommentReplies,
  onRetryComments,
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
        action={
          <PlaybackRecoveryActions
            onRetry={onRetry}
            onBrowseVideos={onBrowseVideos}
            onPlaybackHelp={onPlaybackHelp}
          />
        }
      />
    ) : state === 'empty' || !video ? (
      <EmptyState
        icon="◌"
        title="Video unavailable"
        description="This video is unpublished, private, or could not be found."
        action={
          <PlaybackRecoveryActions
            onBrowseVideos={onBrowseVideos}
            onPlaybackHelp={onPlaybackHelp}
          />
        }
      />
    ) : (
      <WatchContent
        video={video}
        {...(channel ? { channel } : {})}
        {...(mediaSrc !== undefined ? { mediaSrc } : {})}
        {...(mediaState ? { mediaState } : {})}
        {...(relatedVideos ? { relatedVideos } : {})}
        {...(relatedChannels ? { relatedChannels } : {})}
        {...(onMeaningfulPlayback ? { onMeaningfulPlayback } : {})}
        {...(onRetryMedia ? { onRetryMedia } : {})}
        {...(onBrowseVideos ? { onBrowseVideos } : {})}
        {...(onPlaybackHelp ? { onPlaybackHelp } : {})}
        {...(actions ? { actions } : {})}
        {...(subscribed === undefined ? {} : { subscribed })}
        {...(comments ? { comments } : {})}
        {...(commentAuthors ? { commentAuthors } : {})}
        {...(commentReplies ? { commentReplies } : {})}
        {...(commentsState ? { commentsState } : {})}
        {...(commentSort ? { commentSort } : {})}
        {...(onCommentSortChange ? { onCommentSortChange } : {})}
        {...(onLoadMoreComments ? { onLoadMoreComments } : {})}
        {...(hasMoreComments === undefined ? {} : { hasMoreComments })}
        {...(isFetchingMoreComments === undefined ? {} : { isFetchingMoreComments })}
        {...(onLoadCommentReplies ? { onLoadCommentReplies } : {})}
        {...(onRetryComments ? { onRetryComments } : {})}
      />
    );

  const page = <Page containerSize="full">{content}</Page>;

  return (
    <div data-theme={theme} className={cx(theme === 'dark' && 'dark', className)}>
      {shell ? <AppShell {...shell}>{page}</AppShell> : page}
    </div>
  );
}

export function WatchPageData({ client, videoId, ...props }: WatchPageDataProps) {
  const queryClient = useQueryClient();
  const looksPublic = isPublicVideoId(videoId);
  const publicVideoQuery = usePublicVideo(client, videoId, { enabled: looksPublic });
  const legacyVideoQuery = useVideo(client, videoId, { enabled: !looksPublic });
  const rawVideo = looksPublic ? publicVideoQuery.data : legacyVideoQuery.data;
  const videoQueryPending = looksPublic ? publicVideoQuery.isPending : legacyVideoQuery.isPending;
  const videoQueryError = looksPublic ? publicVideoQuery.error : legacyVideoQuery.error;
  const refetchVideo = looksPublic ? publicVideoQuery.refetch : legacyVideoQuery.refetch;

  // Public UI paths never render drafts or private published videos.
  const video =
    rawVideo &&
    rawVideo.status === 'published' &&
    (rawVideo.visibility === 'public' || rawVideo.visibility === 'unlisted')
      ? rawVideo
      : undefined;

  const mediaQuery = useQuery({
    queryKey: [...videoQueryKeys.publicVideo(videoId), 'media-src'] as const,
    queryFn: () => client.resolvePublicMediaContentPath(video?.publicVideoId ?? videoId),
    enabled: Boolean(video?.publicVideoId),
  });

  const publicVideoId = video?.publicVideoId;
  const viewRecorder = useMemo(
    () => ({
      publicVideoId,
      ...createPublicViewRecorder(async (id) => {
        const result = await client.recordPublicView(id);
        queryClient.setQueryData(videoQueryKeys.publicVideo(id), result.video);
        queryClient.setQueriesData({ queryKey: videoQueryKeys.publicVideos() }, (current) => {
          if (!current || typeof current !== 'object') return current;
          return replacePublicVideoInPages(
            current as {
              items?: readonly Video[];
              pages?: readonly { items: readonly Video[] }[];
            },
            result.video,
          );
        });
        return result;
      }),
    }),
    [client, queryClient, publicVideoId],
  );
  const commentsEnabled = videoProductSurfaceEnabled(client, 'comments');
  const [commentSort, setCommentSort] = useState<CommentSort>('top');
  const [expandedCommentIds, setExpandedCommentIds] = useState<readonly CommentId[]>([]);
  const commentVideoId = video?.id ?? videoId;
  const commentsQuery = useInfiniteVideoComments(
    client,
    commentVideoId,
    { sort: commentSort },
    10,
    commentsEnabled,
  );
  const comments = commentsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const replyQueries = useQueries({
    queries: expandedCommentIds.map((parentId) => ({
      queryKey: videoQueryKeys.comments(commentVideoId, { parentId }),
      queryFn: () => client.listComments(commentVideoId, { parentId }),
    })),
  });
  const replies = replyQueries.flatMap((query) => query.data?.items ?? []);
  const authorIds = useMemo(
    () => Array.from(new Set([...comments, ...replies].map((comment) => comment.authorId))),
    [comments, replies],
  );
  const authorQueries = useQueries({
    queries: authorIds.map((id) => ({
      queryKey: videoQueryKeys.userProfile(id),
      queryFn: () => client.getUserProfile(id),
    })),
  });
  const commentAuthors = useMemo(
    () =>
      Object.fromEntries(
        authorQueries.flatMap((query, index) => {
          const author = query.data;
          const id = authorIds[index];
          return author && id ? [[id, author] as const] : [];
        }),
      ),
    [authorIds, authorQueries],
  );
  const commentReplies = useMemo(
    () =>
      Object.fromEntries(
        expandedCommentIds.map((parentId, index) => [
          parentId,
          replyQueries[index]?.data?.items ?? [],
        ]),
      ),
    [expandedCommentIds, replyQueries],
  );
  const relatedVideosQuery = useQuery({
    queryKey: [...videoQueryKeys.publicVideos(), 'related', video?.channelId ?? 'all'] as const,
    queryFn: () => client.listPublicVideos({ limit: 8 }),
    enabled: Boolean(video),
  });
  const relatedVideos = (relatedVideosQuery.data?.items ?? []).filter(
    (item) => item.id !== video?.id && item.publicVideoId !== video?.publicVideoId,
  );

  return (
    <WatchPage
      {...props}
      {...(video ? { video } : {})}
      {...(mediaQuery.data ? { mediaSrc: mediaQuery.data } : {})}
      {...(video?.channel ? { channel: video.channel } : {})}
      relatedVideos={relatedVideos}
      relatedChannels={Object.fromEntries(
        relatedVideos.flatMap((item) => (item.channel ? [[item.channelId, item.channel]] : [])),
      )}
      onMeaningfulPlayback={(currentTime, duration) => {
        if (!viewRecorder.publicVideoId) return;
        void viewRecorder.onPlaybackProgress(viewRecorder.publicVideoId, currentTime, duration);
      }}
      comments={comments}
      commentAuthors={commentAuthors}
      commentReplies={commentReplies}
      commentSort={commentSort}
      onCommentSortChange={setCommentSort}
      hasMoreComments={commentsQuery.hasNextPage}
      isFetchingMoreComments={commentsQuery.isFetchingNextPage}
      onLoadMoreComments={() => void commentsQuery.fetchNextPage()}
      onLoadCommentReplies={(comment) =>
        setExpandedCommentIds((ids) => (ids.includes(comment.id) ? ids : [...ids, comment.id]))
      }
      onRetryComments={() => void commentsQuery.refetch()}
      actions={{
        ...props.actions,
        ...(commentsEnabled
          ? {
              onComment: async (body: string, richText: readonly CommentRichText[]) => {
                await client.createComment(commentVideoId, { body, richText });
                await commentsQuery.refetch();
                await props.actions?.onComment?.(body, richText);
              },
              onReply: async (
                comment: Comment,
                body: string,
                richText: readonly CommentRichText[],
              ) => {
                await client.createComment(commentVideoId, {
                  body,
                  richText,
                  parentId: comment.id,
                });
                await props.actions?.onReply?.(comment, body, richText);
              },
              onCommentReaction: (comment: Comment, reaction: CommentReaction | undefined) => {
                void client.reactToComment(comment.id, reaction);
                props.actions?.onCommentReaction?.(comment, reaction);
              },
            }
          : {}),
      }}
      commentsState={
        commentsEnabled
          ? commentsQuery.isPending
            ? 'loading'
            : commentsQuery.error
              ? 'error'
              : comments.length > 0
                ? 'ready'
                : 'empty'
          : 'unavailable'
      }
      state={videoQueryPending ? 'loading' : videoQueryError ? 'error' : video ? 'ready' : 'empty'}
      {...(videoQueryError ? { onRetry: () => void refetchVideo() } : {})}
      {...(video
        ? { mediaState: mediaQuery.isPending ? 'loading' : mediaQuery.isError ? 'error' : 'ready' }
        : {})}
      {...(mediaQuery.isError ? { onRetryMedia: () => void mediaQuery.refetch() } : {})}
    />
  );
}
