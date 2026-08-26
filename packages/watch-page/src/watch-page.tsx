'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { isPublicVideoId, type VideoApiClient } from '@w3ds/api-client';
import {
  useChannel,
  useInfiniteVideoComments,
  usePublicVideo,
  useVideo,
  videoQueryKeys,
} from '@w3ds/hooks';
import type {
  Channel,
  Comment,
  CommentId,
  CommentReaction,
  CommentRichText,
  CommentSort,
  Video,
  VideoId,
  VideoMediaRendition,
} from '@w3ds/types';
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
  channel?: Channel;
  /** Same-origin public or owner media content path for playable bytes. */
  mediaSrc?: string;
  relatedVideos?: readonly Video[];
  relatedChannels?: Readonly<Record<string, Pick<Channel, 'name' | 'handle' | 'avatarUrl'>>>;
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
  commentsState?: 'ready' | 'loading' | 'empty' | 'error';
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
    'channel' | 'relatedChannels' | 'relatedVideos' | 'state' | 'video' | 'mediaSrc'
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
  return [rendition.label, contentType].filter(Boolean).join(' · ');
}

const qualityTiers = [
  { id: '2160p', label: '2160p', badge: '4K' },
  { id: '1440p', label: '1440p', badge: '2K' },
  { id: '1080p', label: '1080p', badge: 'HD' },
  { id: '720p', label: '720p', badge: 'HD' },
  { id: '480p', label: '480p' },
  { id: '360p', label: '360p' },
  { id: '240p', label: '240p' },
  { id: '144p', label: '144p' },
] as const;

const playbackSpeeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3] as const;

function formatPlaybackSpeed(speed: number): string {
  return `${String(speed)}x`;
}

type QualityTierId = (typeof qualityTiers)[number]['id'];

