'use client';

import { useInfinitePublicVideos } from '@w3ds/hooks';
import { isRenderableThumbnailUrl, type Video } from '@w3ds/types';
import {
  Button,
  EmptyState,
  ErrorState,
  Grid,
  Page,
  Spinner,
  Text,
  VidakLogo,
  VideoCard,
  VideoCardSkeleton,
  VideoSpacePoster,
} from '@w3ds/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';
import {
  evaultItemsForTab,
  type InventoryCompleteness,
  type InventoryDiscovery,
  isVideoSpaceEmpty,
  libraryCardDetails,
  libraryDiscoveryBanner,
  ownedItemsForTab,
  ownedVideoSpaceVisibility,
  shareChangeConfirmation,
  type VideoSpaceLibraryItem,
  type VideoSpaceTab,
  videoSpaceEmptyCopy,
  videoSpaceTabs,
  videoSpaceVisibilityLabels,
} from './video-space-model';

type LibraryState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: VideoSpaceLibraryItem[];
  completeness?: InventoryCompleteness;
  discovery?: InventoryDiscovery;
};

type OwnedState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly Video[] }
  | { status: 'error' };

function tabFromSearch(value: string | null): VideoSpaceTab {
  if (value === 'yours' || value === 'shared' || value === 'explore') return value;
  return 'all';
}

