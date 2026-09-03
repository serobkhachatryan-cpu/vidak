'use client';

import { isRenderableThumbnailUrl, type Video } from '@w3ds/types';
import { Button, VideoSpacePoster } from '@w3ds/ui';
import {
  libraryCardDetails,
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
}: {
  video: Video;
  isPending: boolean;
  onWatch: (video: Video) => void;
  onContinueDraft: (video: Video) => void;
  onChangeVisibility: (video: Video, next: 'private') => void;
}) {
  const visibility = ownedVideoSpaceVisibility(video);
  const canWatch =
    video.status === 'published' &&
    Boolean(video.publicVideoId) &&
    (video.visibility === 'public' || video.visibility === 'unlisted');
  const existingPoster = isRenderableThumbnailUrl(video.thumbnailUrl)
    ? video.thumbnailUrl
    : undefined;
  const generatedPoster = `/api/videos/owned/${encodeURIComponent(video.id)}/preview`;
  const processing = video.status === 'processing';

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      <VideoSpacePoster
        title={video.title}
        {...(existingPoster
          ? { posterUrl: existingPoster, fallbackPosterUrl: generatedPoster }
          : { posterUrl: generatedPoster })}
        state={processing ? 'processing' : existingPoster ? 'ready' : 'processing'}
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
            <Button size="sm" onClick={() => onContinueDraft(video)}>
              Resume draft
            </Button>
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
                  loadingText="Updating visibility"
                  onClick={() => onChangeVisibility(video, 'private')}
                >
                  Make private
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

export function LibraryVideoCard({ video }: { video: VideoSpaceLibraryItem }) {
  const visibilityLabel = videoSpaceVisibilityLabels[video.visibility];
  const watchHref = `/watch/space/${encodeURIComponent(video.id)}`;

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      <a href={watchHref} aria-label={`Watch ${video.title}`} className="block">
        <VideoSpacePoster
          title={video.title}
          {...(video.previewUrl ? { posterUrl: video.previewUrl } : {})}
          state={video.previewState ?? (video.previewUrl ? 'processing' : 'unavailable')}
          {...(video.durationSeconds !== undefined
            ? { durationSeconds: video.durationSeconds }
            : {})}
          visibilityLabel={visibilityLabel}
          locked={video.visibility === 'private'}
          loadWhenVisible
        />
      </a>
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">{video.title}</h3>
          <p className="text-sm text-muted-foreground">{libraryCardDetails(video)}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            window.location.assign(watchHref);
          }}
        >
          Watch video
        </Button>
      </div>
    </article>
  );
}
