'use client';

import type { Video } from '@w3ds/types';
import { Button, VideoSpacePoster } from '@w3ds/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ComponentProps, useCallback, useEffect, useRef } from 'react';
import { preloadContinuousRecordingTicket } from '../watch/recording-ticket-preload';
import {
  cancelCancellableSharedVideoAuthorizationHoverWork,
  scheduleSharedVideoAuthorizationWarmup,
  warmSharedVideoAuthorization,
} from './shared-video-authorization-warmup';
import {
  canPlayLibraryVideo,
  formatSpaceDuration,
  libraryCardDetails,
  libraryVideoCardPresentation,
  ownedVideoCardPresentation,
  ownedVideoPoster,
  ownedVideoSpaceVisibility,
  type VideoSpaceCardPresentation,
  type VideoSpaceLibraryItem,
  videoSpaceVisibilityLabels,
} from './video-space-model';

type CardLinkInteractionProps = Pick<
  ComponentProps<typeof Link>,
  | 'onPointerEnter'
  | 'onPointerLeave'
  | 'onFocus'
  | 'onBlur'
  | 'onPointerDown'
  | 'onClick'
  | 'onNavigate'
>;

function CardTitle({
  id,
  title,
  href,
  actionLabel,
  linkInteractionProps,
}: {
  id: string;
  title: string;
  href?: string;
  actionLabel?: string;
  linkInteractionProps?: CardLinkInteractionProps;
}) {
  return (
    <h3 id={id} className="font-semibold text-foreground">
      {href ? (
        <Link
          href={href}
          prefetch={false}
          aria-label={actionLabel ? `${actionLabel}: ${title}` : title}
          className="rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          {...linkInteractionProps}
        >
          {title}
        </Link>
      ) : (
        title
      )}
    </h3>
  );
}

function CardRelationship({
  presentation,
  details,
}: {
  presentation: VideoSpaceCardPresentation;
  details?: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
        {presentation.relationshipLabel}
      </p>
      <p className="text-sm text-muted-foreground">{presentation.relationshipDescription}</p>
      {details ? <p className="text-sm text-muted-foreground">{details}</p> : null}
    </div>
  );
}

