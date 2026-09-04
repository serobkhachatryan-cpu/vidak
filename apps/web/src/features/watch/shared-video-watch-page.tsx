'use client';

import type { Video } from '@w3ds/types';
import { Button, ErrorState, Page, Spinner } from '@w3ds/ui';
import { WatchPage } from '@w3ds/watch-page';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

/** A recipient-facing watch page for a Vidak-hosted private share. */
export function SharedVideoWatchPage({ shareToken }: { shareToken: string }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>('loading');
  const [video, setVideo] = useState<Video>();

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/videos/shared/${encodeURIComponent(shareToken)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          router.replace(`/login?returnTo=${encodeURIComponent(`/watch/shared/${shareToken}`)}`);
          return undefined;
        }
        if (response.status === 404) return null;
        if (!response.ok) throw new Error();
        return (await response.json()) as Video;
      })
      .then((next) => {
        if (cancelled || next === undefined) return;
        if (next === null) {
          setState('missing');
          return;
        }
        setVideo(next);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [router, shareToken]);

  return (
    <ApplicationShell>
      <Page
        title={video?.title ?? 'Shared video'}
        description="This video was shared with your eID. Playback remains private to the people selected by its owner."
        containerSize="lg"
        actions={
          <Button variant="secondary" onClick={() => router.push('/?tab=shared')}>
            Back to shared videos
          </Button>
        }
      >
        {state === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> Opening shared video…
          </div>
        ) : null}
        {state === 'missing' ? (
          <ErrorState
            title="This video is not available"
            description="It may have been removed, made private, or not shared with this eID."
            action={
              <Button onClick={() => router.push('/?tab=shared')}>Back to shared videos</Button>
            }
          />
        ) : null}
        {state === 'error' ? (
          <ErrorState
            title="Could not open shared video"
            description="Try again. If it continues, ask the owner to check their sharing settings."
            action={<Button onClick={() => window.location.reload()}>Try again</Button>}
          />
        ) : null}
        {state === 'ready' && video ? (
          <WatchPage
            video={video}
            {...(video.mediaContentUrl
              ? { mediaSrc: video.mediaContentUrl, mediaState: 'ready' as const }
              : { mediaState: 'error' as const })}
            onBrowseVideos={() => router.push('/?tab=shared')}
            onPlaybackHelp={() => router.push('/support')}
          />
        ) : null}
      </Page>
    </ApplicationShell>
  );
}
