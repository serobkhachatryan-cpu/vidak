'use client';

import { isRenderableThumbnailUrl } from '@w3ds/types';
import { useEffect, useState } from 'react';
import { Badge, Skeleton } from './primitives';

export type VideoSpacePosterState = 'ready' | 'processing' | 'unavailable';

export interface VideoSpacePosterProps {
  title: string;
  posterUrl?: string;
  fallbackPosterUrl?: string;
  state?: VideoSpacePosterState;
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function VideoSpacePoster({
  title,
  posterUrl,
  fallbackPosterUrl,
  state = 'processing',
  durationSeconds,
  visibilityLabel,
  locked = false,
}: VideoSpacePosterProps) {
  const [source, setSource] = useState<string | undefined>(() =>
    state === 'ready' && posterUrl && isRenderableThumbnailUrl(posterUrl) ? posterUrl : undefined,
  );
  const [failed, setFailed] = useState(state === 'unavailable');
  const [usedFallback, setUsedFallback] = useState(false);

  useEffect(() => {
    setFailed(state === 'unavailable');
    setUsedFallback(false);
    if (state === 'ready' && posterUrl && isRenderableThumbnailUrl(posterUrl)) {
      setSource(posterUrl);
      return;
    }
    setSource(undefined);
    if (state !== 'processing' || !posterUrl || !isRenderableThumbnailUrl(posterUrl)) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(posterUrl, { cache: 'no-store' });
        if (cancelled) return;
        const type = response.headers.get('content-type') ?? '';
        if (response.ok && type.startsWith('image/')) {
          setSource(posterUrl);
          return;
        }
        if (response.status === 202) {
          window.setTimeout(() => {
            void poll();
          }, 2000);
          return;
        }
        if (fallbackPosterUrl && fallbackPosterUrl !== posterUrl) {
          setUsedFallback(true);
          setSource(fallbackPosterUrl);
          return;
        }
        setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [fallbackPosterUrl, posterUrl, state]);

  const showImage = Boolean(source) && !failed;
  const showProcessing = !showImage && !failed && state !== 'unavailable';

  return (
    <div className="relative overflow-hidden bg-muted">
      {showImage && source ? (
        <img
          src={source}
          alt=""
          loading="lazy"
          className="aspect-video w-full object-cover"
          onError={() => {
            if (!usedFallback && fallbackPosterUrl && fallbackPosterUrl !== source) {
              setUsedFallback(true);
              setSource(fallbackPosterUrl);
              return;
            }
            setFailed(true);
          }}
        />
      ) : showProcessing ? (
        <VideoSpaceProcessingPoster
          title={title}
          {...(durationSeconds !== undefined ? { durationSeconds } : {})}
          {...(visibilityLabel ? { visibilityLabel } : {})}
          locked={locked}
        />
      ) : (
        <VideoSpaceUnavailablePoster
          title={title}
          {...(durationSeconds !== undefined ? { durationSeconds } : {})}
          {...(visibilityLabel ? { visibilityLabel } : {})}
          locked={locked}
        />
      )}
      <VideoSpacePosterBadges
        {...(durationSeconds !== undefined ? { durationSeconds } : {})}
        {...(visibilityLabel ? { visibilityLabel } : {})}
        locked={locked}
      />
    </div>
  );
}

export function VideoSpaceProcessingPoster({
  title,
  durationSeconds,
  visibilityLabel,
  locked = false,
}: {
  title: string;
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}) {
  return (
    <div
      className="relative aspect-video w-full overflow-hidden bg-muted"
      role="status"
      aria-label={`${title} Preparing preview`}
    >
      <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
      <VideoSpacePosterBadges
        {...(durationSeconds !== undefined ? { durationSeconds } : {})}
        {...(visibilityLabel ? { visibilityLabel } : {})}
        locked={locked}
      />
    </div>
  );
}

export function VideoSpaceUnavailablePoster({
  title,
  durationSeconds,
  visibilityLabel,
  locked = false,
}: {
  title: string;
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}) {
  return (
    <div
      className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 bg-muted px-4 text-center"
      role="img"
      aria-label={`${title} Preview unavailable`}
    >
      <VideoIcon />
      <p className="line-clamp-2 font-sans text-sm font-semibold text-foreground">{title}</p>
      {durationSeconds !== undefined ? (
        <p className="font-sans text-xs text-muted-foreground">{formatDuration(durationSeconds)}</p>
      ) : null}
      <p className="font-sans text-[11px] text-muted-foreground">Preview unavailable</p>
      <VideoSpacePosterBadges
        {...(durationSeconds !== undefined ? { durationSeconds } : {})}
        {...(visibilityLabel ? { visibilityLabel } : {})}
        locked={locked}
      />
    </div>
  );
}

function VideoSpacePosterBadges({
  durationSeconds,
  visibilityLabel,
  locked,
}: {
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}) {
  return (
    <>
      {visibilityLabel ? (
        <Badge
          tone="muted"
          className="absolute left-2 top-2 bg-black/75 text-white"
          aria-label={locked ? `${visibilityLabel}, locked` : visibilityLabel}
        >
          {locked ? `🔒 ${visibilityLabel}` : visibilityLabel}
        </Badge>
      ) : null}
      {durationSeconds !== undefined ? (
        <Badge
          tone="muted"
          className="absolute bottom-2 right-2 bg-black/80 text-white"
          aria-label={`Duration ${formatDuration(durationSeconds)}`}
        >
          {formatDuration(durationSeconds)}
        </Badge>
      ) : null}
    </>
  );
}

function VideoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-8 w-8 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <rect x="3" y="6" width="14" height="12" rx="2" />
      <path d="M17 10.5 21 8v8l-4-2.5" />
    </svg>
  );
}
