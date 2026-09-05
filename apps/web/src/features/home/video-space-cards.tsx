'use client';

import type { Video } from '@w3ds/types';
import { Button, VideoSpacePoster } from '@w3ds/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';
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
  const authorizationWarmupStarted = useRef(false);
  const visibilityLabel = videoSpaceVisibilityLabels[video.visibility];
  const watchHref = `/watch/space/${encodeURIComponent(video.id)}`;
  const canPlay = canPlayLibraryVideo(video);
  const warmSharedAuthorization = useCallback(() => {
    const streamId = video.streamIds?.[0];
    if (video.accessScope !== 'shared' || !streamId || authorizationWarmupStarted.current) return;
    authorizationWarmupStarted.current = true;
    // This proves only the current viewer's source access. It deliberately
    // does not resolve or preload private media bytes before Watch is chosen.
    void fetch(`/api/evault/videos/${encodeURIComponent(streamId)}/authorize`, {
      cache: 'no-store',
      credentials: 'same-origin',
    }).catch(() => {
      // A click still uses the authoritative media route. Let a later hover
      // make another best-effort attempt after a transient network failure.
      authorizationWarmupStarted.current = false;
    });
  }, [video.accessScope, video.streamIds]);
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
          aria-label={`Watch ${video.title}`}
          className="block"
          onPointerEnter={warmSharedAuthorization}
          onFocus={warmSharedAuthorization}
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
            onPointerEnter={warmSharedAuthorization}
            onFocus={warmSharedAuthorization}
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
