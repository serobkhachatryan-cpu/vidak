'use client';

import { Button, EmptyState, ErrorState, Page, Spinner } from '@w3ds/ui';
import { useCallback, useEffect, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';

type LibraryVideo = {
  id: string;
  kind: 'call-recording' | 'video-message' | 'file';
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  streamId: string;
};

type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; items: LibraryVideo[] }
  | { status: 'error'; message: string };

export function MeshengerVideoLibraryPage() {
  const [state, setState] = useState<LibraryState>({ status: 'loading' });
  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/meshenger/videos', { cache: 'no-store' });
      const body = (await response.json()) as {
        items?: LibraryVideo[];
        error?: { message?: string };
      };
      if (!response.ok || !Array.isArray(body.items)) {
        throw new Error(body.error?.message ?? 'Meshenger videos are unavailable.');
      }
      setState({ status: 'ready', items: body.items });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Meshenger videos are unavailable.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ApplicationShell currentHref="/meshenger">
      <Page
        title="Meshenger videos"
        description="Your call recordings, video messages, circles, and other video files—played through a private Vidak route."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh library
          </Button>
        }
      >
        {state.status === 'loading' ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> Reading your Meshenger library…
          </div>
        ) : state.status === 'error' ? (
          <ErrorState
            title="Could not load Meshenger videos"
            description={state.message}
            retry={() => void load()}
          />
        ) : state.items.length === 0 ? (
          <EmptyState
            title="No Meshenger videos found"
            description="When videos are available in your W3DS vault, they will appear here."
          />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {state.items.map((video) => (
              <article
                key={video.id}
                className="overflow-hidden rounded-xl border border-border bg-surface-raised"
              >
                {/* biome-ignore lint/a11y/useMediaCaption: Historical source recordings do not include caption tracks. */}
                <video
                  className="aspect-video w-full bg-black"
                  controls
                  preload="metadata"
                  src={`/api/meshenger/videos/${encodeURIComponent(video.streamId)}`}
                />
                <div className="space-y-1 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                    {label(video)}
                  </p>
                  <h2 className="font-semibold text-foreground">{video.title}</h2>
                  <p className="text-sm text-muted-foreground">{details(video)}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </Page>
    </ApplicationShell>
  );
}

function label(video: LibraryVideo): string {
  if (video.kind === 'call-recording') return 'Call recording';
  if (video.kind === 'video-message')
    return video.shape === 'circle' ? 'Video circle' : 'Video message';
  return 'Video file';
}

function details(video: LibraryVideo): string {
  const values = [
    video.durationSeconds !== undefined ? formatDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
  ].filter(Boolean);
  return values.join(' · ') || 'Meshenger';
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