function qualityTierFor(rendition: VideoMediaRendition): QualityTierId | undefined {
  if (rendition.height) {
    const tier = qualityTiers.find(
      (candidate) => Number.parseInt(candidate.id, 10) === rendition.height,
    );
    if (tier) return tier.id;
  }

  const match = `${rendition.id} ${rendition.label}`.match(
    /\b(2160|1440|1080|720|480|360|240|144)p\b/i,
  );
  if (match?.[1]) return `${match[1]}p` as QualityTierId;
  return /\b4k\b/i.test(`${rendition.id} ${rendition.label}`) ? '2160p' : undefined;
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

  const selectedQuality =
    selectedQualityId === 'auto'
      ? automaticQuality
      : (qualityOptions.find((rendition) => rendition.id === selectedQualityId) ??
        automaticQuality);
  const qualityByTier = new Map<QualityTierId, VideoMediaRendition>();
  for (const rendition of qualityOptions) {
    const tierId = qualityTierFor(rendition);
    if (tierId && !qualityByTier.has(tierId)) qualityByTier.set(tierId, rendition);
  }
  const ungroupedOptions = qualityOptions.filter((rendition) => !qualityTierFor(rendition));
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
        {qualityTiers.map((tier) => {
          const rendition = qualityByTier.get(tier.id);
          const isSelected = rendition?.id === selectedQuality.id && selectedQualityId !== 'auto';
          return (
            <button
              key={tier.id}
              type="button"
              role="menuitemradio"
              aria-checked={isSelected}
              disabled={!rendition}
              onClick={
                rendition ? (event) => chooseQuality(rendition.id, event.currentTarget) : undefined
              }
              className={cx(
                'flex w-full items-center justify-between px-4 py-3 text-left font-sans focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white',
                rendition ? 'hover:bg-white/10' : 'cursor-not-allowed text-white/35',
                isSelected && 'bg-white/15',
              )}
            >
              <span>{tier.label}</span>
              <span className="text-xs text-white/60">
                {rendition ? ('badge' in tier ? tier.badge : 'Available') : 'Not available'}
              </span>
            </button>
          );
        })}
        {ungroupedOptions.map((rendition) => (
          <button
            key={rendition.id}
            type="button"
            role="menuitemradio"
            aria-checked={rendition.id === selectedQuality.id && selectedQualityId !== 'auto'}
            onClick={(event) => chooseQuality(rendition.id, event.currentTarget)}
            className="flex w-full items-center justify-between px-4 py-3 text-left font-sans hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
          >
            <span>{formatQualityLabel(rendition)}</span>
            <span className="text-xs text-white/60">Original</span>
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
  mediaRenditions,
}: {
  title: string;
  mediaSrc?: string;
  mediaRenditions?: readonly VideoMediaRendition[];
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
  const changePlaybackSpeed = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) videoRef.current.playbackRate = speed;
  };

  if (selectedMediaSrc) {
    return (
      <section
        aria-label={`Video player for ${title}`}
        className="relative aspect-video rounded-xl bg-black text-white shadow-sm"
      >
        <div className="absolute inset-0 overflow-hidden rounded-xl">
          <video
            key={selectedMediaSrc}
            ref={videoRef}
            className="h-full w-full"
            controls
            playsInline
            preload="metadata"
            src={selectedMediaSrc}
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
    <section
      aria-label={`Video player for ${title}`}
      className="relative aspect-video overflow-hidden rounded-xl bg-black text-white shadow-sm"
      data-testid="public-video-player-unavailable"
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
        <p className="font-sans text-sm text-white/80">This video has no playable media.</p>
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
  mediaSrc,
  relatedVideos = [],
  relatedChannels,
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
  const channelName = channel?.name ?? 'Unknown channel';
  const date = formatDate(video.publishedAt);

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-5">
        <VideoPlayer
          title={video.title}
          {...(mediaSrc !== undefined ? { mediaSrc } : {})}
          {...(video.mediaRenditions ? { mediaRenditions: video.mediaRenditions } : {})}
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
        <Comments
          comments={comments}
          authors={commentAuthors}
          repliesByParent={commentReplies}
          state={commentsState}
          totalCount={video.commentCount}
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
  relatedVideos,
  relatedChannels,
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
        {...(onRetry ? { retry: onRetry } : {})}
      />
    ) : state === 'empty' || !video ? (
      <EmptyState
        icon="◌"
        title="Video unavailable"
        description="This video is unpublished, private, or could not be found."
      />
    ) : (
      <WatchContent
        video={video}
        {...(channel ? { channel } : {})}
        {...(mediaSrc !== undefined ? { mediaSrc } : {})}
        {...(relatedVideos ? { relatedVideos } : {})}
        {...(relatedChannels ? { relatedChannels } : {})}
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

  const channelQuery = useChannel(client, video?.channelId ?? '', { enabled: Boolean(video) });
  const [commentSort, setCommentSort] = useState<CommentSort>('top');
  const [expandedCommentIds, setExpandedCommentIds] = useState<readonly CommentId[]>([]);
  const commentVideoId = video?.id ?? videoId;
  const commentsQuery = useInfiniteVideoComments(client, commentVideoId, { sort: commentSort }, 10);
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
      {...(channelQuery.data ? { channel: channelQuery.data } : {})}
      relatedVideos={relatedVideos}
      relatedChannels={channelQuery.data ? { [channelQuery.data.id]: channelQuery.data } : {}}
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
        onComment: async (body, richText) => {
          await client.createComment(commentVideoId, { body, richText });
          await commentsQuery.refetch();
          await props.actions?.onComment?.(body, richText);
        },
        onReply: async (comment, body, richText) => {
          await client.createComment(commentVideoId, {
            body,
            richText,
            parentId: comment.id,
          });
          await props.actions?.onReply?.(comment, body, richText);
        },
        onCommentReaction: (comment, reaction) => {
          void client.reactToComment(comment.id, reaction);
          props.actions?.onCommentReaction?.(comment, reaction);
        },
      }}
      commentsState={
        commentsQuery.isPending
          ? 'loading'
          : commentsQuery.error
            ? 'error'
            : comments.length > 0
              ? 'ready'
              : 'empty'
      }
      state={videoQueryPending ? 'loading' : videoQueryError ? 'error' : video ? 'ready' : 'empty'}
      {...(videoQueryError ? { onRetry: () => void refetchVideo() } : {})}
    />
  );
}
