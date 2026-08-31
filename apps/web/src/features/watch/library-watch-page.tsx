'use client';

import { Button, ErrorState, Page, Spinner, Text } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import {
  formatSpaceDuration,
  type VideoSpaceLibraryItem,
  videoSpaceVisibilityLabels,
} from '../home/video-space-model';
import { elapsedRecordingDuration, totalRecordingDuration } from '../meshenger/segmented-playback';

export function LibraryWatchPage({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [item, setItem] = useState<VideoSpaceLibraryItem | undefined>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/evault/videos?scope=owned', { cache: 'no-store' });
        const body = (await response.json()) as { items?: VideoSpaceLibraryItem[] };
        if (!response.ok || !Array.isArray(body.items)) throw new Error();
        if (cancelled) return;
        const found = body.items.find((candidate) => candidate.id === itemId);
        if (found) {
          setItem(found);
          setStatus('ready');
          return;
        }
        const sharedResponse = await fetch('/api/evault/videos?scope=shared', {
          cache: 'no-store',
        });
        const sharedBody = (await sharedResponse.json()) as { items?: VideoSpaceLibraryItem[] };
        if (!sharedResponse.ok || !Array.isArray(sharedBody.items)) throw new Error();
        if (cancelled) return;
        const shared = sharedBody.items.find((candidate) => candidate.id === itemId);
        setItem(shared);
        setStatus(shared ? 'ready' : 'missing');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

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
        {status === 'ready' && item ? <LibraryWatchPlayer video={item} /> : null}
      </Page>
    </ApplicationShell>
  );
}

function LibraryWatchPlayer({ video }: { video: VideoSpaceLibraryItem }) {
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [currentSegmentSeconds, setCurrentSegmentSeconds] = useState(0);
  const [segmentDurations, setSegmentDurations] = useState<Array<number | undefined>>([]);
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
    continuePlayback.current = false;
  }, [video.id]);

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
      {/* biome-ignore lint/a11y/useMediaCaption: Historical source recordings do not include caption tracks. */}
      <video
        key={streamId}
        ref={player}
        aria-label={video.title}
        className="aspect-video w-full rounded-xl bg-black"
        controls
        preload="metadata"
        src={`/api/evault/videos/${encodeURIComponent(streamId)}`}
        onCanPlay={() => {
          if (!continuePlayback.current) return;
          continuePlayback.current = false;
          void player.current?.play().catch(() => undefined);
        }}
        onLoadedMetadata={() => {
          const duration = player.current?.duration;
          if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return;
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
          continuePlayback.current = true;
          setSegmentIndex((current) => current + 1);
        }}
      />
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
