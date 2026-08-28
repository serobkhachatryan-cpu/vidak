'use client';

import type { Video } from '@w3ds/types';
import { Button, EmptyState, ErrorState, Page, Spinner, Text } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';
import { elapsedRecordingDuration, totalRecordingDuration } from './segmented-playback';

type LibraryVideo = {
  id: string;
  kind: 'call-recording' | 'video-message' | 'file';
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  accessScope: 'personal' | 'shared';
  streamIds: string[];
};

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; items: LibraryVideo[] }
  | { status: 'error' };

type OwnedVideosState =
  | { status: 'loading' }
  | { status: 'ready'; items: readonly Video[] }
  | { status: 'error' };

type VideoFilter = 'all' | 'calls' | 'messages' | 'files' | 'shared';

const videoFilters: Array<{ id: VideoFilter; label: string }> = [
  { id: 'all', label: 'All videos' },
  { id: 'calls', label: 'Call recordings' },
  { id: 'messages', label: 'Video messages' },
  { id: 'files', label: 'Uploaded files' },
  { id: 'shared', label: 'Shared with me' },
];

export function EVaultVideoLibraryPage() {
  const router = useRouter();
  const [state, setState] = useState<LibraryState>({ status: 'loading' });
  const [ownedVideosState, setOwnedVideosState] = useState<OwnedVideosState>({
    status: 'loading',
  });
  const [editingVideoId, setEditingVideoId] = useState<string | undefined>();
  const [unpublishError, setUnpublishError] = useState<string | undefined>();
  const [filter, setFilter] = useState<VideoFilter>('all');
  const load = useCallback(async () => {
    setState({ status: 'loading' });
    setOwnedVideosState({ status: 'loading' });
    setUnpublishError(undefined);
    void videoApiClient
      .listOwnedVideos()
      .then((items) => setOwnedVideosState({ status: 'ready', items }))
      .catch(() => setOwnedVideosState({ status: 'error' }));
    try {
      const response = await fetch('/api/evault/videos', { cache: 'no-store' });
      const body = (await response.json()) as { items?: LibraryVideo[] };
      if (!response.ok || !Array.isArray(body.items)) throw new Error();
      setState({ status: 'ready', items: body.items });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredItems = state.status === 'ready' ? filterVideos(state.items, filter) : [];
  const isFirstVisit =
    state.status === 'ready' &&
    state.items.length === 0 &&
    ownedVideosState.status === 'ready' &&
    ownedVideosState.items.length === 0;

  return (
    <ApplicationShell currentHref="/your-videos">
      <Page
        title="Your videos"
        description="Find video available through your eVaults, and manage the visibility of videos you uploaded to Vidak."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void load()}>
              Refresh videos
            </Button>
            <Button onClick={() => router.push('/upload')}>Upload a video</Button>
          </div>
        }
      >
        <div className="space-y-10">
          {isFirstVisit ? <FirstVideoSteps onUpload={() => router.push('/upload')} /> : null}

          <OwnedVidakVideos
            state={ownedVideosState}
            {...(editingVideoId ? { editingVideoId } : {})}
            {...(unpublishError ? { unpublishError } : {})}
            onContinueDraft={(video) =>
              router.push(`/upload?draft=${encodeURIComponent(video.id)}`)
            }
            onUnpublishToEdit={(video) => {
              void (async () => {
                setEditingVideoId(video.id);
                setUnpublishError(undefined);
                try {
                  await videoApiClient.unpublishVideo(video.id);
                  router.push(`/upload?draft=${encodeURIComponent(video.id)}`);
                } catch {
                  setUnpublishError('Could not return this video to an editable draft. Try again.');
                  setEditingVideoId(undefined);
                }
              })();
            }}
            onWatch={(video) => {
              if (video.publicVideoId)
                router.push(`/watch/${encodeURIComponent(video.publicVideoId)}`);
            }}
            onRetry={() => void load()}
          />

          <section className="space-y-5" aria-labelledby="evault-library-heading">
            <div className="space-y-1">
              <h2 id="evault-library-heading" className="text-xl font-semibold text-foreground">
                Videos available through your eVaults
              </h2>
              <Text size="sm" tone="muted">
                These videos are available to you through the source eVault. Finding or watching
                them never changes their sharing rules.
              </Text>
            </div>
            {state.status === 'loading' ? (
              <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner size="sm" /> Finding video you can access…
              </div>
            ) : state.status === 'error' ? (
              <ErrorState
                title="Could not load your eVault videos"
                description="Your video list is private. Refresh to try the request again."
                retry={() => void load()}
                retryLabel="Refresh videos"
              />
            ) : state.items.length === 0 ? (
              <EmptyState
                title="No eVault videos are available yet"
                description="When you can access video through an eVault, it will appear here. You can also upload a new video."
                action={<Button onClick={() => router.push('/upload')}>Upload a video</Button>}
              />
            ) : (
              <div className="space-y-5">
                <fieldset className="flex flex-wrap gap-2">
                  <legend className="sr-only">Filter your videos</legend>
                  {videoFilters.map((option) => (
                    <Button
                      key={option.id}
                      size="sm"
                      variant={filter === option.id ? 'primary' : 'secondary'}
                      onClick={() => setFilter(option.id)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </fieldset>
                {filteredItems.length === 0 ? (
                  <EmptyState
                    title="No videos match this filter"
                    description="Try another view to see the video available through your eVaults."
                    action={
                      <Button variant="secondary" onClick={() => setFilter('all')}>
                        Show all videos
                      </Button>
                    }
                  />
                ) : (
                  <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                    {filteredItems.map((video) => (
                      <article
                        key={video.id}
                        className="overflow-hidden rounded-xl border border-border bg-surface-raised"
                      >
                        <SegmentedVideoPlayer video={video} onRefresh={() => void load()} />
                        <div className="space-y-1 p-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                            {label(video)}
                          </p>
                          <h3 className="font-semibold text-foreground">{video.title}</h3>
                          <p className="text-sm text-muted-foreground">{details(video)}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </Page>
    </ApplicationShell>
  );
}

function FirstVideoSteps({ onUpload }: { onUpload: () => void }) {
  return (
    <section
      aria-labelledby="first-video-steps-heading"
      className="rounded-xl border border-primary/20 bg-primary/5 p-5 sm:p-6"
    >
      <div className="max-w-3xl space-y-4">
        <div className="space-y-1">
          <h2 id="first-video-steps-heading" className="text-xl font-semibold text-foreground">
            Start with one video
          </h2>
          <Text size="sm" tone="muted">
            Vidak helps you find video you can already access and gives you a clear publishing flow
            for video you upload here.
          </Text>
        </div>
        <ol className="grid gap-3 text-sm sm:grid-cols-3">
          <li className="rounded-lg border border-border bg-surface p-3">
            <p className="font-medium text-foreground">1. Look for available video</p>
            <p className="mt-1 text-muted-foreground">
              Vidak checks only eVaults you already have permission to read. It never copies or
              changes those source videos.
            </p>
          </li>
          <li className="rounded-lg border border-border bg-surface p-3">
            <p className="font-medium text-foreground">2. Upload something new</p>
            <p className="mt-1 text-muted-foreground">
              Upload a video to Vidak when you want to prepare it, save a draft, and choose its
              audience.
            </p>
          </li>
          <li className="rounded-lg border border-border bg-surface p-3">
            <p className="font-medium text-foreground">3. Choose before you publish</p>
            <p className="mt-1 text-muted-foreground">
              Vidak shows the exact effect before you sign. You can keep a video private, share a
              link, or publish it.
            </p>
          </li>
        </ol>
        <div>
          <Button onClick={onUpload}>Upload a video</Button>
        </div>
      </div>
    </section>
  );
}

function OwnedVidakVideos({
  state,
  editingVideoId,
  unpublishError,
  onContinueDraft,
  onUnpublishToEdit,
  onWatch,
  onRetry,
}: {
  state: OwnedVideosState;
  editingVideoId?: string;
  unpublishError?: string;
  onContinueDraft: (video: Video) => void;
  onUnpublishToEdit: (video: Video) => void;
  onWatch: (video: Video) => void;
  onRetry: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <section aria-labelledby="vidak-uploads-heading" className="space-y-3">
        <h2 id="vidak-uploads-heading" className="text-xl font-semibold text-foreground">
          Videos you uploaded to Vidak
        </h2>
        <div className="flex min-h-28 items-center gap-2 rounded-xl border border-border bg-surface-raised p-5 text-sm text-muted-foreground">
          <Spinner size="sm" /> Loading your Vidak uploads…
        </div>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section aria-labelledby="vidak-uploads-heading" className="space-y-3">
        <h2 id="vidak-uploads-heading" className="text-xl font-semibold text-foreground">
          Videos you uploaded to Vidak
        </h2>
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5"
          role="alert"
        >
          <Text size="sm">Could not load the videos you uploaded to Vidak.</Text>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </section>
    );
  }

  if (state.items.length === 0) return null;

  return (
    <section aria-labelledby="vidak-uploads-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="vidak-uploads-heading" className="text-xl font-semibold text-foreground">
          Videos you uploaded to Vidak
        </h2>
        <Text size="sm" tone="muted">
          These are the videos whose visibility you control here. To change a published video,
          return it to an editable draft first.
        </Text>
      </div>
      {unpublishError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
          <Text size="sm" tone="danger">
            {unpublishError}
          </Text>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {state.items.map((video) => {
          const visibility = ownedVideoVisibility(video);
          const canWatch =
            video.status === 'published' &&
            Boolean(video.publicVideoId) &&
            (video.visibility === 'public' || video.visibility === 'unlisted');
          const isEditing = editingVideoId === video.id;
          return (
            <article
              key={video.id}
              className="overflow-hidden rounded-xl border border-border bg-surface-raised"
            >
              {video.thumbnailUrl ? (
                // A thumbnail belongs to the signed-in owner and is served from an authenticated route.
                <img
                  src={video.thumbnailUrl}
                  alt=""
                  className="aspect-video w-full bg-muted object-cover"
                />
              ) : (
                <div className="aspect-video w-full bg-muted" aria-hidden="true" />
              )}
              <div className="space-y-3 p-4">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                    {visibility.label}
                  </p>
                  <h3 className="font-semibold text-foreground">{video.title}</h3>
                  <Text size="sm" tone="muted">
                    {visibility.description}
                  </Text>
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
                          View shared video
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        isLoading={isEditing}
                        loadingText="Returning to draft"
                        onClick={() => onUnpublishToEdit(video)}
                      >
                        Unpublish to edit
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ownedVideoVisibility(video: Video): { label: string; description: string } {
  if (video.status === 'draft') {
    return { label: 'Draft', description: 'Only you can see this until you sign and publish it.' };
  }
  if (video.visibility === 'public') {
    return { label: 'Public', description: 'Anyone can find and watch this video.' };
  }
  if (video.visibility === 'unlisted') {
    return { label: 'Shared by link', description: 'Anyone with its link can watch this video.' };
  }
  return { label: 'Private', description: 'Only you can watch this video.' };
}

function SegmentedVideoPlayer({
  video,
  onRefresh,
}: {
  video: LibraryVideo;
  onRefresh: () => void;
}) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [currentSegmentSeconds, setCurrentSegmentSeconds] = useState(0);
  const [segmentDurations, setSegmentDurations] = useState<Array<number | undefined>>([]);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const continuePlayback = useRef(false);
  const player = useRef<HTMLVideoElement>(null);
  const streamId = video.streamIds[segmentIndex] ?? video.streamIds[0];
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
    setPlaybackFailed(false);
    continuePlayback.current = false;
  }, [video.id]);

  if (!streamId) return null;

  const nextSegment = () => {
    if (segmentIndex >= video.streamIds.length - 1) return;
    setCurrentSegmentSeconds(0);
    continuePlayback.current = true;
    setSegmentIndex((current) => current + 1);
  };

  const rememberSegmentDuration = () => {
    const duration = player.current?.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return;
    setSegmentDurations((current) => {
      if (current[segmentIndex] === duration) return current;
      const next = [...current];
      next[segmentIndex] = duration;
      return next;
    });
  };

  const updatePlaybackPosition = () => {
    const position = player.current?.currentTime;
    if (typeof position === 'number' && Number.isFinite(position) && position >= 0) {
      setCurrentSegmentSeconds(position);
    }
  };

  const resumeWhenReady = () => {
    if (!continuePlayback.current) return;
    continuePlayback.current = false;
    void player.current?.play().catch(() => {
      // Browser autoplay rules may require the viewer to press play again.
    });
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: Historical source recordings do not include caption tracks. */}
      <video
        key={streamId}
        ref={player}
        aria-label={video.title}
        className="aspect-video w-full bg-black"
        controls
        preload="metadata"
        src={`/api/evault/videos/${encodeURIComponent(streamId)}`}
        onCanPlay={resumeWhenReady}
        onLoadedMetadata={rememberSegmentDuration}
        onTimeUpdate={updatePlaybackPosition}
        onEnded={nextSegment}
        onError={() => setPlaybackFailed(true)}
      />
      {video.streamIds.length > 1 ? (
        <div className="space-y-1 px-4 pt-3 text-xs text-muted-foreground" aria-live="polite">
          <p>
            One call recording · part {segmentIndex + 1} of {video.streamIds.length} · continues
            automatically
          </p>
          {totalDuration !== undefined ? (
            <p>
              Call progress {formatDuration(Math.min(elapsedDuration, totalDuration))} /{' '}
              {formatDuration(totalDuration)}
            </p>
          ) : null}
        </div>
      ) : null}
      {playbackFailed ? (
        <div
          className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          role="alert"
        >
          <p className="text-sm font-medium text-foreground">This recording could not be loaded.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Refresh the library to renew the private playback link, then try again.
          </p>
          <Button className="mt-3" variant="secondary" onClick={onRefresh}>
            Refresh videos
          </Button>
        </div>
      ) : null}
    </>
  );
}

function label(video: LibraryVideo): string {
  if (video.kind === 'call-recording') return 'Call recording';
  if (video.kind === 'video-message')
    return video.shape === 'circle' ? 'Video circle' : 'Video message';
  return 'Video file';
}

function filterVideos(items: LibraryVideo[], filter: VideoFilter): LibraryVideo[] {
  if (filter === 'calls') return items.filter((item) => item.kind === 'call-recording');
  if (filter === 'messages') return items.filter((item) => item.kind === 'video-message');
  if (filter === 'files') return items.filter((item) => item.kind === 'file');
  if (filter === 'shared') return items.filter((item) => item.accessScope === 'shared');
  return items;
}

function details(video: LibraryVideo): string {
  const values = [
    video.durationSeconds !== undefined ? formatDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
  ].filter(Boolean);
  const location = video.accessScope === 'shared' ? 'Shared with you' : 'In your eVault';
  return [...values, location].join(' · ');
}

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