export function VideoSpacePage({ currentHref = '/' }: { currentHref?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = tabFromSearch(searchParams.get('tab'));
  const [library, setLibrary] = useState<LibraryState>({ status: 'idle', items: [] });
  const [owned, setOwned] = useState<OwnedState>({ status: 'loading' });
  const [pendingVideoId, setPendingVideoId] = useState<string | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  const loadEvault = useCallback(async (refresh = false) => {
    setLibrary((current) =>
      current.items.length > 0
        ? {
            ...current,
            discovery: 'refreshing',
          }
        : { status: 'loading', items: [] },
    );
    try {
      const query = new URLSearchParams({ scope: 'all' });
      if (refresh) query.set('refresh', '1');
      const response = await fetch(`/api/evault/videos?${query.toString()}`, { cache: 'no-store' });
      const body = (await response.json()) as {
        items?: VideoSpaceLibraryItem[];
        completeness?: InventoryCompleteness;
        discovery?: InventoryDiscovery;
      };
      if (!response.ok || !Array.isArray(body.items)) throw new Error();
      setLibrary({
        status: 'ready',
        items: body.items.map((item) => ({
          ...item,
          visibility:
            item.visibility ?? (item.accessScope === 'shared' ? 'shared-with-me' : 'private'),
        })),
        ...(body.completeness ? { completeness: body.completeness } : {}),
        ...(body.discovery ? { discovery: body.discovery } : {}),
      });
    } catch {
      setLibrary((current) =>
        current.items.length > 0 ? { ...current, status: 'error' } : { status: 'error', items: [] },
      );
    }
  }, []);

  const load = useCallback(
    async (refresh = false) => {
      setActionError(undefined);
      setOwned((current) => (current.status === 'ready' ? current : { status: 'loading' }));
      void videoApiClient
        .listOwnedVideos()
        .then((items) => setOwned({ status: 'ready', items }))
        .catch(() =>
          setOwned((current) => (current.status === 'ready' ? current : { status: 'error' })),
        );
      await loadEvault(refresh);
    },
    [loadEvault],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (library.discovery !== 'refreshing' && library.discovery !== 'partial') return;
    const timer = window.setInterval(() => {
      void loadEvault(false);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [library.discovery, loadEvault]);

  const setTab = (next: VideoSpaceTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'all') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const libraryItems = library.items;
  const ownedItems = owned.status === 'ready' ? owned.items : [];
  const empty =
    library.status === 'ready' &&
    library.discovery !== 'refreshing' &&
    library.discovery !== 'partial' &&
    (tab === 'shared' || owned.status === 'ready') &&
    isVideoSpaceEmpty(libraryItems, ownedItems);

  return (
    <ApplicationShell currentHref={currentHref}>
      <Page
        title="Your video space"
        description="Every video you own or are authorized to view in your W3DS space — not only videos uploaded in Vidak."
        containerSize="full"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void load(true)}>
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
              icon={
                <VidakLogo title="" aria-hidden="true" className="h-12 w-auto text-foreground" />
              }
              title={videoSpaceEmptyCopy.title}
              description={videoSpaceEmptyCopy.description}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" onClick={() => void load(true)}>
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
              onRetry={() => void load(true)}
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
                    if (next === 'private') {
                      await videoApiClient.unpublishVideo(video.id);
                      await load(true);
                      return;
                    }
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
  const libraryItems = evaultItemsForTab(library.items, tab);
  const ownedItems = owned.status === 'ready' ? ownedItemsForTab(owned.items, tab) : [];
  const completenessBanner = libraryDiscoveryBanner({
    ...(library.discovery ? { discovery: library.discovery } : {}),
    ...(library.completeness ? { completeness: library.completeness } : {}),
    itemCount: libraryItems.length + ownedItems.length,
    shared: tab === 'shared',
  });
  const coldLoad =
    library.items.length === 0 &&
    ownedItems.length === 0 &&
    (library.status === 'loading' || library.status === 'idle');

  if (coldLoad) {
    return (
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3" role="status">
        {Array.from({ length: 6 }, (_, index) => (
          <VideoCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (
    library.status === 'error' &&
    libraryItems.length === 0 &&
    ownedItems.length === 0 &&
    (tab === 'shared' || owned.status !== 'ready')
  ) {
    return (
      <ErrorState
        title="Could not load your video space"
        description="Your library is private. Refresh to try the request again."
        retry={onRetry}
        retryLabel="Refresh your video space"
      />
    );
  }

  if (
    libraryItems.length === 0 &&
    ownedItems.length === 0 &&
    !completenessBanner &&
    library.discovery !== 'refreshing' &&
    library.discovery !== 'partial' &&
    library.status !== 'loading'
  ) {
    return (
      <EmptyState
        title={
          tab === 'shared'
            ? 'Nothing has been shared with you yet'
            : tab === 'yours'
              ? 'No videos you own yet'
              : 'No videos in this section'
        }
        description={
          tab === 'shared'
            ? 'When someone authorizes you to view a video in their W3DS space, it will appear here.'
            : tab === 'yours'
              ? 'Videos you own — including Messenger, calls, groups, and other W3DS apps — appear here.'
              : 'Videos you own or are authorized to view will appear here. Public videos published in Vidak stay in that tab.'
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

      {library.status === 'error' ? (
        <ErrorState
          title="Could not load eVault videos"
          description="Videos already on this page stay available. Refresh to try your authorised library again."
          retry={onRetry}
          retryLabel="Refresh your video space"
        />
      ) : null}

      <section className="space-y-4" aria-labelledby="video-space-library-heading">
        <div className="space-y-1">
          <h2 id="video-space-library-heading" className="text-xl font-semibold text-foreground">
            {tab === 'shared' ? 'Shared with me' : tab === 'yours' ? 'My videos' : 'All videos'}
          </h2>
          <Text size="sm" tone="muted">
            {tab === 'shared'
              ? 'Videos other people own that you are currently authorized to view. Finding them never changes their sharing rules.'
              : tab === 'yours'
                ? 'Every video you own in your W3DS space, including Messenger, calls, groups, and other apps. Finding them never changes their sharing rules.'
                : 'Every video you own or are authorized to view. My videos and Shared with me filter this same list.'}
          </Text>
          {completenessBanner ? (
            <div className="flex flex-wrap items-center gap-3">
              <Text size="sm" tone="muted" role="status">
                {completenessBanner}
              </Text>
              {library.discovery === 'partial' ? (
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
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
          {libraryItems.map((video) => (
            <LibraryVideoCard key={video.id} video={video} />
          ))}
        </div>
      </section>
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
  const existingPoster = isRenderableThumbnailUrl(video.thumbnailUrl)
    ? video.thumbnailUrl
    : undefined;
  const generatedPoster = `/api/videos/owned/${encodeURIComponent(video.id)}/preview`;
  const processing = video.status === 'processing';

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      <VideoSpacePoster
        title={video.title}
        {...(existingPoster
          ? { posterUrl: existingPoster, fallbackPosterUrl: generatedPoster }
          : { posterUrl: generatedPoster })}
        state={processing ? 'processing' : existingPoster ? 'ready' : 'processing'}
        durationSeconds={video.durationSeconds}
        visibilityLabel={visibility.label}
        locked={visibility.id === 'private'}
        loadWhenVisible
      />
      <div className="space-y-3 p-4">
        <div className="space-y-1">
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
              {visibility.id === 'public' || visibility.id === 'shared-by-me' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={isPending}
                  loadingText="Updating visibility"
                  onClick={() => onChangeVisibility(video, 'private')}
                >
                  Make private
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function LibraryVideoCard({ video }: { video: VideoSpaceLibraryItem }) {
  const visibilityLabel = videoSpaceVisibilityLabels[video.visibility];
  const watchHref = `/watch/space/${encodeURIComponent(video.id)}`;

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      <a href={watchHref} aria-label={`Watch ${video.title}`} className="block">
        <VideoSpacePoster
          title={video.title}
          {...(video.previewUrl ? { posterUrl: video.previewUrl } : {})}
          state={video.previewState ?? (video.previewUrl ? 'processing' : 'unavailable')}
          {...(video.durationSeconds !== undefined
            ? { durationSeconds: video.durationSeconds }
            : {})}
          visibilityLabel={visibilityLabel}
          locked={video.visibility === 'private'}
          loadWhenVisible
        />
      </a>
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{video.title}</h3>
          <p className="text-sm text-muted-foreground">{libraryCardDetails(video)}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            window.location.assign(watchHref);
          }}
        >
          Watch
        </Button>
      </div>
    </article>
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
        title="No public videos published in Vidak yet"
        description="This list is videos people published in Vidak. It is not a catalogue of all public W3DS media."
      />
    );
  }

  return (
    <>
      <Text size="sm" tone="muted" className="mb-4">
        Public videos published in Vidak. This list is not a catalogue of all public W3DS media.
      </Text>
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

export function PublicHomeFeed() {
  const router = useRouter();
  return (
    <ApplicationShell currentHref="/">
      <Page
        title="Home"
        description="Public videos published in Vidak. Sign in to see every video you are authorized to view in your W3DS space."
        containerSize="full"
        actions={<Button onClick={() => router.push('/login?returnTo=/')}>Sign in</Button>}
      >
        <PublicExplorePanel />
      </Page>
    </ApplicationShell>
  );
}
