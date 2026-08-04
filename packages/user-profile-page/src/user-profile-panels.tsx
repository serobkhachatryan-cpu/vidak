import type { Channel, Playlist, UserProfile, Video } from '@w3ds/types';
import {
  Card,
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
  formatFollowers,
  formatFollowing,
  formatJoinDate,
  formatVideoCount,
} from './format';
import { ProfileWebsiteLink } from './profile-website-link';
import {
  LoadingRegion,
  LoadMoreVideos,
  skeletonKeys,
  UserProfileSection,
  type UserProfileSectionState,
} from './user-profile-section';

/** Lightweight stand-in used when a playlist has no thumbnail metadata yet. */
function PlaylistPlaceholderCard({ title }: { title: string }) {
  return (
    <Card className="flex gap-4" aria-label={`Playlist ${title}`}>
      <div className="aspect-video w-36 shrink-0 overflow-hidden rounded bg-muted sm:w-48">
        <Skeleton className="h-full w-full rounded-none" />
      </div>
      <div className="min-w-0 space-y-2 self-center">
        <p className="font-sans font-semibold text-foreground">{title}</p>
        <p className="font-sans text-sm text-muted-foreground">Playlist</p>
      </div>
    </Card>
  );
}

export interface VideosPanelProps {
  videos: readonly Video[];
  channelsById: Readonly<Record<string, Channel>>;
  state: UserProfileSectionState;
  onRetry?: (() => void) | undefined;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isFetchingMore?: boolean | undefined;
}

export function VideosPanel({
  videos,
  channelsById,
  state,
  onRetry,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: VideosPanelProps) {
  return (
    <UserProfileSection
      state={state}
      isEmpty={videos.length === 0}
      errorTitle="Could not load videos"
      onRetry={onRetry}
      loading={
        <LoadingRegion label="Loading videos">
          <Grid columns={5} gap={6}>
            {skeletonKeys('profile-video', 10).map((key) => (
              <VideoCardSkeleton key={key} />
            ))}
          </Grid>
        </LoadingRegion>
      }
      empty={
        <EmptyState
          icon="◌"
          title="No videos yet"
          description="Uploaded videos from this profile will appear here."
        />
      }
    >
      <Grid columns={5} gap={6}>
        {videos.map((video) => {
          const channel = channelsById[video.channelId];
          return <VideoCard key={video.id} video={video} {...(channel ? { channel } : {})} />;
        })}
      </Grid>
      <LoadMoreVideos onLoadMore={onLoadMore} hasMore={hasMore} isFetchingMore={isFetchingMore} />
    </UserProfileSection>
  );
}

export interface PlaylistsPanelProps {
  playlists: readonly Playlist[];
  state: UserProfileSectionState;
  onRetry?: (() => void) | undefined;
}

export function PlaylistsPanel({ playlists, state, onRetry }: PlaylistsPanelProps) {
  return (
    <UserProfileSection
      state={state}
      isEmpty={playlists.length === 0}
      errorTitle="Could not load playlists"
      onRetry={onRetry}
      loading={
        <LoadingRegion label="Loading playlists">
          <Grid columns={2} gap={4}>
            {skeletonKeys('profile-playlist', 4).map((key) => (
              <SearchResultSkeleton key={key} type="playlists" />
            ))}
          </Grid>
        </LoadingRegion>
      }
      empty={
        <EmptyState
          icon="≣"
          title="No playlists yet"
          description="Playlists created by this profile will appear here."
        />
      }
    >
      <Grid columns={2} gap={4}>
        {playlists.map((playlist) =>
          playlist.thumbnailUrl ? (
            <PlaylistSearchResult key={playlist.id} playlist={playlist} />
          ) : (
            <PlaylistPlaceholderCard key={playlist.id} title={playlist.title} />
          ),
        )}
      </Grid>
    </UserProfileSection>
  );
}

export interface AboutPanelProps {
  profile: UserProfile;
  followerCount: number;
  followingCount: number;
  videoCount: number;
}

export function AboutPanel({
  profile,
  followerCount,
  followingCount,
  videoCount,
}: AboutPanelProps) {
  const joinedAt = formatJoinDate(profile.joinedAt);
  const details = [
    { label: 'Username', value: `@${profile.handle}` },
    { label: 'Followers', value: formatFollowers(followerCount) },
    { label: 'Following', value: formatFollowing(followingCount) },
    { label: 'Videos', value: formatVideoCount(videoCount) },
    ...(profile.location ? [{ label: 'Location', value: profile.location }] : []),
    ...(joinedAt ? [{ label: 'Joined', value: joinedAt }] : []),
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-label="Profile description" className="rounded-lg bg-surface-raised p-4">
        <Heading as="h2" size="sm">
          Description
        </Heading>
        <Text size="sm" className="mt-3 whitespace-pre-wrap">
          {profile.bio ?? 'This profile has not added a description yet.'}
        </Text>
        {profile.websiteUrl && (
          <p className="mt-4 font-sans text-sm">
            <ProfileWebsiteLink url={profile.websiteUrl} />
          </p>
        )}
      </section>
      <section aria-label="Profile statistics" className="rounded-lg bg-surface-raised p-4">
        <Heading as="h2" size="sm">
          Statistics
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
