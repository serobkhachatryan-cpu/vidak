'use client';

import type { Video } from '@w3ds/types';
import { Button, VideoSpacePoster } from '@w3ds/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import {
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
  const cancelSharedAuthorizationWarmup = useCallback(() => {
    cancelScheduledAuthorization.current?.();
    cancelScheduledAuthorization.current = undefined;
  }, []);
  const warmSharedAuthorization = useCallback(() => {
    cancelSharedAuthorizationWarmup();
    const streamId = video.streamIds?.[0];
    if (video.accessScope !== 'shared' || !streamId) return;
    // Pointer-down/click remains the immediate, authoritative warmup path.
    warmSharedVideoAuthorization(`/api/evault/videos/${encodeURIComponent(streamId)}/authorize`);
  }, [cancelSharedAuthorizationWarmup, video.accessScope, video.streamIds]);
  const scheduleSharedAuthorizationWarmup = useCallback(() => {
    const streamId = video.streamIds?.[0];
    if (video.accessScope !== 'shared' || !streamId) return;
    cancelSharedAuthorizationWarmup();
    // A short dwell offers a likely Watch click a head start without starting
    // authorization for every visible card or building a hover-request burst.
    cancelScheduledAuthorization.current = scheduleSharedVideoAuthorizationWarmup(
      `/api/evault/videos/${encodeURIComponent(streamId)}/authorize`,
    );
  }, [cancelSharedAuthorizationWarmup, video.accessScope, video.streamIds]);
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
          onPointerEnter={scheduleSharedAuthorizationWarmup}
          onPointerLeave={cancelSharedAuthorizationWarmup}
          onFocus={scheduleSharedAuthorizationWarmup}
          onBlur={cancelSharedAuthorizationWarmup}
          onPointerDown={warmSharedAuthorization}
          onClick={warmSharedAuthorization}
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
            onPointerEnter={scheduleSharedAuthorizationWarmup}
            onPointerLeave={cancelSharedAuthorizationWarmup}
            onFocus={scheduleSharedAuthorizationWarmup}
            onBlur={cancelSharedAuthorizationWarmup}
            onPointerDown={warmSharedAuthorization}
            onClick={() => {
              warmSharedAuthorization();
              router.push(watchHref);
            }}
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
