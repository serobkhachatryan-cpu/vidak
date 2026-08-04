'use client';

import { Button, Header, Sidebar } from '@w3ds/ui';
import { WatchPageData } from '@w3ds/watch-page';
import { useEffect, useState } from 'react';
import { videoApiClient } from '../../lib/video-api-client';

const navigation = [
  { label: 'Home', href: '/', icon: '⌂' },
  { label: 'Subscriptions', href: '/subscriptions', icon: '◉' },
  { label: 'Library', href: '/library', icon: '▣' },
];

export function WatchPageFeature({ videoId }: { videoId: string }) {
  const [darkMode, setDarkMode] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [darkMode]);

  return (
    <WatchPageData
      client={videoApiClient}
      videoId={videoId}
      theme={darkMode ? 'dark' : 'light'}
      shell={{
        header: (
          <Header
            brand={
              <a
                href="/"
                className="rounded font-sans text-lg font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                W3DS Video
              </a>
            }
            onMenuClick={() => setMobileNavigationOpen(true)}
            actions={
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={darkMode}
                aria-label={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
                onClick={() => setDarkMode((current) => !current)}
              >
                {darkMode ? 'Light mode' : 'Dark mode'}
              </Button>
            }
          />
        ),
        sidebar: <Sidebar items={navigation} />,
        mobileNavigation: <Sidebar items={navigation} />,
        mobileNavigationOpen,
        onMobileNavigationClose: () => setMobileNavigationOpen(false),
        mobileNavigationTitle: 'Browse',
      }}
    />
  );
}
