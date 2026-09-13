'use client';

import { Button, ErrorState, Page, Spinner } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { useCurrentUser } from '../auth/auth-provider';
import { videoSpaceLibraryMemory } from '../home/video-space-library-memory';
import {
  canPlayLibraryVideo,
  type VideoSpaceLibraryItem,
  videoSpaceVisibilityLabels,
} from '../home/video-space-model';
import { libraryWatchItemLookupPath } from './library-watch-item-lookup';
import {
  isCurrentPlaybackGeneration,
  type PlaybackFailure,
  playbackFailureForAuthorizationCode,
  sharedVideoHandoffRetryDelay,
  shouldAwaitSharedVideoHandoff,
  singleVideoSourceRecoveryAction,
} from './watch-playback-recovery';
import { WatchRecoveryActions } from './watch-recovery-actions';

const playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function formatPlaybackSpeed(speed: number) {
  return `${speed}×`;
}

function PrivateRecordingQualityIndicator() {
  return (
    <div
      className="flex h-9 items-center gap-2 rounded-md bg-black/80 px-3 font-sans text-xs font-semibold text-white shadow-sm backdrop-blur"
      data-testid="video-quality-indicator"
    >
      <span>Quality</span>
      <span className="text-white/70">Original</span>
    </div>
  );
}

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
        const response = await fetch(libraryWatchItemLookupPath(itemId), { cache: 'no-store' });
        const body = (await response.json()) as { items?: VideoSpaceLibraryItem[] };
        if (!response.ok || !Array.isArray(body.items)) throw new Error();
        if (cancelled) return;
        // This is an exact lookup, not a complete library snapshot. Do not
        // replace the home-page memory catalogue with a one-item response.
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
  const [playbackError, setPlaybackError] = useState<PlaybackFailure | undefined>();
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [playbackGeneration, setPlaybackGeneration] = useState(0);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [recordingPlaybackUrl, setRecordingPlaybackUrl] = useState<string | undefined>();
  const [automaticTicketRetryUsed, setAutomaticTicketRetryUsed] = useState(false);
  const [waitingForSourceHandoff, setWaitingForSourceHandoff] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const reachedCanPlay = useRef(false);
  const automaticSourceRecoveryUsed = useRef(false);
  const sourceRecoveryController = useRef<AbortController | undefined>(undefined);
  const sourceHandoffRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceHandoffRetryPending = useRef(false);
  const sourceHandoffRetryAttempt = useRef(0);
  const currentPlaybackGeneration = useRef(0);
  // This ref changes only after React commits a new video. An async recovery
  // from a discarded concurrent render must never be able to decide that it
  // belongs to the next player instance.
  const committedVideoId = useRef(video.id);
  const streamIds = video.streamIds ?? [];
  const streamId = streamIds[0];
  const isContinuousRecording = streamIds.length > 1;
  const streamIdsKey = streamIds.join('\u0000');
  const playbackSource = isContinuousRecording
    ? recordingPlaybackUrl
    : streamId
      ? `/api/evault/videos/${encodeURIComponent(streamId)}?attempt=${playbackAttempt}`
      : undefined;

  const clearSourceHandoffRetry = useCallback(() => {
    if (sourceHandoffRetryTimer.current !== undefined) {
      clearTimeout(sourceHandoffRetryTimer.current);
      sourceHandoffRetryTimer.current = undefined;
    }
    sourceHandoffRetryPending.current = false;
    sourceHandoffRetryAttempt.current = 0;
    setWaitingForSourceHandoff(false);
  }, []);

  const advancePlaybackAttempt = (): void => {
    const nextGeneration = currentPlaybackGeneration.current + 1;
    // Advance synchronously before React replaces the keyed media element.
    // An old element may still dispatch `canplay` or `error` in that gap, but
    // the event's data generation will no longer match this ref.
    currentPlaybackGeneration.current = nextGeneration;
    setPlaybackGeneration(nextGeneration);
    setPlaybackAttempt((attempt) => attempt + 1);
  };

  const resetPlaybackAttempt = (): void => {
    const nextGeneration = currentPlaybackGeneration.current + 1;
    currentPlaybackGeneration.current = nextGeneration;
    setPlaybackGeneration(nextGeneration);
    setPlaybackAttempt(0);
  };

  const isCurrentPlaybackElement = (element: HTMLVideoElement): boolean => {
    return (
      element === player.current &&
      isCurrentPlaybackGeneration({
        eventGeneration: element.dataset.playbackGeneration,
        currentGeneration: currentPlaybackGeneration.current,
      })
    );
  };

  const scheduleSourceHandoffRetry = (): 'scheduled' | 'exhausted' => {
    if (sourceHandoffRetryTimer.current !== undefined) return 'scheduled';
    const delay = sharedVideoHandoffRetryDelay({
      isContinuousRecording,
      reachedCanPlay: reachedCanPlay.current,
      retryAttempt: sourceHandoffRetryAttempt.current,
    });
    if (delay === undefined) {
      sourceHandoffRetryPending.current = false;
      setWaitingForSourceHandoff(false);
      return 'exhausted';
    }
    sourceHandoffRetryPending.current = true;
    sourceHandoffRetryAttempt.current += 1;
    setWaitingForSourceHandoff(true);
    sourceHandoffRetryTimer.current = setTimeout(() => {
      sourceHandoffRetryTimer.current = undefined;
      if (
        !sourceHandoffRetryPending.current ||
        reachedCanPlay.current ||
        committedVideoId.current !== video.id
      ) {
        return;
      }
      // This deliberately reloads only the media GET. A different replica
      // may have just published the durable winner, and it can be adopted
      // without another forced proof or recovery POST.
      advancePlaybackAttempt();
    }, delay);
    return 'scheduled';
  };

  useEffect(() => {
    sourceRecoveryController.current?.abort();
    sourceRecoveryController.current = undefined;
    clearSourceHandoffRetry();
    committedVideoId.current = video.id;
    automaticSourceRecoveryUsed.current = false;
    setPlaybackError(undefined);
    resetPlaybackAttempt();
    setPlayerLoading(true);
    setPlaybackSpeed(1);
    setAutomaticTicketRetryUsed(false);
    setRecordingPlaybackUrl(undefined);
    reachedCanPlay.current = false;
    return () => {
      sourceRecoveryController.current?.abort();
      clearSourceHandoffRetry();
    };
  }, [clearSourceHandoffRetry, video.id]);

  useEffect(() => {
    setPlayerLoading(true);
    reachedCanPlay.current = false;
  }, [playbackSource]);

  useEffect(() => {
    if (!isContinuousRecording) {
      setRecordingPlaybackUrl(undefined);
      return;
    }
    if (!streamId) return;
    const controller = new AbortController();
    let cancelled = false;
    setRecordingPlaybackUrl(undefined);
    setPlayerLoading(true);
    void (async () => {
      try {
        // Create the ticket under segment zero's API subtree. Its receipt
        // cookie is scoped to this exact stream, so a later warmup for another
        // shared card cannot overwrite the first source's fast handoff before
        // a long continuous recording starts.
        const response = await fetch(
          `/api/evault/videos/${encodeURIComponent(streamId)}/recording-ticket`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ streamIds }),
            signal: controller.signal,
          },
        );
        const body = (await response.json().catch(() => undefined)) as
          | { playbackUrl?: unknown }
          | undefined;
        const playbackUrl = body?.playbackUrl;
        if (
          !response.ok ||
          typeof playbackUrl !== 'string' ||
          !playbackUrl.startsWith('/api/evault/recordings/')
        ) {
          throw new Error('Continuous recording ticket is unavailable.');
        }
        if (!cancelled) setRecordingPlaybackUrl(playbackUrl);
      } catch {
        if (!cancelled && !controller.signal.aborted) {
          setPlayerLoading(false);
          setPlaybackError(playbackFailureForAuthorizationCode('remote_unavailable'));
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isContinuousRecording, playbackAttempt, streamId, streamIdsKey]);

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

  const changePlaybackSpeed = (speed: number) => {
    setPlaybackSpeed(speed);
    if (player.current) player.current.playbackRate = speed;
  };

  const retrySingleVideoAfterAuthorizationFailure = (): boolean => {
    const recoveryAction = singleVideoSourceRecoveryAction({
      hasStreamId: Boolean(streamId),
      isContinuousRecording,
      reachedCanPlay: reachedCanPlay.current,
      automaticRecoveryUsed: automaticSourceRecoveryUsed.current,
      recoveryInFlight:
        Boolean(sourceRecoveryController.current) || sourceHandoffRetryTimer.current !== undefined,
    });
    if (recoveryAction === 'skip') return false;
    // Browsers can emit more than one `error` event for the same failed
    // resource (for example while cancelling a pending range request). Keep
    // the first authenticated recovery in charge instead of letting a second
    // event replace its eventual result with the generic error state.
    if (recoveryAction === 'wait') return true;
    if (!streamId) return false;
    automaticSourceRecoveryUsed.current = true;
    const controller = new AbortController();
    sourceRecoveryController.current = controller;
    const finishSourceRecovery = () => {
      if (sourceRecoveryController.current === controller) {
        sourceRecoveryController.current = undefined;
      }
    };
    setPlayerLoading(true);
    void (async () => {
      try {
        const response = await fetch(
          `/api/evault/videos/${encodeURIComponent(streamId)}/authorize`,
          {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { code?: unknown } }
          | undefined;
        if (controller.signal.aborted || committedVideoId.current !== video.id) return;
        if (!response.ok) {
          if (
            shouldAwaitSharedVideoHandoff(body?.error?.code) &&
            scheduleSourceHandoffRetry() === 'scheduled'
          ) {
            return;
          }
          setPlayerLoading(false);
          setPlaybackError(playbackFailureForAuthorizationCode(body?.error?.code));
          return;
        }
        setPlaybackError(undefined);
        advancePlaybackAttempt();
      } catch {
        if (controller.signal.aborted || committedVideoId.current !== video.id) return;
        setPlayerLoading(false);
        setPlaybackError(playbackFailureForAuthorizationCode('remote_unavailable'));
      } finally {
        // A change of item or an aborted request may take either early return
        // above. Releasing only this controller keeps a newer recovery intact
        // while preventing the current player from being stuck as "in flight".
        finishSourceRecovery();
      }
    })();
    return true;
  };

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
        {videoSpaceVisibilityLabels[video.visibility]}
      </p>
      {playbackError ? (
        <ErrorState
          title={playbackError.title}
          description={playbackError.description}
          action={
            <WatchRecoveryActions
              primaryLabel="Retry playback"
              onPrimary={() => {
                sourceRecoveryController.current?.abort();
                sourceRecoveryController.current = undefined;
                clearSourceHandoffRetry();
                automaticSourceRecoveryUsed.current = false;
                setPlaybackError(undefined);
                setPlayerLoading(true);
                setAutomaticTicketRetryUsed(false);
                advancePlaybackAttempt();
              }}
              secondaryLabel="Back to your video space"
              onSecondary={onReturnToVideoSpace}
              onReportProblem={onReportPlaybackProblem}
            />
          }
        />
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-black">
          {/* biome-ignore lint/a11y/useMediaCaption: Source MP4 subtitle streams are preserved by the secure playback join. */}
          <video
            key={`${video.id}:${playbackGeneration}`}
            ref={player}
            data-playback-generation={playbackGeneration}
            aria-label={video.title}
            className="aspect-video w-full bg-black"
            controls
            playsInline
            preload="auto"
            src={playbackSource}
            onCanPlay={(event) => {
              if (!isCurrentPlaybackElement(event.currentTarget)) return;
              reachedCanPlay.current = true;
              clearSourceHandoffRetry();
              setPlayerLoading(false);
            }}
            onError={(event) => {
              if (!isCurrentPlaybackElement(event.currentTarget)) return;
              // A native video element can retry a non-seekable streamed
              // response while it is still opening. Give a continuous
              // recording one new opaque ticket before surfacing an error;
              // once playback has started, do not silently restart it.
              if (
                isContinuousRecording &&
                playbackSource &&
                !reachedCanPlay.current &&
                !automaticTicketRetryUsed
              ) {
                setAutomaticTicketRetryUsed(true);
                advancePlaybackAttempt();
                return;
              }
              // A recovery POST may lose a race to a healthy resolver on a
              // different replica. Keep trying only the media GET while its
              // finite handoff window remains; do not create a second POST
              // or surface a generic error for the same expected race.
              if (!isContinuousRecording && sourceHandoffRetryPending.current) {
                if (scheduleSourceHandoffRetry() === 'scheduled') return;
                setPlayerLoading(false);
                setPlaybackError(playbackFailureForAuthorizationCode('remote_unavailable'));
                return;
              }
              if (retrySingleVideoAfterAuthorizationFailure()) return;
              setPlayerLoading(false);
              setPlaybackError(playbackFailureForAuthorizationCode(undefined));
            }}
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = playbackSpeed;
            }}
          />
          <div className="absolute top-3 right-3 z-10 flex items-start gap-2">
            <PrivateRecordingQualityIndicator />
            <details>
              <summary
                aria-label="Playback speed"
                className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md bg-black/80 px-3 text-xs font-semibold text-white shadow-sm backdrop-blur hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white [&::-webkit-details-marker]:hidden"
              >
                <span>Speed</span>
                <span className="text-white/70">{formatPlaybackSpeed(playbackSpeed)}</span>
              </summary>
              <div
                role="menu"
                className="absolute top-11 right-0 w-40 overflow-hidden rounded-lg bg-zinc-800 py-1 text-sm text-white shadow-xl ring-1 ring-white/15"
              >
                <p className="border-b border-white/15 px-4 py-3 text-sm font-semibold">
                  Playback speed
                </p>
                {playbackSpeeds.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    role="menuitemradio"
                    aria-checked={speed === playbackSpeed}
                    onClick={(event) => {
                      changePlaybackSpeed(speed);
                      event.currentTarget.closest('details')?.removeAttribute('open');
                    }}
                    className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
                  >
                    <span>{formatPlaybackSpeed(speed)}</span>
                    {speed === 1 ? <span className="text-xs text-white/60">Normal</span> : null}
                  </button>
                ))}
              </div>
            </details>
          </div>
          {playerLoading ? (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 rounded-xl bg-black/60 px-4 text-sm text-white"
              role="status"
              aria-live="polite"
            >
              <Spinner size="sm" aria-hidden="true" />
              {waitingForSourceHandoff
                ? 'Waiting for the shared video source…'
                : 'Opening private video…'}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
