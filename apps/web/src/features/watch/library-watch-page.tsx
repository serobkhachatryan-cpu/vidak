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
import { elapsedRecordingDuration, totalRecordingDuration } from '../meshenger/segmented-playback';

export function LibraryWatchPage({ itemId }: { itemId: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  const cachedItem = user ? videoSpaceLibraryMemory.get(user.id, itemId) : undefined;
  const [item, setItem] = useState<VideoSpaceLibraryItem | undefined>(cachedItem);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    cachedItem ? 'ready' : 'loading',
  );

  useEffect(() => {
    let cancelled = false;
    const cached = user ? videoSpaceLibraryMemory.get(user.id, itemId) : undefined;
    if (cached) {
      setItem(cached);
      setStatus('ready');
    } else {
      setItem(undefined);
      setStatus('loading');
    }
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
        if (cached) return;
        setItem(undefined);
        setStatus('missing');
      } catch {
        if (!cancelled && !cached) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, user?.id]);

  return (
    <ApplicationShell>
      <Page
        title={item?.title ?? 'Watch'}
        description="Playback stays on this page. Grid cards only show a still preview."
        containerSize="lg"
        actions={
          <Button variant="secondary" onClick={() => router.push('/')}>
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
            description="Refresh your video space and try again."
            retry={() => router.push('/')}
            retryLabel="Back to your video space"
          />
        ) : null}
        {status === 'missing' ? (
          <ErrorState
            title="This video is not available"
            description="It may have been removed or is no longer authorized for this account."
            retry={() => router.push('/')}
            retryLabel="Back to your video space"
          />
        ) : null}
        {status === 'ready' && item && !canPlayLibraryVideo(item) ? (
          <ErrorState
            title="Shared playback is paused"
            description="Vidak has listed this video as shared with you, but it will not play it until source permission can be verified for every request."
            retry={() => router.push('/')}
            retryLabel="Back to your video space"
          />
        ) : null}
        {status === 'ready' && item && canPlayLibraryVideo(item) ? (
          <LibraryWatchPlayer video={item} />
        ) : null}
      </Page>
    </ApplicationShell>
  );
}

function LibraryWatchPlayer({ video }: { video: VideoSpaceLibraryItem }) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [currentSegmentSeconds, setCurrentSegmentSeconds] = useState(0);
  const [segmentDurations, setSegmentDurations] = useState<Array<number | undefined>>([]);
  const [playbackError, setPlaybackError] = useState(false);
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [playerLoading, setPlayerLoading] = useState(true);
  const continuePlayback = useRef(false);
  const player = useRef<HTMLVideoElement>(null);
  const streamId = video.streamIds?.[segmentIndex] ?? video.streamIds?.[0];
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
    setPlaybackError(false);
    setPlaybackAttempt(0);
    setPlayerLoading(true);
    continuePlayback.current = false;
  }, [video.id]);

  useEffect(() => {
    setPlayerLoading(true);
  }, [streamId, playbackAttempt]);

  if (!streamId) {
    return (
      <ErrorState
        title="This recording has no playable file"
        description="Refresh your video space to renew the private playback link."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
        {videoSpaceVisibilityLabels[video.visibility]}
      </p>
      {playbackError ? (
        <ErrorState
          title="Video source is unavailable"
          description="The source link may have expired. Retry to refresh it once."
          retry={() => {
            setPlaybackError(false);
            setPlayerLoading(true);
            setPlaybackAttempt((attempt) => attempt + 1);
          }}
          retryLabel="Retry playback"
        />
      ) : (
        <div className="relative">
          {/* biome-ignore lint/a11y/useMediaCaption: Historical source recordings do not include caption tracks. */}
          <video
            key={`${streamId}:${playbackAttempt}`}
            ref={player}
            aria-label={video.title}
            className="aspect-video w-full rounded-xl bg-black"
            controls
            preload="metadata"
            src={`/api/evault/videos/${encodeURIComponent(streamId)}?attempt=${playbackAttempt}`}
            onCanPlay={() => {
              setPlayerLoading(false);
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
      {(video.streamIds?.length ?? 0) > 1 ? (
        <Text size="sm" tone="muted">
          One recording · part {segmentIndex + 1} of {video.streamIds?.length} · continues
          automatically
          {totalDuration !== undefined
            ? ` · ${formatSpaceDuration(Math.min(elapsedDuration, totalDuration))} / ${formatSpaceDuration(totalDuration)}`
            : ''}
        </Text>
      ) : null}
    </div>
  );
}
