'use client';

import { Button, EmptyState, ErrorState, Page, Spinner } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { elapsedRecordingDuration, totalRecordingDuration } from './segmented-playback';

type LibraryVideo = {
  id: string;
  kind: 'call-recording' | 'video-message' | 'file';
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  streamIds: string[];
};

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; items: LibraryVideo[] }
  | { status: 'error' };

export function MeshengerVideoLibraryPage() {
  const router = useRouter();
  const [state, setState] = useState<LibraryState>({ status: 'loading' });
  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/meshenger/videos', { cache: 'no-store' });
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

  return (
    <ApplicationShell currentHref="/your-videos">
      <Page
        title="Your eVault videos"
        description="Video you can access through your eVaults. Nothing is shared or published automatically."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void load()}>
              Refresh videos
            </Button>
            <Button onClick={() => router.push('/upload')}>Upload a video</Button>
          </div>
        }
      >
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
            title="No videos are available yet"
            description="When you can access video through an eVault, it will appear here. You can also upload a new video."
            action={<Button onClick={() => router.push('/upload')}>Upload a video</Button>}
          />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {state.items.map((video) => (
              <article
                key={video.id}
                className="overflow-hidden rounded-xl border border-border bg-surface-raised"
              >
                <SegmentedVideoPlayer video={video} onRefresh={() => void load()} />
                <div className="space-y-1 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                    {label(video)}
                  </p>
                  <h2 className="font-semibold text-foreground">{video.title}</h2>
                  <p className="text-sm text-muted-foreground">{details(video)}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </Page>
    </ApplicationShell>
  );
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
        src={`/api/meshenger/videos/${encodeURIComponent(streamId)}`}
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

function details(video: LibraryVideo): string {
  const values = [
    video.durationSeconds !== undefined ? formatDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
  ].filter(Boolean);
  return values.join(' · ') || 'Available through your eVault';
}

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
