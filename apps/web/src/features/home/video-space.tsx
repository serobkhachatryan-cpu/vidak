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
  formatSpaceDuration,
  type InventoryCompleteness,
  isVideoSpaceEmpty,
  ownedItemsForTab,
  ownedVideoSpaceVisibility,
  shareChangeConfirmation,
  sharedInventoryBanner,
  type VideoSpaceLibraryItem,
  type VideoSpaceTab,
  videoSpaceEmptyCopy,
  videoSpaceTabs,
  videoSpaceVisibilityLabels,
} from './video-space-model';

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; items: VideoSpaceLibraryItem[]; completeness?: InventoryCompleteness }
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
      const body = (await response.json()) as {
        items?: VideoSpaceLibraryItem[];
        completeness?: InventoryCompleteness;
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
              icon={
                <VidakLogo title="" aria-hidden="true" className="h-12 w-auto text-foreground" />
              }
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
                    if (next === 'private') {
                      await videoApiClient.unpublishVideo(video.id);
                      await load();
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
  const libraryItems = library.status === 'ready' ? evaultItemsForTab(library.items, tab) : [];
  const ownedItems = owned.status === 'ready' ? ownedItemsForTab(owned.items, tab) : [];
  const completenessBanner =
    tab === 'shared' && library.status === 'ready'
      ? sharedInventoryBanner(library.completeness)
      : undefined;
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

  if (libraryItems.length === 0 && ownedItems.length === 0 && !completenessBanner) {
    return (
      <EmptyState
        title={
          tab === 'shared' ? 'Nothing has been shared with you yet' : 'No videos in this section'
        }
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
            {tab === 'shared' ? 'Shared with you' : 'Your videos'}
          </h2>
          <Text size="sm" tone="muted">
            {tab === 'shared'
              ? 'Videos other people have authorized you to view. Finding them never changes their sharing rules.'
              : 'Every video you own or drafted in your W3DS space. Finding them never changes their sharing rules.'}
          </Text>
          {completenessBanner ? (
            <Text size="sm" tone="muted" role="status">
              {completenessBanner}
            </Text>
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
      />
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
        />
      </a>
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            {visibilityLabel}
          </p>
          <h3 className="font-semibold text-foreground">{video.title}</h3>
          <p className="text-sm text-muted-foreground">{libraryDetails(video)}</p>
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
        description="Public videos people have chosen to share. Sign in to see every video you are authorized to view in your W3DS space."
        containerSize="full"
        actions={<Button onClick={() => router.push('/login?returnTo=/')}>Sign in</Button>}
      >
        <PublicExplorePanel />
      </Page>
    </ApplicationShell>
  );
}

function libraryDetails(video: VideoSpaceLibraryItem): string {
  const values = [
    video.durationSeconds !== undefined ? formatSpaceDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
    videoSpaceVisibilityLabels[video.visibility],
  ].filter(Boolean);
  return values.join(' · ');
}
