'use client';

import { Button, ErrorState, Page, Spinner, Text } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { useCurrentUser } from '../auth/auth-provider';
import { videoSpaceLibraryMemory } from '../home/video-space-library-memory';
import {
  canPlayLibraryVideo,
  formatSpaceDuration,
  type VideoSpaceLibraryItem,
  videoSpaceVisibilityLabels,
} from '../home/video-space-model';
import {
  elapsedRecordingDuration,
  recordingPositionAt,
  recordingTimelineDuration,
  totalRecordingDuration,
} from '../meshenger/segmented-playback';
import { WatchRecoveryActions } from './watch-recovery-actions';

export function LibraryWatchPage({ itemId }: { itemId: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  const cachedItem = user ? videoSpaceLibraryMemory.get(user.id, itemId) : undefined;
  const [item, setItem] = useState<VideoSpaceLibraryItem | undefined>(cachedItem);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    cachedItem ? 'ready' : 'loading',
  );
  const [refreshVersion, setRefreshVersion] = useState(0);

  const returnToVideoSpace = () => router.push('/');
  const reportPlaybackProblem = () => router.push('/support');
  const retryOpeningVideo = () => {
    setItem(undefined);
    setStatus('loading');
    setRefreshVersion((version) => version + 1);
  };

  useEffect(() => {
    let cancelled = false;
    const cached = user ? videoSpaceLibraryMemory.get(user.id, itemId) : undefined;
    if (cached) {
      setItem(cached);
      setStatus('ready');
      // Navigation from the library already has a viewer-bound opaque stream
      // grant. Do not immediately reload the entire private catalogue just to
      // rediscover the same card: that used to make Watch contend with the
      // video source itself. The media route rechecks authorization before
      // any bytes are streamed.
      return () => {
        cancelled = true;
      };
    }
    setItem(undefined);
    setStatus('loading');
    void (async () => {
      try {
        const response = await fetch('/api/evault/videos?scope=all', { cache: 'no-store' });
        const body = (await response.json()) as { items?: VideoSpaceLibraryItem[] };
        if (!response.ok || !Array.isArray(body.items)) throw new Error();
        if (cancelled) return;
        if (user?.id) videoSpaceLibraryMemory.set(user.id, body.items);
        const found = body.items.find((candidate) => candidate.id === itemId);
        if (found) {
          setItem(found);
          setStatus('ready');
          return;
        }
        setItem(undefined);
        setStatus('missing');
      } catch {
        if (!cancelled && !cached) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, refreshVersion, user?.id]);

  return (
    <ApplicationShell>
      <Page
        title={item?.title ?? 'Watch'}
        description="Playback stays on this page. Grid cards only show a still preview."
        containerSize="lg"
        actions={
          <Button variant="secondary" onClick={returnToVideoSpace}>
            Back to your video space
          </Button>
        }
      >
        {status === 'loading' ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> Opening this video…
          </div>
        ) : null}
        {status === 'error' ? (
          <ErrorState
            title="Could not open this video"
            description="Vidak could not refresh this video from your private space. Try again, or report the problem if it continues."
            action={
              <WatchRecoveryActions
                primaryLabel="Try again"
                onPrimary={retryOpeningVideo}
                secondaryLabel="Back to your video space"
                onSecondary={returnToVideoSpace}
                onReportProblem={reportPlaybackProblem}
              />
            }
          />
        ) : null}
        {status === 'missing' ? (
          <ErrorState
            title="This video is not available"
            description="It may have been removed or is no longer authorized for this account."
            action={
              <WatchRecoveryActions
                primaryLabel="Back to your video space"
                onPrimary={returnToVideoSpace}
                onReportProblem={reportPlaybackProblem}
              />
            }
          />
        ) : null}
        {status === 'ready' && item && !canPlayLibraryVideo(item) ? (
          <ErrorState
            title="Shared playback is paused"
            description="Vidak has listed this video as shared with you, but it will not play it until source permission can be verified for every request."
            action={
              <WatchRecoveryActions
                primaryLabel="Back to your video space"
                onPrimary={returnToVideoSpace}
                onReportProblem={reportPlaybackProblem}
              />
            }
          />
        ) : null}
        {status === 'ready' && item && canPlayLibraryVideo(item) ? (
          <LibraryWatchPlayer
            video={item}
            onReturnToVideoSpace={returnToVideoSpace}
            onReportPlaybackProblem={reportPlaybackProblem}
          />
        ) : null}
      </Page>
    </ApplicationShell>
  );
}

function LibraryWatchPlayer({
  video,
  onReturnToVideoSpace,
  onReportPlaybackProblem,
}: {
  video: VideoSpaceLibraryItem;
  onReturnToVideoSpace: () => void;
  onReportPlaybackProblem: () => void;
}) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [currentSegmentSeconds, setCurrentSegmentSeconds] = useState(0);
  const [segmentDurations, setSegmentDurations] = useState<Array<number | undefined>>([]);
  const [playbackError, setPlaybackError] = useState(false);
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const continuePlayback = useRef(false);
  const pendingSegmentSeek = useRef<number | undefined>(undefined);
  const playerContainer = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const streamId = video.streamIds?.[segmentIndex] ?? video.streamIds?.[0];
  const totalDuration = totalRecordingDuration(video.durationSeconds, segmentDurations);
  const timelineDuration = recordingTimelineDuration(segmentDurations);
  const elapsedDuration = elapsedRecordingDuration(
    segmentIndex,
    currentSegmentSeconds,
    segmentDurations,
  );

  useEffect(() => {
    setSegmentIndex(0);
    setCurrentSegmentSeconds(0);
    setSegmentDurations([]);
    setPlaybackError(false);
    setPlaybackAttempt(0);
    setPlayerLoading(true);
    setIsPlaying(false);
    setMuted(false);
    continuePlayback.current = false;
    pendingSegmentSeek.current = undefined;
  }, [video.id]);

  useEffect(() => {
    setPlayerLoading(true);
  }, [streamId, playbackAttempt]);

  useEffect(() => {
    const streamIds = video.streamIds ?? [];
    if (streamIds.length < 2) return;

    let cancelled = false;
    const readDuration = (candidateStreamId: string) =>
      new Promise<number | undefined>((resolve) => {
        const probe = document.createElement('video');
        let settled = false;
        const finish = (duration: number | undefined) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          probe.removeAttribute('src');
          probe.load();
          resolve(duration);
        };
        const timeout = window.setTimeout(() => finish(undefined), 12_000);
        probe.preload = 'metadata';
        probe.muted = true;
        probe.onloadedmetadata = () => {
          const duration = probe.duration;
          finish(Number.isFinite(duration) && duration > 0 ? duration : undefined);
        };
        probe.onerror = () => finish(undefined);
        probe.src = `/api/evault/videos/${encodeURIComponent(candidateStreamId)}?metadata=1`;
      });

    void (async () => {
      // Probe one source at a time after the viewer has opened the recording.
      // This gives the player an exact, recording-level seek map without
      // competing with interactive playback or downloading media bodies.
      for (let index = 1; index < streamIds.length; index += 1) {
        const candidateStreamId = streamIds[index];
        if (!candidateStreamId) continue;
        const duration = await readDuration(candidateStreamId);
        if (cancelled) return;
        if (duration === undefined) continue;
        setSegmentDurations((current) => {
          if (current[index] === duration) return current;
          const next = [...current];
          next[index] = duration;
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [video.id, video.streamIds]);

  if (!streamId) {
    return (
      <ErrorState
        title="This recording has no playable file"
        description="Vidak could not find a playable private file for this recording."
        action={
          <WatchRecoveryActions
            primaryLabel="Back to your video space"
            onPrimary={onReturnToVideoSpace}
            onReportProblem={onReportPlaybackProblem}
          />
        }
      />
    );
  }

  const hasMultipleSources = (video.streamIds?.length ?? 0) > 1;
  const displayDuration = timelineDuration ?? totalDuration;
  const playbackPosition = Math.min(elapsedDuration, displayDuration ?? elapsedDuration);

  const togglePlayback = () => {
    const element = player.current;
    if (!element) return;
    if (element.paused) {
      void element.play().catch(() => setPlaybackError(true));
      return;
    }
    element.pause();
  };

  const seekRecording = (nextSeconds: number) => {
    const target = recordingPositionAt(nextSeconds, segmentDurations);
    if (!target) return;
    const element = player.current;
    const shouldContinue = Boolean(element && !element.paused);
    if (target.segmentIndex === segmentIndex && element) {
      element.currentTime = target.seconds;
      setCurrentSegmentSeconds(target.seconds);
      return;
    }
    pendingSegmentSeek.current = target.seconds;
    continuePlayback.current = shouldContinue;
    setCurrentSegmentSeconds(target.seconds);
    setPlayerLoading(true);
    setSegmentIndex(target.segmentIndex);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    void playerContainer.current?.requestFullscreen().catch(() => undefined);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
        {videoSpaceVisibilityLabels[video.visibility]}
      </p>
      {playbackError ? (
        <ErrorState
          title="Video source is unavailable"
          description="The source link may have expired. Retry playback once, or report the problem if it continues."
          action={
            <WatchRecoveryActions
              primaryLabel="Retry playback"
              onPrimary={() => {
                setPlaybackError(false);
                setPlayerLoading(true);
                setPlaybackAttempt((attempt) => attempt + 1);
              }}
              secondaryLabel="Back to your video space"
              onSecondary={onReturnToVideoSpace}
              onReportProblem={onReportPlaybackProblem}
            />
          }
        />
      ) : (
        <div ref={playerContainer} className="relative bg-black">
          {/* biome-ignore lint/a11y/useMediaCaption: Historical source recordings do not include caption tracks. */}
          <video
            key={`${streamId}:${playbackAttempt}`}
            ref={player}
            aria-label={video.title}
            className="aspect-video w-full rounded-xl bg-black"
            controls={!hasMultipleSources}
            muted={muted}
            playsInline
            preload="metadata"
            src={`/api/evault/videos/${encodeURIComponent(streamId)}?attempt=${playbackAttempt}`}
            onCanPlay={() => {
              setPlayerLoading(false);
              const pendingSeek = pendingSegmentSeek.current;
              if (pendingSeek !== undefined && player.current) {
                player.current.currentTime = pendingSeek;
                pendingSegmentSeek.current = undefined;
              }
              if (!continuePlayback.current) return;
              continuePlayback.current = false;
              void player.current?.play().catch(() => undefined);
            }}
            onError={() => {
              setPlayerLoading(false);
              setPlaybackError(true);
            }}
            onLoadedMetadata={() => {
              const duration = player.current?.duration;
              if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
                return;
              setSegmentDurations((current) => {
                if (current[segmentIndex] === duration) return current;
                const next = [...current];
                next[segmentIndex] = duration;
                return next;
              });
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={() => {
              const position = player.current?.currentTime;
              if (typeof position === 'number' && Number.isFinite(position) && position >= 0) {
                setCurrentSegmentSeconds(position);
              }
            }}
            onEnded={() => {
              if (segmentIndex >= (video.streamIds?.length ?? 1) - 1) return;
              setCurrentSegmentSeconds(0);
              setPlayerLoading(true);
              continuePlayback.current = true;
              setSegmentIndex((current) => current + 1);
            }}
          />
          {playerLoading ? (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 rounded-xl bg-black/60 px-4 text-sm text-white"
              role="status"
              aria-live="polite"
            >
              <Spinner size="sm" aria-hidden="true" />
              Opening private video…
            </div>
          ) : null}
        </div>
      )}
      {hasMultipleSources ? (
        <div className="space-y-2" aria-label="Recording playback controls">
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onClick={togglePlayback}
            >
              {isPlaying ? 'Pause' : 'Play'} recording
            </button>
            <button
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onClick={() => setMuted((current) => !current)}
            >
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onClick={toggleFullscreen}
            >
              Full screen
            </button>
            <Text size="sm" tone="muted">
              {displayDuration !== undefined
                ? `${formatSpaceDuration(playbackPosition)} / ${formatSpaceDuration(displayDuration)}`
                : `${formatSpaceDuration(elapsedDuration)} elapsed`}
            </Text>
          </div>
          <input
            aria-label="Seek within recording"
            className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
            disabled={timelineDuration === undefined}
            max={timelineDuration ?? 0}
            min={0}
            step="any"
            type="range"
            value={Math.min(playbackPosition, timelineDuration ?? 0)}
            onChange={(event) => seekRecording(Number(event.target.value))}
          />
          <Text size="sm" tone="muted">
            {timelineDuration !== undefined
              ? 'One continuous recording. Use the timeline to move anywhere in the call.'
              : 'One continuous recording. Preparing the full timeline for seeking…'}
          </Text>
        </div>
      ) : null}
    </div>
  );
}
