'use client';

import { platformName } from '@w3ds/config';
import { AppShell, Button, Header, SearchInput, Sidebar } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useAuthentication, useUserProfile } from '../features/auth/auth-provider';

const navigation = [
  { label: 'Home', href: '/', icon: '⌂' },
  { label: 'Subscriptions', href: '/subscriptions', icon: '◉' },
  { label: 'Library', href: '/library', icon: '▣' },
];

export interface ApplicationShellProps {
  children: ReactNode;
  currentHref?: string;
  searchValue?: string;
}

export function ApplicationShell({ children, currentHref, searchValue = '' }: ApplicationShellProps) {
  const router = useRouter();
  const { isLoading, logout } = useAuthentication();
  const user = useUserProfile();
  const [darkMode, setDarkMode] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === 'k' &&
        !event.altKey
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        target?.tagName !== 'INPUT' &&
        target?.tagName !== 'TEXTAREA' &&
        !target?.isContentEditable
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    const query = new FormData(event.currentTarget).get('q')?.toString().trim();
    if (!query) event.preventDefault();
  };

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
          navigation={
            <form action="/search" method="get" onSubmit={submitSearch} className="mx-auto max-w-xl">
              <SearchInput
                ref={searchRef}
                name="q"
                defaultValue={searchValue}
                placeholder="Search videos, channels, and playlists"
                aria-label="Search"
                shortcut="⌘K"
              />
            </form>
          }
          actions={
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={darkMode}
                aria-label={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
                onClick={() => setDarkMode((current) => !current)}
              >
                {darkMode ? 'Light mode' : 'Dark mode'}
              </Button>
              {!isLoading &&
                (user ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => router.push('/library')}>
                      {user.displayName}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void logout().then(() => router.replace('/'));
                      }}
                    >
                      Sign out
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => router.push('/login')}>
                    Sign in
                  </Button>
                ))}
            </div>
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
