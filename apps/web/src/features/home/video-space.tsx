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
  Text,
  VideoCard,
  VideoCardSkeleton,
  VidakLogo,
} from '@w3ds/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';
import { elapsedRecordingDuration, totalRecordingDuration } from '../meshenger/segmented-playback';
import {
  evaultItemsForTab,
  isVideoSpaceEmpty,
  ownedItemsForTab,
  ownedVideoSpaceVisibility,
  shareChangeConfirmation,
  videoSpaceEmptyCopy,
  videoSpaceTabs,
  videoSpaceVisibilityLabels,
  type VideoSpaceLibraryItem,
  type VideoSpaceTab,
} from './video-space-model';
import { useCapturedVideoPreview, VideoSpacePreviewFallback } from './video-space-preview';

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; items: VideoSpaceLibraryItem[] }
  | { status: 'error' };

type OwnedState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly Video[] }
  | { status: 'error' };

function tabFromSearch(value: string | null): VideoSpaceTab {
  if (value === 'shared' || value === 'explore') return value;
  return 'yours';
}

export function VideoSpacePage({ currentHref = '/' }: { currentHref?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = tabFromSearch(searchParams.get('tab'));
  const [library, setLibrary] = useState<LibraryState>({ status: 'loading' });
  const [owned, setOwned] = useState<OwnedState>({ status: 'loading' });
  const [pendingVideoId, setPendingVideoId] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLibrary({ status: 'loading' });
    setOwned({ status: 'loading' });
    setActionError(undefined);
    void videoApiClient
      .listOwnedVideos()
      .then((items) => setOwned({ status: 'ready', items }))
      .catch(() => setOwned({ status: 'error' }));
    try {
      const response = await fetch('/api/evault/videos', { cache: 'no-store' });
      const body = (await response.json()) as { items?: VideoSpaceLibraryItem[] };
      if (!response.ok || !Array.isArray(body.items)) throw new Error();
      setLibrary({
        status: 'ready',
        items: body.items.map((item) => ({
          ...item,
          visibility:
            item.visibility ?? (item.accessScope === 'shared' ? 'shared-with-me' : 'private'),
        })),
      });
    } catch {
      setLibrary({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setTab = (next: VideoSpaceTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'yours') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const libraryItems = library.status === 'ready' ? library.items : [];
  const ownedItems = owned.status === 'ready' ? owned.items : [];
  const empty =
    library.status === 'ready' &&
    owned.status === 'ready' &&
    isVideoSpaceEmpty(libraryItems, ownedItems);

  return (
    <ApplicationShell currentHref={currentHref}>
      <Page
        title="Your video space"
        description="Every video you own or are authorized to view in your W3DS space — not only videos uploaded in Vidak."
        containerSize="full"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void load()}>
              Refresh your video space
            </Button>
            <Button onClick={() => router.push('/upload')}>Upload</Button>
          </div>
        }
      >
        <div className="space-y-8">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Video space sections</legend>
            {videoSpaceTabs.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant={tab === option.id ? 'primary' : 'secondary'}
                onClick={() => setTab(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </fieldset>

          {tab === 'explore' ? (
            <PublicExplorePanel />
          ) : empty ? (
            <EmptyState
              icon={<VidakLogo title="" aria-hidden="true" className="h-12 w-auto text-foreground" />}
              title={videoSpaceEmptyCopy.title}
              description={videoSpaceEmptyCopy.description}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" onClick={() => void load()}>
                    Refresh your video space
                  </Button>
                  <Button onClick={() => router.push('/upload')}>Upload</Button>
                </div>
              }
            />
          ) : (
            <PrivateLibraryPanel
              tab={tab}
              library={library}
              owned={owned}
              {...(actionError ? { actionError } : {})}
              {...(pendingVideoId ? { pendingVideoId } : {})}
              onRetry={() => void load()}
              onWatch={(video) => {
                if (video.publicVideoId)
                  router.push(`/watch/${encodeURIComponent(video.publicVideoId)}`);
              }}
              onContinueDraft={(video) =>
                router.push(`/upload?draft=${encodeURIComponent(video.id)}`)
              }
              onChangeVisibility={(video, next) => {
                if (!window.confirm(shareChangeConfirmation(next))) return;
                void (async () => {
                  setPendingVideoId(video.id);
                  setActionError(undefined);
                  try {
                    if (next === 'private') await videoApiClient.unpublishVideo(video.id);
                    router.push(`/upload?draft=${encodeURIComponent(video.id)}`);
                  } catch {
                    setActionError('Could not change this video’s visibility. Try again.');
                  } finally {
                    setPendingVideoId(undefined);
                  }
                })();
              }}
            />
          )}
        </div>
      </Page>
    </ApplicationShell>
  );
}

function PrivateLibraryPanel({
  tab,
  library,
  owned,
  actionError,
  pendingVideoId,
  onRetry,
  onWatch,
  onContinueDraft,
  onChangeVisibility,
}: {
  tab: Exclude<VideoSpaceTab, 'explore'>;
  library: LibraryState;
  owned: OwnedState;
  actionError?: string;
  pendingVideoId?: string;
  onRetry: () => void;
  onWatch: (video: Video) => void;
  onContinueDraft: (video: Video) => void;
  onChangeVisibility: (video: Video, next: 'private') => void;
}) {
  const libraryItems = library.status === 'ready' ? evaultItemsForTab(library.items, tab) : [];
  const ownedItems = owned.status === 'ready' ? ownedItemsForTab(owned.items, tab) : [];
  const loading = library.status === 'loading' || (tab === 'yours' && owned.status === 'loading');

  if (loading) {
    return (
      <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" /> Finding video you can access…
      </div>
    );
  }

  if (library.status === 'error' && (tab === 'shared' || owned.status !== 'ready')) {
    return (
      <ErrorState
        title="Could not load your video space"
        description="Your library is private. Refresh to try the request again."
        retry={onRetry}
        retryLabel="Refresh your video space"
      />
    );
  }

  if (libraryItems.length === 0 && ownedItems.length === 0) {
    return (
      <EmptyState
        title={tab === 'shared' ? 'Nothing has been shared with you yet' : 'No videos in this section'}
        description={
          tab === 'shared'
            ? 'When someone authorizes you to view a video in their W3DS space, it will appear here.'
            : 'Videos you own will appear here. Public discovery stays in Explore public videos.'
        }
      />
    );
  }

  return (
    <div className="space-y-10">
      {actionError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
          <Text size="sm" tone="danger">
            {actionError}
          </Text>
        </div>
      ) : null}

      {ownedItems.length > 0 ? (
        <section className="space-y-4" aria-labelledby="owned-videos-heading">
          <h2 id="owned-videos-heading" className="text-xl font-semibold text-foreground">
            Videos you published or drafted in Vidak
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {ownedItems.map((video) => (
              <OwnedVideoCard
                key={video.id}
                video={video}
                isPending={pendingVideoId === video.id}
                onWatch={onWatch}
                onContinueDraft={onContinueDraft}
                onChangeVisibility={onChangeVisibility}
              />
            ))}
          </div>
        </section>
      ) : null}

      {library.status === 'error' ? (
        <ErrorState
          title="Could not load eVault videos"
          description="Owned Vidak videos are still shown. Refresh to try your authorised eVault library again."
          retry={onRetry}
          retryLabel="Refresh your video space"
        />
      ) : libraryItems.length > 0 ? (
        <section className="space-y-4" aria-labelledby="evault-videos-heading">
          <div className="space-y-1">
            <h2 id="evault-videos-heading" className="text-xl font-semibold text-foreground">
              {tab === 'shared' ? 'Shared with you' : 'In your W3DS space'}
            </h2>
            <Text size="sm" tone="muted">
              These videos are available through your signed-in eID. Finding them never changes
              their sharing rules.
            </Text>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {libraryItems.map((video) => (
              <LibraryVideoCard key={video.id} video={video} onRefresh={onRetry} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function OwnedVideoCard({
  video,
  isPending,
  onWatch,
  onContinueDraft,
  onChangeVisibility,
}: {
  video: Video;
  isPending: boolean;
  onWatch: (video: Video) => void;
  onContinueDraft: (video: Video) => void;
  onChangeVisibility: (video: Video, next: 'private') => void;
}) {
  const visibility = ownedVideoSpaceVisibility(video);
  const canWatch =
    video.status === 'published' &&
    Boolean(video.publicVideoId) &&
    (video.visibility === 'public' || video.visibility === 'unlisted');
  const hasThumbnail = Boolean(video.thumbnailUrl?.trim());

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      {hasThumbnail ? (
        <img src={video.thumbnailUrl} alt="" className="aspect-video w-full bg-muted object-cover" />
      ) : (
        <VideoSpacePreviewFallback
          title={video.title}
          state={video.status === 'processing' ? 'processing' : 'unsupported'}
        />
      )}
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            {visibility.label}
          </p>
          <h3 className="font-semibold text-foreground">{video.title}</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {video.status === 'draft' ? (
            <Button size="sm" onClick={() => onContinueDraft(video)}>
              Continue editing
            </Button>
          ) : (
            <>
              {canWatch ? (
                <Button size="sm" variant="secondary" onClick={() => onWatch(video)}>
                  View
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                isLoading={isPending}
                loadingText="Updating visibility"
                onClick={() => onChangeVisibility(video, 'private')}
              >
                Make private
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function LibraryVideoCard({
  video,
  onRefresh,
}: {
  video: VideoSpaceLibraryItem;
  onRefresh: () => void;
}) {
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      <LibraryVideoPlayer video={video} onRefresh={onRefresh} />
      <div className="space-y-1 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">
          {videoSpaceVisibilityLabels[video.visibility]}
        </p>
        <h3 className="font-semibold text-foreground">{video.title}</h3>
        <p className="text-sm text-muted-foreground">{libraryDetails(video)}</p>
      </div>
    </article>
  );
}

function LibraryVideoPlayer({
  video,
  onRefresh,
}: {
  video: VideoSpaceLibraryItem;
  onRefresh: () => void;
}) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [currentSegmentSeconds, setCurrentSegmentSeconds] = useState(0);
  const [segmentDurations, setSegmentDurations] = useState<Array<number | undefined>>([]);
  const continuePlayback = useRef(false);
  const player = useRef<HTMLVideoElement>(null);
  const [playerNode, setPlayerNode] = useState<HTMLVideoElement | null>(null);
  const streamId = video.streamIds?.[segmentIndex] ?? video.streamIds?.[0];
  const preview = useCapturedVideoPreview(playerNode);
  const totalDuration = totalRecordingDuration(video.durationSeconds, segmentDurations);
  const elapsedDuration = elapsedRecordingDuration(
    segmentIndex,
    currentSegmentSeconds,
    segmentDurations,
  );

  useEffect(() => {
    setSegmentIndex(0);
    setCurrentSegmentSeconds(0);
    setSegmentDurations([]);
    continuePlayback.current = false;
  }, [video.id]);

  if (!streamId) {
    return <VideoSpacePreviewFallback title={video.title} state="unsupported" />;
  }

  const streamUrl = `/api/evault/videos/${encodeURIComponent(streamId)}`;

  return (
    <div className="relative">
      {preview.state !== 'ready' ? (
        <div className="absolute inset-0 z-0">
          <VideoSpacePreviewFallback
            title={video.title}
            state={preview.state === 'unsupported' ? 'unsupported' : 'processing'}
          />
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/useMediaCaption: Historical source recordings do not include caption tracks. */}
      <video
        key={streamId}
        ref={(node) => {
          player.current = node;
          setPlayerNode(node);
        }}
        aria-label={video.title}
        className="relative z-10 aspect-video w-full bg-black"
        controls
        preload="metadata"
        {...(preview.poster ? { poster: preview.poster } : {})}
        src={streamUrl}
        onCanPlay={() => {
          if (!continuePlayback.current) return;
          continuePlayback.current = false;
          void player.current?.play().catch(() => undefined);
        }}
        onLoadedMetadata={() => {
          const duration = player.current?.duration;
          if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return;
          setSegmentDurations((current) => {
            if (current[segmentIndex] === duration) return current;
            const next = [...current];
            next[segmentIndex] = duration;
            return next;
          });
        }}
        onTimeUpdate={() => {
          const position = player.current?.currentTime;
          if (typeof position === 'number' && Number.isFinite(position) && position >= 0) {
            setCurrentSegmentSeconds(position);
          }
        }}
        onEnded={() => {
          if (segmentIndex >= (video.streamIds?.length ?? 1) - 1) return;
          setCurrentSegmentSeconds(0);
          continuePlayback.current = true;
          setSegmentIndex((current) => current + 1);
        }}
        onError={() => preview.markUnsupported()}
      />
      {(video.streamIds?.length ?? 0) > 1 ? (
        <div className="space-y-1 px-4 pt-3 text-xs text-muted-foreground" aria-live="polite">
          <p>
            One recording · part {segmentIndex + 1} of {video.streamIds?.length} · continues
            automatically
          </p>
          {totalDuration !== undefined ? (
            <p>
              Progress {formatDuration(Math.min(elapsedDuration, totalDuration))} /{' '}
              {formatDuration(totalDuration)}
            </p>
          ) : null}
        </div>
      ) : null}
      {preview.state === 'unsupported' ? (
        <div className="m-4 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm font-medium text-foreground">This recording could not be loaded.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Refresh your video space to renew the private playback link, then try again.
          </p>
          <Button className="mt-3" variant="secondary" onClick={onRefresh}>
            Refresh your video space
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PublicExplorePanel() {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage, isPending, refetch } =
    useInfinitePublicVideos(videoApiClient, 20);

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
        title="No public videos yet"
        description="Public discovery only shows videos people chose to publish. Your private library is unchanged."
      />
    );
  }

  return (
    <>
      <Text size="sm" tone="muted" className="mb-4">
        Public videos people have chosen to share. This feed does not include your private library.
      </Text>
      <Grid columns={5} gap={6}>
        {videos.map((video) => (
          <PublicVideoCard key={video.publicVideoId ?? video.id} video={video} />
        ))}
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
  );
}

function PublicVideoCard({ video }: { video: Video }) {
  const { data: channel } = useChannel(videoApiClient, video.channelId);
  return <VideoCard video={video} {...(channel ? { channel } : {})} />;
}

export function PublicHomeFeed() {
  const router = useRouter();
  return (
    <ApplicationShell currentHref="/">
      <Page
        title="Home"
        description="Public videos people have chosen to share. Sign in to see every video you are authorized to view in your W3DS space."
        containerSize="full"
        actions={
          <Button onClick={() => router.push('/login?returnTo=/')}>Sign in</Button>
        }
      >
        <PublicExplorePanel />
      </Page>
    </ApplicationShell>
  );
}

function libraryDetails(video: VideoSpaceLibraryItem): string {
  const values = [
    video.durationSeconds !== undefined ? formatDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
    videoSpaceVisibilityLabels[video.visibility],
  ].filter(Boolean);
  return values.join(' · ');
}

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
