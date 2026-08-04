'use client';

import { platformName } from '@w3ds/config';
import { AppShell, Button, Header, Sidebar } from '@w3ds/ui';
import { type ReactNode, useEffect, useState } from 'react';

const navigation = [
  { label: 'Home', href: '/', icon: '⌂' },
  { label: 'Subscriptions', href: '/subscriptions', icon: '◉' },
  { label: 'Library', href: '/library', icon: '▣' },
];

export interface ApplicationShellProps {
  children: ReactNode;
  currentHref?: string;
}

export function ApplicationShell({ children, currentHref }: ApplicationShellProps) {
  const [darkMode, setDarkMode] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const navigationItems = navigation.map((item) => ({
    ...item,
    current: item.href === currentHref,
  }));

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [darkMode]);

  return (
    <AppShell
      header={
        <Header
          brand={
            <a
              href="/"
              className="rounded font-sans text-lg font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {platformName}
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
      }
      sidebar={<Sidebar items={navigationItems} />}
      mobileNavigation={<Sidebar items={navigationItems} />}
      mobileNavigationOpen={mobileNavigationOpen}
      onMobileNavigationClose={() => setMobileNavigationOpen(false)}
      mobileNavigationTitle="Browse"
    >
      {children}
    </AppShell>
  );
}
