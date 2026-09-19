'use client';

import type { Video } from '@w3ds/types';
import { Button, EmptyState, ErrorState, Page, Text, VidakLogo, VideoCardSkeleton } from '@w3ds/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';
import { useCurrentUser } from '../auth/auth-provider';
import { createExpiringMemoryCache } from './expiring-memory-cache';
import { createLatestRequestTracker, shouldStartRequest } from './latest-request';
import { libraryPollingDelayMs } from './library-polling';
import { PublicExplorePanel } from './public-explore-panel';
import { LibraryVideoCard, OwnedVideoCard } from './video-space-cards';
import { videoSpaceLibraryMemory } from './video-space-library-memory';
import {
  evaultItemsForTab,
  type InventoryCompleteness,
  type InventoryDiscovery,
  isVideoSpaceEmpty,
  libraryDiscoveryBanner,
  ownedItemsForTab,
  type VideoSpaceLibraryItem,
  type VideoSpaceTab,
  videoSpaceEmptyCopy,
  videoSpaceGuideCopy,
  videoSpacePanelCopy,
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

type VideoSpaceMemorySnapshot = {
  library: LibraryState;
  owned: OwnedState;
};

const videoSpaceMemory = createExpiringMemoryCache<VideoSpaceMemorySnapshot>({
  maxAgeMs: 2 * 60 * 1_000,
  maxEntries: 2,
});

function cloneLibraryState(library: LibraryState): LibraryState {
  return {
    ...library,
    items: [...library.items],
  };
}

function cloneOwnedState(owned: OwnedState): OwnedState {
  return owned.status === 'ready' ? { ...owned, items: [...owned.items] } : { ...owned };
}

function cloneVideoSpaceMemory(snapshot: VideoSpaceMemorySnapshot): VideoSpaceMemorySnapshot {
  return {
    library: cloneLibraryState(snapshot.library),
    owned: cloneOwnedState(snapshot.owned),
  };
}

function tabFromSearch(value: string | null): VideoSpaceTab {
  if (value === 'yours' || value === 'shared' || value === 'explore') return value;
  return 'all';
}

export function VideoSpacePage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useCurrentUser();
  const tab = tabFromSearch(searchParams.get('tab'));
  const [initialMemory] = useState<VideoSpaceMemorySnapshot | undefined>(() => {
    const cached = user ? videoSpaceMemory.get(user.id) : undefined;
    return cached ? cloneVideoSpaceMemory(cached) : undefined;
  });
  const [library, setLibrary] = useState<LibraryState>(
    initialMemory?.library ?? { status: 'idle', items: [] },
  );
  const [owned, setOwned] = useState<OwnedState>(initialMemory?.owned ?? { status: 'loading' });
  const libraryRequest = useRef(createLatestRequestTracker());
  const ownedRequest = useRef(createLatestRequestTracker());
  const libraryAbort = useRef<AbortController | undefined>(undefined);
  const loadedUserId = useRef<string | undefined>(undefined);

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
    const userId = user?.id;
    if (!userId || loadedUserId.current === userId) return;
    loadedUserId.current = userId;

    const cached = videoSpaceMemory.get(userId);
    if (cached) {
      const snapshot = cloneVideoSpaceMemory(cached);
      setLibrary(snapshot.library);
      setOwned(snapshot.owned);
    } else {
      setLibrary({ status: 'idle', items: [] });
      setOwned({ status: 'loading' });
    }
    void load(false);
  }, [load, user?.id]);

  useEffect(() => {
    if (!user?.id || library.status !== 'ready') return;
    videoSpaceLibraryMemory.set(user.id, library.items);
  }, [library.items, library.status, user?.id]);

  useEffect(() => {
    // The independent Vidak-owned-video request is an enhancement to this
    // eVault library. Keep an already loaded private library warm even if that
    // request is temporarily unavailable, rather than making every return to
    // this page start from an empty loading state.
    if (!user?.id || library.status !== 'ready' || owned.status === 'loading') return;
    videoSpaceMemory.set(user.id, {
      library: cloneLibraryState(library),
      owned: cloneOwnedState(owned),
    });
  }, [library, owned, user?.id]);

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
    if (next === tab) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'all') params.delete('tab');
    else params.set('tab', next);
    if (next !== 'yours') params.delete('sharing');
    const query = params.toString();
    // Library destinations are real places: browser Back/Forward must restore
    // the selected scope instead of silently replacing navigation history.
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  const libraryItems = library.items;
  const ownedItems = owned.status === 'ready' ? owned.items : [];
  const activeTab = videoSpaceTabs.find((option) => option.id === tab) ?? videoSpaceTabs[0];
  const isPublicCatalogue = tab === 'explore';
  const empty =
    library.status === 'ready' &&
    library.discovery !== 'refreshing' &&
    library.discovery !== 'partial' &&
    (tab === 'shared' || owned.status === 'ready') &&
    isVideoSpaceEmpty(libraryItems, ownedItems);

  return (
    <ApplicationShell currentHref={tab === 'all' ? '/' : `/?tab=${tab}`}>
      <Page
        title={isPublicCatalogue ? 'Public catalogue' : 'Your video space'}
        description={
          isPublicCatalogue
            ? 'Videos published publicly in Vidak. Link-only and private videos are not listed here.'
            : 'Every video you own or are authorized to view in your W3DS space — not only videos uploaded in Vidak.'
        }
        containerSize="full"
        actions={
          <div className="flex flex-wrap gap-2">
            {!isPublicCatalogue ? (
              <Button variant="secondary" onClick={() => void load(true)}>
                Refresh your video space
              </Button>
            ) : null}
            <Button onClick={() => router.push('/upload')}>Upload</Button>
          </div>
        }
      >
        <div className="space-y-8">
          {!isPublicCatalogue ? <VideoSpaceOrientation /> : null}

          <nav className="flex flex-wrap gap-2" aria-label="Choose a video collection">
            {videoSpaceTabs.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant={tab === option.id ? 'primary' : 'secondary'}
                aria-pressed={tab === option.id}
                onClick={() => setTab(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </nav>
          <p className="sr-only" aria-live="polite">
            Viewing {activeTab?.label ?? 'All accessible'} videos.
          </p>

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
              onRetry={() => void load(true)}
            />
          )}
        </div>
      </Page>
    </ApplicationShell>
  );
}

