'use client';

import type { Video } from '@w3ds/types';
import { Button, VideoSpacePoster } from '@w3ds/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import { preloadContinuousRecordingTicket } from '../watch/recording-ticket-preload';
import {
  cancelCancellableSharedVideoAuthorizationHoverWork,
  scheduleSharedVideoAuthorizationWarmup,
  warmSharedVideoAuthorization,
} from './shared-video-authorization-warmup';
import {
  canPlayLibraryVideo,
  libraryCardDetails,
  ownedVideoPoster,
  ownedVideoSpaceVisibility,
  type VideoSpaceLibraryItem,
  videoSpaceVisibilityLabels,
} from './video-space-model';

export function OwnedVideoCard({
  video,
  isPending,
  onWatch,
  onContinueDraft,
  onChangeVisibility,
  onManageSharing,
}: {
  video: Video;
  isPending: boolean;
  onWatch: (video: Video) => void;
  onContinueDraft: (video: Video) => void;
  onChangeVisibility: (video: Video, next: 'private') => void;
  onManageSharing: (video: Video) => void;
}) {
  const visibility = ownedVideoSpaceVisibility(video);
  const canWatch =
    video.status === 'published' &&
    Boolean(video.publicVideoId) &&
    (video.visibility === 'public' || video.visibility === 'unlisted');
  const poster = ownedVideoPoster(video);

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
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
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{video.title}</h3>
          <p className="text-sm text-muted-foreground">
            {video.status === 'draft' ? 'Your Vidak draft' : 'Your Vidak video'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {video.status === 'draft' ? (
            <>
              <Button size="sm" onClick={() => onContinueDraft(video)}>
                Resume draft
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onManageSharing(video)}>
                Share / manage access
              </Button>
            </>
          ) : (
            <>
              {canWatch ? (
                <Button size="sm" onClick={() => onWatch(video)}>
                  Watch video
                </Button>
              ) : null}
              {visibility.id === 'public' || visibility.id === 'shared-by-me' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={isPending}
                  loadingText="Making private"
                  onClick={() => onChangeVisibility(video, 'private')}
                >
                  Unpublish &amp; make private
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => onManageSharing(video)}>
                Share / manage access
              </Button>
            </>
          )}
        </div>
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
  const streamIds = video.streamIds ?? [];
  const streamId = streamIds[0];
  const isSharedContinuousRecording = video.accessScope === 'shared' && streamIds.length > 1;
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

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      {canPlay ? (
        <Link
          href={watchHref}
          prefetch={false}
          aria-label={`Watch ${video.title}`}
          className="block"
          onPointerEnter={
            isSharedContinuousRecording ? undefined : scheduleSharedAuthorizationWarmup
          }
          onPointerLeave={cancelSharedAuthorizationWarmup}
          onFocus={isSharedContinuousRecording ? undefined : scheduleSharedAuthorizationWarmup}
          onBlur={cancelSharedAuthorizationWarmup}
          onPointerDown={
            isSharedContinuousRecording ? cancelSharedAuthorizationWarmup : warmSharedAuthorization
          }
          {...(isSharedContinuousRecording
            ? {
                // Next only invokes this for a real same-document navigation.
                // New tabs and modified clicks have no in-memory handoff to
                // join, so they mint their own single-use ticket.
                onNavigate: preloadContinuousTicket,
              }
            : { onClick: warmSharedAuthorization })}
        >
          {poster}
        </Link>
      ) : (
        poster
      )}
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{video.title}</h3>
          <p className="text-sm text-muted-foreground">{libraryCardDetails(video)}</p>
        </div>
        {canPlay ? (
          <Button
            size="sm"
            onPointerEnter={
              isSharedContinuousRecording ? undefined : scheduleSharedAuthorizationWarmup
            }
            onPointerLeave={cancelSharedAuthorizationWarmup}
            onFocus={isSharedContinuousRecording ? undefined : scheduleSharedAuthorizationWarmup}
            onBlur={cancelSharedAuthorizationWarmup}
            onPointerDown={
              isSharedContinuousRecording
                ? cancelSharedAuthorizationWarmup
                : warmSharedAuthorization
            }
            onClick={prepareButtonWatch}
          >
            Watch video
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {video.sourceAccess === 'checking'
              ? 'Vidak is retrying this shared source. Playback will be available once its permission check completes.'
              : 'Playback is unavailable until Vidak verifies the source permission.'}
          </p>
        )}
      </div>
    </article>
  );
}
