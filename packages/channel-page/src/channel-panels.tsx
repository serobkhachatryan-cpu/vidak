import type { Channel, Playlist, Video } from '@w3ds/types';
import {
  EmptyState,
  Grid,
  Heading,
  PlaylistSearchResult,
  SearchResultSkeleton,
  Skeleton,
  Text,
  VideoCard,
  VideoCardSkeleton,
} from '@w3ds/ui';
import {
  ChannelSection,
  type ChannelSectionState,
  LoadingRegion,
  LoadMoreUploads,
  skeletonKeys,
} from './channel-section';
import { formatDate, formatSubscribers, formatVideoCount, formatViews } from './format';
import { cx, focusRing } from './styles';

const shortsGridClassName = 'grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6';

interface UploadsSectionProps {
  state: ChannelSectionState;
  onRetry?: (() => void) | undefined;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isFetchingMore?: boolean | undefined;
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
      <p className="mt-1 font-sans text-xs text-muted-foreground">{formatViews(video.viewCount)}</p>
    </article>
  );
}

function ShortCardSkeleton() {
  return (
    <div className="min-w-0">
      <Skeleton className="aspect-[9/16] w-full" />
      <Skeleton className="mt-2 h-4 w-10/12" />
      <Skeleton className="mt-2 h-3 w-6/12" />
    </div>
  );
}

export function VideosPanel({
  channel,
  videos,
  state,
  onRetry,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: UploadsSectionProps & { channel: Channel; videos: readonly Video[] }) {
  return (
    <ChannelSection
      state={state}
      isEmpty={videos.length === 0}
      errorTitle="Could not load videos"
      onRetry={onRetry}
      loading={
        <LoadingRegion label="Loading videos">
          <Grid columns={4} gap={6}>
            {skeletonKeys('video', 8).map((key) => (
              <VideoCardSkeleton key={key} />
            ))}
          </Grid>
        </LoadingRegion>
      }
      empty={
        <EmptyState
          icon="◌"
          title="No videos yet"
          description="Published videos from this channel will appear here."
        />
      }
    >
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
    </ChannelSection>
  );
}

export function ShortsPanel({
  shorts,
  state,
  onRetry,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: UploadsSectionProps & { shorts: readonly Video[] }) {
  return (
    <ChannelSection
      state={state}
      isEmpty={shorts.length === 0}
      errorTitle="Could not load shorts"
      onRetry={onRetry}
      loading={
        <LoadingRegion label="Loading shorts">
          <div className={shortsGridClassName}>
            {skeletonKeys('short', 6).map((key) => (
              <ShortCardSkeleton key={key} />
            ))}
          </div>
        </LoadingRegion>
      }
      empty={
        <EmptyState
          icon="▯"
          title="No shorts yet"
          description="Vertical videos up to a minute long will appear here."
        />
      }
    >
      <div className={shortsGridClassName}>
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
    </ChannelSection>
  );
}

export function PlaylistsPanel({
  playlists,
  state,
  onRetry,
}: {
  playlists: readonly Playlist[];
  state: ChannelSectionState;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <ChannelSection
      state={state}
      isEmpty={playlists.length === 0}
      errorTitle="Could not load playlists"
      onRetry={onRetry}
      loading={
        <LoadingRegion label="Loading playlists">
          <Grid columns={2} gap={4}>
            {skeletonKeys('playlist', 4).map((key) => (
              <SearchResultSkeleton key={key} type="playlists" />
            ))}
          </Grid>
        </LoadingRegion>
      }
      empty={
        <EmptyState
          icon="≣"
          title="No playlists yet"
          description="Playlists created by this channel will appear here."
        />
      }
    >
      <Grid columns={2} gap={4}>
        {playlists.map((playlist) => (
          <PlaylistSearchResult key={playlist.id} playlist={playlist} />
        ))}
      </Grid>
    </ChannelSection>
  );
}

export function AboutPanel({
  channel,
  subscriberCount,
}: {
  channel: Channel;
  subscriberCount: number;
}) {
  const joinedAt = formatDate(channel.createdAt);
  const details = [
    { label: 'Handle', value: `@${channel.handle}` },
    { label: 'Subscribers', value: formatSubscribers(subscriberCount) },
    { label: 'Videos', value: formatVideoCount(channel.videoCount) },
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