function CardActions({
  presentation,
  onPrimaryAction,
  onSecondaryAction,
}: {
  presentation: VideoSpaceCardPresentation;
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
}) {
  if (presentation.unavailable) {
    return (
      <div
        className="rounded-lg border border-border bg-muted/30 p-3 text-sm"
        role="status"
        aria-live="polite"
      >
        <p className="font-medium text-foreground">{presentation.unavailable.label}</p>
        <p className="mt-1 text-muted-foreground">{presentation.unavailable.description}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {presentation.primaryAction && onPrimaryAction ? (
        <div className="space-y-1">
          <Button size="sm" onClick={onPrimaryAction}>
            {presentation.primaryAction.label}
          </Button>
          <p className="text-xs text-muted-foreground">{presentation.primaryAction.description}</p>
        </div>
      ) : null}
      {presentation.secondaryAction && onSecondaryAction ? (
        <div className="space-y-1 border-t border-border pt-2">
          <p className="text-xs font-medium text-muted-foreground">More options</p>
          <Button size="sm" variant="secondary" onClick={onSecondaryAction}>
            {presentation.secondaryAction.label}
          </Button>
          <p className="text-xs text-muted-foreground">
            {presentation.secondaryAction.description}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ownedVideoDetails(video: Video): string | undefined {
  const values = [
    video.durationSeconds !== undefined ? formatSpaceDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
  ].filter(Boolean);
  return values.length ? values.join(' · ') : undefined;
}

export function OwnedVideoCard({ video }: { video: Video }) {
  const router = useRouter();
  const visibility = ownedVideoSpaceVisibility(video);
  const presentation = ownedVideoCardPresentation(video);
  const poster = ownedVideoPoster(video);
  const watchHref = video.publicVideoId
    ? `/watch/${encodeURIComponent(video.publicVideoId)}`
    : undefined;
  const draftHref = `/upload?draft=${encodeURIComponent(video.id)}`;
  const sharingHref = `/videos/${encodeURIComponent(video.id)}/sharing`;
  const details = ownedVideoDetails(video);
  const primaryHref =
    presentation.primaryAction?.id === 'continue-editing'
      ? draftHref
      : presentation.primaryAction?.id === 'watch'
        ? watchHref
        : presentation.primaryAction?.id === 'manage-access'
          ? sharingHref
          : undefined;
  const titleId = `video-card-title-${encodeURIComponent(video.id)}`;

  return (
    <article
      className="overflow-hidden rounded-xl border border-border bg-surface-raised"
      aria-labelledby={titleId}
      data-card-kind={presentation.kind}
    >
      {primaryHref ? (
        <Link
          href={primaryHref}
          prefetch={false}
          aria-label={`${presentation.primaryAction?.label}: ${video.title}`}
          className="block rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <VideoSpacePoster
            title={video.title}
            {...(poster.existingPoster
              ? { posterUrl: poster.existingPoster, fallbackPosterUrl: poster.generatedPoster }
              : { posterUrl: poster.generatedPoster })}
            state={poster.state}
            durationSeconds={video.durationSeconds}
            visibilityLabel={visibility.label}
            locked={visibility.id === 'private'}
            loadWhenVisible
          />
        </Link>
      ) : (
        <VideoSpacePoster
          title={video.title}
          {...(poster.existingPoster
            ? { posterUrl: poster.existingPoster, fallbackPosterUrl: poster.generatedPoster }
            : { posterUrl: poster.generatedPoster })}
          state={poster.state}
          durationSeconds={video.durationSeconds}
          visibilityLabel={visibility.label}
          locked={visibility.id === 'private'}
          loadWhenVisible
        />
      )}
      <div className="space-y-3 p-4">
        <CardTitle
          id={titleId}
          title={video.title}
          {...(primaryHref ? { href: primaryHref } : {})}
          {...(presentation.primaryAction?.label
            ? { actionLabel: presentation.primaryAction.label }
            : {})}
        />
        <CardRelationship presentation={presentation} {...(details ? { details } : {})} />
        <CardActions
          presentation={presentation}
          {...(primaryHref ? { onPrimaryAction: () => router.push(primaryHref) } : {})}
          {...(presentation.secondaryAction
            ? { onSecondaryAction: () => router.push(sharingHref) }
            : {})}
        />
      </div>
    </article>
  );
}

export function LibraryVideoCard({ video }: { video: VideoSpaceLibraryItem }) {
  const router = useRouter();
  const cancelScheduledAuthorization = useRef<(() => void) | undefined>(undefined);
  const visibilityLabel = videoSpaceVisibilityLabels[video.visibility];
  const watchHref = `/watch/space/${encodeURIComponent(video.id)}`;
  const canPlay = canPlayLibraryVideo(video);
  const presentation = libraryVideoCardPresentation(video);
  const streamIds = video.streamIds ?? [];
  const streamId = streamIds[0];
  const isSharedContinuousRecording = video.accessScope === 'shared' && streamIds.length > 1;
  const titleId = `video-card-title-${encodeURIComponent(video.id)}`;
  const cancelSharedAuthorizationWarmup = useCallback(() => {
    cancelScheduledAuthorization.current?.();
    cancelScheduledAuthorization.current = undefined;
  }, []);
  const preloadContinuousTicket = useCallback(() => {
    cancelSharedAuthorizationWarmup();
    if (!isSharedContinuousRecording) return;
    // A hover from another card is speculative work with a distinct server
    // pending key. Stop it before the selected recording performs the one
    // real source-zero ticket preflight.
    cancelCancellableSharedVideoAuthorizationHoverWork();
    // A long shared recording has a single source-zero handoff: start the
    // actual opaque ticket only for a confirmed in-app navigation. The Watch
    // page joins this promise instead of issuing a second authorization path.
    preloadContinuousRecordingTicket(streamIds);
  }, [cancelSharedAuthorizationWarmup, isSharedContinuousRecording, streamIds]);
  const warmSharedAuthorization = useCallback(() => {
    cancelSharedAuthorizationWarmup();
    if (isSharedContinuousRecording || video.accessScope !== 'shared' || !streamId) return;
    // Pointer-down/click remains the immediate, authoritative warmup path.
    warmSharedVideoAuthorization(`/api/evault/videos/${encodeURIComponent(streamId)}/authorize`);
  }, [cancelSharedAuthorizationWarmup, isSharedContinuousRecording, streamId, video.accessScope]);
  const scheduleSharedAuthorizationWarmup = useCallback(() => {
    if (isSharedContinuousRecording || video.accessScope !== 'shared' || !streamId) return;
    cancelSharedAuthorizationWarmup();
    // A short dwell offers a likely Watch click a head start without starting
    // authorization for every visible card or building a hover-request burst.
    cancelScheduledAuthorization.current = scheduleSharedVideoAuthorizationWarmup(
      `/api/evault/videos/${encodeURIComponent(streamId)}/authorize`,
    );
  }, [cancelSharedAuthorizationWarmup, isSharedContinuousRecording, streamId, video.accessScope]);
  const prepareButtonWatch = useCallback(() => {
    if (isSharedContinuousRecording) preloadContinuousTicket();
    else warmSharedAuthorization();
    router.push(watchHref);
  }, [
    isSharedContinuousRecording,
    preloadContinuousTicket,
    router,
    warmSharedAuthorization,
    watchHref,
  ]);
  useEffect(
    () => () => {
      cancelSharedAuthorizationWarmup();
    },
    [cancelSharedAuthorizationWarmup],
  );

  const poster = (
    <VideoSpacePoster
      title={video.title}
      {...(video.previewUrl ? { posterUrl: video.previewUrl } : {})}
      state={
        canPlay
          ? (video.previewState ?? (video.previewUrl ? 'processing' : 'unavailable'))
          : 'restricted'
      }
      {...(video.durationSeconds !== undefined ? { durationSeconds: video.durationSeconds } : {})}
      visibilityLabel={visibilityLabel}
      locked={video.visibility === 'private'}
      loadWhenVisible
    />
  );

  const watchLinkProps: CardLinkInteractionProps = {
    onPointerLeave: cancelSharedAuthorizationWarmup,
    onBlur: cancelSharedAuthorizationWarmup,
    onPointerDown: isSharedContinuousRecording
      ? cancelSharedAuthorizationWarmup
      : warmSharedAuthorization,
    ...(isSharedContinuousRecording
      ? {
          // Next only invokes this for a real same-document navigation. New
          // tabs and modified clicks mint their own single-use ticket.
          onNavigate: preloadContinuousTicket,
        }
      : {
          onPointerEnter: scheduleSharedAuthorizationWarmup,
          onFocus: scheduleSharedAuthorizationWarmup,
          onPointerDown: warmSharedAuthorization,
          onClick: warmSharedAuthorization,
        }),
  };

  return (
    <article
      className="overflow-hidden rounded-xl border border-border bg-surface-raised"
      aria-labelledby={titleId}
      data-card-kind={presentation.kind}
    >
      {canPlay ? (
        <Link
          href={watchHref}
          prefetch={false}
          aria-label={`Watch video: ${video.title}`}
          className="block rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          {...watchLinkProps}
        >
          {poster}
        </Link>
      ) : (
        poster
      )}
      <div className="space-y-3 p-4">
        <CardTitle
          id={titleId}
          title={video.title}
          {...(canPlay
            ? {
                href: watchHref,
                ...(presentation.primaryAction?.label
                  ? { actionLabel: presentation.primaryAction.label }
                  : {}),
                linkInteractionProps: watchLinkProps,
              }
            : {})}
        />
        <CardRelationship presentation={presentation} details={libraryCardDetails(video)} />
        <CardActions
          presentation={presentation}
          {...(canPlay ? { onPrimaryAction: prepareButtonWatch } : {})}
        />
      </div>
    </article>
  );
}
