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
  createContinuousRecordingTicket,
  takePreloadedContinuousRecordingTicket,
} from './recording-ticket-preload';
import {
  initialContinuousRecordingTicketRetryDelayMs,
  isCurrentPlaybackGeneration,
  type PlaybackFailure,
  playbackFailureForAuthorizationCode,
  sharedVideoHandoffRetryDelay,
  shouldAwaitSharedVideoHandoff,
  shouldRetryInitialContinuousRecordingTicket,
  shouldRetryUnstartedContinuousRecording,
  singleVideoSourceRecoveryAction,
} from './watch-playback-recovery';
import { WatchRecoveryActions } from './watch-recovery-actions';

const playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const terminalAuthorizationCheckTimeoutMs = 10_000;

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
  // The card already carries a viewer-bound opaque stream grant. Reuse it to
  // render Watch immediately, including for shared cards: blocking the route
  // on a second catalogue lookup was adding seconds before a person could
  // even press Play. This is deliberately not an authorization decision.
  // The ticket/media route validates the session and sealed stream, then
  // requires a current source proof unless it has a valid short-lived
  // server-issued receipt. No source bytes are exposed by this cache itself,
  // and a terminal shared denial removes the card through
  // `onSharedAccessDenied` below.
  const [item, setItem] = useState<VideoSpaceLibraryItem | undefined>(cachedItem);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    cachedItem ? 'ready' : 'loading',
  );
  const [refreshVersion, setRefreshVersion] = useState(0);

  const returnToVideoSpace = () => router.push('/');
  const reportPlaybackProblem = () => router.push('/support');
  const removeStaleSharedCard = useCallback(() => {
    if (user) videoSpaceLibraryMemory.remove(user.id, itemId);
  }, [itemId, user]);
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
      // grant. Do not put a second catalogue lookup on the Watch critical
      // path: the ticket/media route rechecks authorization before any bytes
      // are streamed, including for shared cards.
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
        if (!cancelled) setStatus('error');
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
            onSharedAccessDenied={removeStaleSharedCard}
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
  onSharedAccessDenied,
}: {
  video: VideoSpaceLibraryItem;
  onReturnToVideoSpace: () => void;
  onReportPlaybackProblem: () => void;
  onSharedAccessDenied: () => void;
}) {
  const [playbackError, setPlaybackError] = useState<PlaybackFailure | undefined>();
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [playbackGeneration, setPlaybackGeneration] = useState(0);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [recordingPlaybackUrl, setRecordingPlaybackUrl] = useState<string | undefined>();
  const [continuousRecordingReadyToOpen, setContinuousRecordingReadyToOpen] = useState(false);
  const [waitingForSourceHandoff, setWaitingForSourceHandoff] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const reachedCanPlay = useRef(false);
  const hasMeaningfulRecordingPlayback = useRef(false);
  const automaticTicketRetryUsed = useRef(false);
  const automaticSourceRecoveryUsed = useRef(false);
  const sourceRecoveryController = useRef<AbortController | undefined>(undefined);
  const terminalAuthorizationCheckUsed = useRef(false);
  const terminalAuthorizationCheckController = useRef<AbortController | undefined>(undefined);
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
    terminalAuthorizationCheckController.current?.abort();
    terminalAuthorizationCheckController.current = undefined;
    clearSourceHandoffRetry();
    committedVideoId.current = video.id;
    automaticSourceRecoveryUsed.current = false;
    terminalAuthorizationCheckUsed.current = false;
    setPlaybackError(undefined);
    resetPlaybackAttempt();
    setPlayerLoading(true);
    setPlaybackSpeed(1);
    setContinuousRecordingReadyToOpen(false);
    setRecordingPlaybackUrl(undefined);
    reachedCanPlay.current = false;
    hasMeaningfulRecordingPlayback.current = false;
    automaticTicketRetryUsed.current = false;
    return () => {
      sourceRecoveryController.current?.abort();
      terminalAuthorizationCheckController.current?.abort();
      clearSourceHandoffRetry();
    };
  }, [clearSourceHandoffRetry, video.id]);

  useEffect(() => {
    // A continuous source is a single-use server stream. With `preload=none`,
    // a ready ticket intentionally waits for the viewer to press Play rather
    // than allowing the native player to consume and abandon it while paused.
    setPlayerLoading(!isContinuousRecording || !playbackSource);
    reachedCanPlay.current = false;
    hasMeaningfulRecordingPlayback.current = false;
  }, [isContinuousRecording, playbackSource]);

  useEffect(() => {
    if (!isContinuousRecording) {
      setRecordingPlaybackUrl(undefined);
      setContinuousRecordingReadyToOpen(false);
      return;
    }
    if (!streamId) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setRecordingPlaybackUrl(undefined);
    setContinuousRecordingReadyToOpen(false);
    setPlayerLoading(true);
    void (async () => {
      // A normal library click starts this exact ticket before the SPA route
      // changes. Join it once for the initial opening; a later player retry
      // must issue a fresh one because a concat ticket is single-claim.
      const preloadedTicket =
        playbackAttempt === 0 ? takePreloadedContinuousRecordingTicket(streamIds) : undefined;
      try {
        const ticket = await (preloadedTicket?.promise ??
          createContinuousRecordingTicket(streamIds, controller.signal));
        if (!ticket.playbackUrl) {
          if (
            !cancelled &&
            shouldRetryInitialContinuousRecordingTicket({
              isContinuousRecording,
              errorCode: ticket.errorCode,
              automaticTicketRetryUsed: automaticTicketRetryUsed.current,
            })
          ) {
            // A failed source-zero authorization cannot have started the
            // native recording stream, so one fresh opaque ticket is safe.
            // Wait briefly for a just-completed eVault proof to become
            // reusable across replicas rather than surfacing a transient
            // source race as an immediate playback error.
            automaticTicketRetryUsed.current = true;
            retryTimer = setTimeout(() => {
              if (!cancelled && committedVideoId.current === video.id) {
                advancePlaybackAttempt();
              }
            }, initialContinuousRecordingTicketRetryDelayMs);
            return;
          }
          if (!cancelled) showPlaybackFailure(ticket.errorCode);
          return;
        }
        if (!cancelled) {
          setRecordingPlaybackUrl(ticket.playbackUrl);
          // The opaque ticket is ready, but a continuous server stream must
          // not start until the viewer explicitly presses the native Play
          // control. That prevents a paused preload from consuming a
          // single-claim stream before it is actually watched.
          setContinuousRecordingReadyToOpen(true);
          setPlayerLoading(false);
        }
      } finally {
        // The map retains a preloaded promise just long enough for an effect
        // replay to join it. Once this Watch attempt has adopted its result, do
        // not let a later automatic player retry reuse a claimed ticket.
        preloadedTicket?.release();
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
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

  const showPlaybackFailure = (code: unknown): void => {
    if (code === 'authorization_denied' && video.accessScope === 'shared') {
      // The server has conclusively rejected this viewer's current share.
      // Remove only this account's short-lived card so returning to the grid
      // cannot immediately reopen the now-quarantined stale item.
      onSharedAccessDenied();
    }
    setPlayerLoading(false);
    setPlaybackError(playbackFailureForAuthorizationCode(code));
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
          showPlaybackFailure(body?.error?.code);
          return;
        }
        setPlaybackError(undefined);
        advancePlaybackAttempt();
      } catch {
        if (controller.signal.aborted || committedVideoId.current !== video.id) return;
        showPlaybackFailure('remote_unavailable');
      } finally {
        // A change of item or an aborted request may take either early return
        // above. Releasing only this controller keeps a newer recovery intact
        // while preventing the current player from being stuck as "in flight".
        finishSourceRecovery();
      }
    })();
    return true;
  };

  const checkTerminalAuthorizationFailure = (): boolean => {
    if (
      isContinuousRecording ||
      !streamId ||
      !automaticSourceRecoveryUsed.current ||
      terminalAuthorizationCheckUsed.current
    ) {
      return false;
    }
    terminalAuthorizationCheckUsed.current = true;
    const controller = new AbortController();
    terminalAuthorizationCheckController.current = controller;
    const timeout = setTimeout(() => controller.abort(), terminalAuthorizationCheckTimeoutMs);
    setPlayerLoading(true);
    void (async () => {
      try {
        // A native media error hides the protected HTTP response body. After
        // the one recovery POST has already been used, make exactly one
        // bounded authorization request so a real revoked share is displayed
        // as such instead of falling through to a generic source error.
        const response = await fetch(
          `/api/evault/videos/${encodeURIComponent(streamId)}/authorize?priority=interactive`,
          {
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );
        const body = (await response.json().catch(() => undefined)) as
          | { error?: { code?: unknown } }
          | undefined;
        if (controller.signal.aborted || committedVideoId.current !== video.id) return;
        // A successful authorization cannot prove that this browser's native
        // source is healthy; do not restart it here or create another loop.
        showPlaybackFailure(response.ok ? 'remote_unavailable' : body?.error?.code);
      } catch {
        if (controller.signal.aborted || committedVideoId.current !== video.id) return;
        showPlaybackFailure('remote_unavailable');
      } finally {
        clearTimeout(timeout);
        if (terminalAuthorizationCheckController.current === controller) {
          terminalAuthorizationCheckController.current = undefined;
        }
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
                terminalAuthorizationCheckController.current?.abort();
                terminalAuthorizationCheckController.current = undefined;
                clearSourceHandoffRetry();
                automaticSourceRecoveryUsed.current = false;
                terminalAuthorizationCheckUsed.current = false;
                hasMeaningfulRecordingPlayback.current = false;
                automaticTicketRetryUsed.current = false;
                setPlaybackError(undefined);
                setPlayerLoading(true);
                setContinuousRecordingReadyToOpen(false);
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
            preload={isContinuousRecording ? 'none' : 'auto'}
            src={playbackSource}
            onLoadStart={(event) => {
              if (!isCurrentPlaybackElement(event.currentTarget)) return;
              if (isContinuousRecording) return;
              setContinuousRecordingReadyToOpen(false);
              setPlayerLoading(true);
            }}
            onPlay={(event) => {
              if (!isCurrentPlaybackElement(event.currentTarget) || !isContinuousRecording) return;
              // With `preload=none`, a continuous source should remain visibly
              // ready until the viewer's native Play action actually begins
              // its one server stream.
              setContinuousRecordingReadyToOpen(false);
              setPlayerLoading(true);
            }}
            onCanPlay={(event) => {
              if (!isCurrentPlaybackElement(event.currentTarget)) return;
              reachedCanPlay.current = true;
              clearSourceHandoffRetry();
              setContinuousRecordingReadyToOpen(false);
              setPlayerLoading(false);
            }}
            onError={(event) => {
              if (!isCurrentPlaybackElement(event.currentTarget)) return;
              // `canplay` can be reached from only a short buffered fMP4
              // fragment while the native player remains paused. Recover once
              // unless playback has actually advanced; after that point an
              // automatic restart would lose a viewer's place in a long call.
              if (
                shouldRetryUnstartedContinuousRecording({
                  isContinuousRecording,
                  hasPlaybackSource: Boolean(playbackSource),
                  hasMeaningfulPlayback: hasMeaningfulRecordingPlayback.current,
                  automaticTicketRetryUsed: automaticTicketRetryUsed.current,
                })
              ) {
                automaticTicketRetryUsed.current = true;
                setContinuousRecordingReadyToOpen(false);
                setPlayerLoading(true);
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
              if (checkTerminalAuthorizationFailure()) return;
              setPlayerLoading(false);
              setPlaybackError(playbackFailureForAuthorizationCode(undefined));
            }}
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = playbackSpeed;
            }}
            onTimeUpdate={(event) => {
              const element = event.currentTarget;
              if (!isCurrentPlaybackElement(element)) return;
              if (
                !element.paused &&
                Number.isFinite(element.currentTime) &&
                element.currentTime > 0.1
              ) {
                hasMeaningfulRecordingPlayback.current = true;
              }
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
          {continuousRecordingReadyToOpen && isContinuousRecording && playbackSource ? (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-sm font-medium text-white"
              role="status"
              aria-live="polite"
            >
              Press play to open this recording
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
