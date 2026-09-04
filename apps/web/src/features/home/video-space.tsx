'use client';

import type { Video } from '@w3ds/types';
import { Button, EmptyState, ErrorState, Page, Text, VidakLogo, VideoCardSkeleton } from '@w3ds/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';
import { createLatestRequestTracker, shouldStartRequest } from './latest-request';
import { libraryPollingDelayMs } from './library-polling';
import { PublicExplorePanel } from './public-explore-panel';
import { LibraryVideoCard, OwnedVideoCard } from './video-space-cards';
import {
  evaultItemsForTab,
  type InventoryCompleteness,
  type InventoryDiscovery,
  isVideoSpaceEmpty,
  libraryDiscoveryBanner,
  ownedItemsForTab,
  shareChangeConfirmation,
  type VideoSpaceLibraryItem,
  type VideoSpaceTab,
  videoSpaceEmptyCopy,
  videoSpaceGuideCopy,
  videoSpaceTabs,
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
  const libraryRequest = useRef(createLatestRequestTracker());
  const ownedRequest = useRef(createLatestRequestTracker());
  const libraryAbort = useRef<AbortController | undefined>(undefined);

  const loadEvault = useCallback(async (refresh = false) => {
    if (
      !shouldStartRequest({
        hasActiveRequest: libraryAbort.current !== undefined,
        supersede: refresh,
      })
    ) {
      return;
    }
    const request = libraryRequest.current.next();
    libraryAbort.current?.abort();
    const controller = new AbortController();
    libraryAbort.current = controller;
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
      const response = await fetch(`/api/evault/videos?${query.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const body = (await response.json()) as {
        items?: VideoSpaceLibraryItem[];
        completeness?: InventoryCompleteness;
        discovery?: InventoryDiscovery;
      };
      if (!response.ok || !Array.isArray(body.items)) throw new Error();
      if (!libraryRequest.current.isCurrent(request)) return;
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
      if (!libraryRequest.current.isCurrent(request)) return;
      setLibrary((current) =>
        current.items.length > 0 ? { ...current, status: 'error' } : { status: 'error', items: [] },
      );
    } finally {
      if (libraryRequest.current.isCurrent(request) && libraryAbort.current === controller) {
        libraryAbort.current = undefined;
      }
    }
  }, []);

  const load = useCallback(
    async (refresh = false) => {
      setActionError(undefined);
      setOwned((current) => (current.status === 'ready' ? current : { status: 'loading' }));
      const request = ownedRequest.current.next();
      void videoApiClient
        .listOwnedVideos()
        .then((items) => {
          if (ownedRequest.current.isCurrent(request)) setOwned({ status: 'ready', items });
        })
        .catch(() => {
          if (ownedRequest.current.isCurrent(request)) {
            setOwned((current) => (current.status === 'ready' ? current : { status: 'error' }));
          }
        });
      await loadEvault(refresh);
    },
    [loadEvault],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    return () => {
      libraryRequest.current.invalidate();
      ownedRequest.current.invalidate();
      libraryAbort.current?.abort();
    };
  }, []);

  useEffect(() => {
    const delay = libraryPollingDelayMs({
      ...(library.discovery ? { discovery: library.discovery } : {}),
      ...(library.completeness ? { completeness: library.completeness } : {}),
    });
    if (delay === undefined) return;
    const timer = window.setTimeout(() => {
      void loadEvault(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [library.completeness, library.discovery, loadEvault]);

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
          <VideoSpaceGuide />

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

function VideoSpaceGuide() {
  return (
    <aside
      className="rounded-xl border border-primary/20 bg-primary/5 p-4"
      aria-label="Video space guide"
    >
      <details open>
        <summary className="cursor-pointer font-medium text-foreground">
          {videoSpaceGuideCopy.title}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            — {videoSpaceGuideCopy.summary}
          </span>
        </summary>
        <div className="mt-3 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
          {videoSpaceGuideCopy.points.map((point) => (
            <p key={point}>{point}</p>
          ))}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Need help?{' '}
          <a href="/support" className="font-medium text-foreground underline underline-offset-4">
            Open support
          </a>
          .
        </p>
      </details>
    </aside>
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

export function PublicHomeFeed() {
  const router = useRouter();
  return (
    <ApplicationShell currentHref="/">
      <Page
        title="Watch public videos"
        description="Anyone can watch videos published publicly in Vidak. Sign in with eID only for your private W3DS video space, uploading, and visibility controls."
        containerSize="full"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => router.push('/support')}>
              How Vidak works
            </Button>
            <Button onClick={() => router.push('/login?returnTo=/')}>Sign in to your space</Button>
          </div>
        }
      >
        <div className="space-y-8">
          <section className="grid gap-4 rounded-xl border border-border bg-surface-raised p-5 sm:grid-cols-3">
            <div>
              <h2 className="font-semibold text-foreground">Watch without an eID</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Public Vidak videos are available immediately. You can also search public videos and
                channels.
              </p>
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Sign in for private video</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                eID opens videos you own or are allowed to view in your W3DS space. It does not
                create another eID.
              </p>
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Choose visibility</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                After signing in, Vidak lets you keep a video private or publish it for others to
                watch.
              </p>
            </div>
          </section>
          <section id="public-videos" aria-labelledby="public-videos-heading">
            <h2 id="public-videos-heading" className="mb-2 text-xl font-semibold text-foreground">
              Public videos
            </h2>
            <PublicExplorePanel />
          </section>
        </div>
      </Page>
    </ApplicationShell>
  );
}
