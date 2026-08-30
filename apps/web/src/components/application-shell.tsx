'use client';

import { AppShell, Button, Header, SearchInput, Sidebar, VidakLogo } from '@w3ds/ui';
import { usePathname, useRouter } from 'next/navigation';
import {
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAuthentication, useCurrentUser } from '../features/auth/auth-provider';
import { useAppearancePreference } from '../features/settings/appearance-preference';
import { headerAccountCta, headerVerifiedNameCta } from '../lib/public-display-name';

const navigation = [
  { label: 'Home', href: '/', icon: '⌂' },
  { label: 'Subscriptions', href: '/subscriptions', icon: '◉' },
  { label: 'Support', href: '/support', icon: '⚑' },
  { label: 'Linked channels', href: '/library', icon: '▣' },
  { label: 'Your videos', href: '/your-videos', icon: '◌' },
  { label: 'Upload', href: '/upload', icon: '⇪' },
  { label: 'Settings', href: '/settings', icon: '⚙' },
];

export interface ApplicationShellProps {
  children: ReactNode;
  currentHref?: string;
  searchValue?: string;
}

export function ApplicationShell({
  children,
  currentHref,
  searchValue = '',
}: ApplicationShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { isLoading, logout, session } = useAuthentication();
  const user = useCurrentUser();
  const { appearance, resolvedTheme, setAppearance } = useAppearancePreference();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationItems = navigation.map((item) => ({
    ...item,
    current: item.href === currentHref,
  }));
  const identity = user ? { id: user.id, eName: user.eName, eVaultId: user.eVaultId } : undefined;
  const accountCta = user ? headerAccountCta(user.displayName, identity) : undefined;
  const verifiedNameCta =
    user && session?.provider === 'w3ds'
      ? headerVerifiedNameCta(user.displayName, identity)
      : undefined;

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

  /**
   * `Sidebar` is shared UI and deliberately renders ordinary anchors. In the
   * app shell, preserve the mounted authentication provider for same-origin
   * navigation instead of reloading the document (and re-checking a session)
   * for every sidebar click.
   */
  const navigateInternally = (event: MouseEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return false;
    }

    const target = event.target;
    if (!(target instanceof Element)) return false;
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (
      !link ||
      !event.currentTarget.contains(link) ||
      link.target ||
      link.hasAttribute('download')
    ) {
      return false;
    }

    const href = link.getAttribute('href');
    if (!href?.startsWith('/') || href.startsWith('//')) return false;

    event.preventDefault();
    router.push(href);
    return true;
  };

  const cycleAppearance = () => {
    const order = ['light', 'dark', 'system'] as const;
    const index = order.indexOf(appearance);
    setAppearance(order[(index + 1) % order.length] ?? 'system');
  };

  return (
    <AppShell
      header={
        <Header
          brand={
            <a
              href="/"
              onClick={navigateInternally}
              className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <VidakLogo className="h-9 w-auto text-foreground sm:h-10" />
            </a>
          }
          onMenuClick={() => setMobileNavigationOpen(true)}
          navigation={
            <form
              action="/search"
              method="get"
              onSubmit={submitSearch}
              className="mx-auto max-w-xl"
            >
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
                aria-label={`Appearance: ${appearance}. Switch theme`}
                onClick={cycleAppearance}
              >
                {appearance === 'system'
                  ? `System (${resolvedTheme})`
                  : appearance === 'dark'
                    ? 'Dark mode'
                    : 'Light mode'}
              </Button>
              {!isLoading &&
                (user && accountCta ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => router.push('/support')}>
                      Report a problem
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => router.push('/upload')}>
                      Upload
                    </Button>
                    {verifiedNameCta ? (
                      <a
                        href={verifiedNameCta.href}
                        onClick={navigateInternally}
                        className="rounded-md px-3 py-1.5 font-sans text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        {verifiedNameCta.label}
                      </a>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => router.push(accountCta.href)}>
                      {accountCta.label}
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
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => router.push(`/login?returnTo=${encodeURIComponent(pathname)}`)}
                  >
                    Sign in
                  </Button>
                ))}
            </div>
          }
        />
      }
      sidebar={<Sidebar items={navigationItems} onClick={navigateInternally} />}
      mobileNavigation={
        <Sidebar
          items={navigationItems}
          onClick={(event) => {
            if (navigateInternally(event)) setMobileNavigationOpen(false);
          }}
        />
      }
      mobileNavigationOpen={mobileNavigationOpen}
      onMobileNavigationClose={() => setMobileNavigationOpen(false)}
      mobileNavigationTitle="Browse"
    >
      {children}
    </AppShell>
  );
}
