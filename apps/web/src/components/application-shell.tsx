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

const signedInNavigation = [
  // The landing page is the signed-in library, so call it what it is instead
  // of duplicating it with a separate "Your videos" destination.
  { label: 'Your video space', href: '/', icon: '⌂' },
  { label: 'Upload a video', href: '/upload', icon: '⇪' },
  { label: 'Linked channels', href: '/library', icon: '▣' },
  { label: 'Subscriptions', href: '/subscriptions', icon: '◉' },
  { label: 'Settings', href: '/settings', icon: '⚙' },
  { label: 'Support', href: '/support', icon: '⚑' },
];

// Public browsing should never look like a broken signed-in product. Keep
// private destinations out of the anonymous shell instead of sending every
// sidebar click into eID sign-in.
const publicNavigation = [
  { label: 'Home', href: '/', icon: '⌂' },
  { label: 'Search public videos', href: '/search', icon: '⌕' },
  { label: 'Support', href: '/support', icon: '⚑' },
];

export interface ApplicationShellProps {
  children: ReactNode;
  currentHref?: string;
  searchValue?: string;
  /** The dedicated search page owns its focused search control. */
  showHeaderSearch?: boolean;
}

export function ApplicationShell({
  children,
  currentHref,
  searchValue = '',
  showHeaderSearch = true,
}: ApplicationShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { isLoading, logout, session } = useAuthentication();
  const user = useCurrentUser();
  const { appearance, resolvedTheme, setAppearance } = useAppearancePreference();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationItems = (user ? signedInNavigation : publicNavigation).map((item) => ({
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
    if (!showHeaderSearch) return;
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
  }, [showHeaderSearch]);

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
            showHeaderSearch ? (
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
                  placeholder="Search videos and channels"
                  aria-label="Search"
                  shortcut="⌘K"
                />
              </form>
            ) : undefined
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