function VideoSpaceOrientation() {
  return (
    <aside
      className="rounded-xl border border-primary/20 bg-primary/5 p-4"
      aria-labelledby="video-space-orientation-heading"
    >
      <h2 id="video-space-orientation-heading" className="font-semibold text-foreground">
        {videoSpaceGuideCopy.title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{videoSpaceGuideCopy.summary}</p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          Understand access and sharing
        </summary>
        <div className="mt-3 grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
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

function VideoCardsGrid({
  ownedItems,
  libraryItems,
}: {
  ownedItems: readonly Video[];
  libraryItems: readonly VideoSpaceLibraryItem[];
}) {
  return (
    <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {ownedItems.map((video) => (
        <OwnedVideoCard key={`vidak-${video.id}`} video={video} />
      ))}
      {libraryItems.map((video) => (
        <LibraryVideoCard key={`w3ds-${video.id}`} video={video} />
      ))}
    </div>
  );
}

function VideoLibrarySection({
  id,
  title,
  description,
  ownedItems = [],
  libraryItems = [],
}: {
  id: string;
  title: string;
  description: string;
  ownedItems?: readonly Video[];
  libraryItems?: readonly VideoSpaceLibraryItem[];
}) {
  if (ownedItems.length + libraryItems.length === 0) return null;
  return (
    <section className="space-y-4" aria-labelledby={id}>
      <div className="space-y-1">
        <h3 id={id} className="text-lg font-semibold text-foreground">
          {title}
        </h3>
        <Text size="sm" tone="muted">
          {description}
        </Text>
      </div>
      <VideoCardsGrid ownedItems={ownedItems} libraryItems={libraryItems} />
    </section>
  );
}

function PrivateLibraryPanel({
  tab,
  library,
  owned,
  onRetry,
}: {
  tab: Exclude<VideoSpaceTab, 'explore'>;
  library: LibraryState;
  owned: OwnedState;
  onRetry: () => void;
}) {
  const libraryItems = evaultItemsForTab(library.items, tab);
  const ownedItems = owned.status === 'ready' ? ownedItemsForTab(owned.items, tab) : [];
  const personalLibraryItems = libraryItems.filter((item) => item.accessScope === 'personal');
  const sharedLibraryItems = libraryItems.filter((item) => item.accessScope === 'shared');
  const ownedLoadFailed = owned.status === 'error' && tab !== 'shared';
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
      <div className="space-y-3" role="status" aria-live="polite">
        <Text size="sm" tone="muted">
          Finding your videos securely. Vidak is checking titles and access permissions, not copying
          your media. Your first scan can take a moment; later visits stay warm.
        </Text>
        {ownedLoadFailed ? (
          <Text size="sm" tone="danger" role="alert">
            Could not load your Vidak videos yet. Vidak is still checking your W3DS library.
          </Text>
        ) : null}
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <VideoCardSkeleton key={index} />
          ))}
        </div>
      </div>
    );
  }

  const noVisibleVideos = libraryItems.length === 0 && ownedItems.length === 0;
  const libraryLoadFailed = library.status === 'error';

  if (
    noVisibleVideos &&
    !completenessBanner &&
    library.discovery !== 'refreshing' &&
    library.discovery !== 'partial' &&
    library.status !== 'loading' &&
    (libraryLoadFailed || ownedLoadFailed)
  ) {
    const title =
      libraryLoadFailed && ownedLoadFailed
        ? 'Could not load your video space'
        : ownedLoadFailed
          ? 'Could not load your Vidak videos'
          : 'Could not load your W3DS videos';
    const description =
      libraryLoadFailed && ownedLoadFailed
        ? 'Your private video lists could not be refreshed. Try again.'
        : ownedLoadFailed
          ? 'Vidak could not load the videos you own here. Refresh to try again.'
          : 'Your W3DS library could not be refreshed. Try again.';
    return (
      <ErrorState
        title={title}
        description={description}
        retry={onRetry}
        retryLabel="Refresh your video space"
      />
    );
  }

  if (
    noVisibleVideos &&
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
            ? videoSpacePanelCopy.emptyShared
            : tab === 'yours'
              ? videoSpacePanelCopy.emptyMine
              : videoSpacePanelCopy.emptyAll
        }
      />
    );
  }

  return (
    <div className="space-y-10">
      {library.status === 'error' ? (
        <ErrorState
          title="Could not load eVault videos"
          description="Videos already on this page stay available. Refresh to try your authorised library again."
          retry={onRetry}
          retryLabel="Refresh your video space"
        />
      ) : null}
      {ownedLoadFailed ? (
        <ErrorState
          title="Could not load your Vidak videos"
          description="Videos already on this page stay available. Refresh to try your owned-video list again."
          retry={onRetry}
          retryLabel="Refresh your video space"
        />
      ) : null}

      <section className="space-y-6" aria-labelledby="video-space-library-heading">
        <div className="space-y-1">
          <h2 id="video-space-library-heading" className="text-xl font-semibold text-foreground">
            {tab === 'shared'
              ? 'Shared with me'
              : tab === 'yours'
                ? 'My videos'
                : 'All accessible videos'}
          </h2>
          <Text size="sm" tone="muted">
            {tab === 'shared'
              ? videoSpacePanelCopy.shared
              : tab === 'yours'
                ? videoSpacePanelCopy.mine
                : videoSpacePanelCopy.all}
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
        {tab === 'all' ? (
          <div className="space-y-10">
            <VideoLibrarySection
              id="my-videos-overview-heading"
              title="My videos"
              description="Videos you own. Cards say whether Vidak can manage access or the source app keeps that control."
              ownedItems={ownedItems}
              libraryItems={personalLibraryItems}
            />
            <VideoLibrarySection
              id="shared-videos-overview-heading"
              title="Shared with me"
              description="View-only videos that their owner has authorized for you. Owner controls never appear here."
              libraryItems={sharedLibraryItems}
            />
          </div>
        ) : (
          <VideoCardsGrid ownedItems={ownedItems} libraryItems={libraryItems} />
        )}
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
