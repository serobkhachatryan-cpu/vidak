'use client';

import { WatchPageData } from '@w3ds/watch-page';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';

export function WatchPageFeature({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [shareAnnouncement, setShareAnnouncement] = useState('');
  const shareVideo = () => {
    void (async () => {
      const url = window.location.href;
      try {
        if (typeof navigator.share === 'function') {
          await navigator.share({ title: document.title, url });
          setShareAnnouncement('Share dialog opened.');
          return;
        }
        await navigator.clipboard.writeText(url);
        setShareAnnouncement('Video link copied.');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Clipboard permission can be unavailable in embedded browsers. The
        // browser prompt still exposes only the current public/unlisted URL.
        window.prompt('Copy this video link:', url);
      }
    })();
  };
  return (
    <ApplicationShell>
      <WatchPageData
        client={videoApiClient}
        videoId={videoId}
        onBrowseVideos={() => router.push('/')}
        onPlaybackHelp={() => router.push('/support')}
        actions={{ onShare: shareVideo }}
      />
      <p aria-live="polite" className="sr-only">
        {shareAnnouncement}
      </p>
    </ApplicationShell>
  );
}
