import { forwardRef, type HTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react';
import { Button, Heading, IconButton, Spinner, Text } from './primitives';

const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ');
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export interface NavItem {
  label: ReactNode;
  href: string;
  icon?: ReactNode;
  current?: boolean;
}

export interface HeaderProps extends HTMLAttributes<HTMLElement> {
  brand?: ReactNode;
  navigation?: ReactNode;
  actions?: ReactNode;
  onMenuClick?: () => void;
  menuLabel?: string;
}

export const Header = forwardRef<HTMLElement, HeaderProps>(
  (
    {
      brand,
      navigation,
      actions,
      onMenuClick,
      menuLabel = 'Open navigation menu',
      className,
      ...props
    },
    ref,
  ) => (
    <header
      ref={ref}
      className={cx(
        'flex min-h-16 items-center gap-3 border-b border-border bg-surface px-4 text-foreground sm:px-6',
        className,
      )}
      {...props}
    >
      {onMenuClick && (
        <IconButton
          aria-label={menuLabel}
          variant="ghost"
          className="md:hidden"
          onClick={onMenuClick}
        >
          <span aria-hidden="true">☰</span>
        </IconButton>
      )}
      {brand && <div className="shrink-0">{brand}</div>}
      {navigation && (
        <nav aria-label="Primary navigation" className="hidden min-w-0 flex-1 md:block">
          {navigation}
        </nav>
      )}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  ),
);
Header.displayName = 'Header';

export interface SidebarProps extends HTMLAttributes<HTMLElement> {
  items?: NavItem[];
  footer?: ReactNode;
  label?: string;
}

export const Sidebar = forwardRef<HTMLElement, SidebarProps>(
  ({ items, footer, label = 'Sidebar navigation', className, children, ...props }, ref) => (
    <aside
      ref={ref}
      className={cx(
        'flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface',
        className,
      )}
      {...props}
    >
      <nav aria-label={label} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
        {items?.map((item) => (
          <a
            key={item.href}
            href={item.href}
            aria-current={item.current ? 'page' : undefined}
            className={cx(
              'flex min-h-10 items-center gap-3 rounded-md px-3 py-2 font-sans text-sm font-medium text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground',
              focusRing,
              item.current && 'bg-muted text-foreground',
            )}
          >
            {item.icon && (
              <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center">
                {item.icon}
              </span>
            )}
            {item.label}
          </a>
        ))}
        {children}
      </nav>
      {footer && <div className="border-t border-border p-3">{footer}</div>}
    </aside>
  ),
);
Sidebar.displayName = 'Sidebar';

export interface MobileNavigationDrawerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  closeLabel?: string;
}

export function MobileNavigationDrawer({
  open,
  onClose,
  title = 'Navigation',
  children,
  closeLabel = 'Close navigation menu',
  className,
  ...props
}: MobileNavigationDrawerProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const drawer = closeButtonRef.current?.closest('[role="dialog"]');
      const focusable = drawer?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable.item(0);
      const last = focusable.item(focusable.length - 1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-modal md:hidden" {...props}>
      <button
        type="button"
        aria-label="Close navigation overlay"
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          'relative flex h-full w-80 max-w-[85vw] flex-col bg-surface shadow-xl',
          className,
        )}
      >
        <div className="flex min-h-16 items-center justify-between border-b border-border px-4">
          <Heading id={titleId} size="sm">
            {title}
          </Heading>
          <IconButton
            ref={closeButtonRef}
            aria-label={closeLabel}
            variant="ghost"
            onClick={onClose}
          >
            ×
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export interface AppShellProps extends HTMLAttributes<HTMLDivElement> {
  header?: ReactNode;
  sidebar?: ReactNode;
  mobileNavigation?: ReactNode;
  mobileNavigationOpen?: boolean;
  onMobileNavigationClose?: () => void;
  mobileNavigationTitle?: ReactNode;
}

export function AppShell({
  header,
  sidebar,
  mobileNavigation,
  mobileNavigationOpen = false,
  onMobileNavigationClose = () => undefined,
  mobileNavigationTitle,
  className,
  children,
  ...props
}: AppShellProps) {
  return (
    <div
      className={cx('flex min-h-screen flex-col bg-background text-foreground', className)}
      {...props}
    >
      {header}
      <div className="flex min-h-0 flex-1">
        {sidebar && <div className="hidden min-h-0 md:block">{sidebar}</div>}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      {mobileNavigation && (
        <MobileNavigationDrawer
          open={mobileNavigationOpen}
          onClose={onMobileNavigationClose}
          title={mobileNavigationTitle}
        >
          {mobileNavigation}
        </MobileNavigationDrawer>
      )}
    </div>
  );
}

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
}

export interface BreadcrumbsProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  items: BreadcrumbItem[];
  label?: string;
}

export const Breadcrumbs = forwardRef<HTMLElement, BreadcrumbsProps>(
  ({ items, label = 'Breadcrumb', className, ...props }, ref) => (
    <nav ref={ref} aria-label={label} className={className} {...props}>
      <ol className="flex flex-wrap items-center gap-1 font-sans text-sm text-muted-foreground">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li
              key={item.href ?? (typeof item.label === 'string' ? item.label : 'current')}
              className="flex items-center gap-1"
            >
              {index > 0 && (
                <span aria-hidden="true" className="select-none">
                  /
                </span>
              )}
              {item.href && !current ? (
                <a href={item.href} className={cx('rounded hover:text-foreground', focusRing)}>
                  {item.label}
                </a>
              ) : (
                <span
                  aria-current={current ? 'page' : undefined}
                  className={current ? 'text-foreground' : undefined}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  ),
);
Breadcrumbs.displayName = 'Breadcrumbs';

export interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
}

export const Container = forwardRef<HTMLDivElement, ContainerProps>(
  ({ size = 'xl', className, ...props }, ref) => (
    <div
      ref={ref}
      className={cx(
        'mx-auto w-full px-4 sm:px-6 lg:px-8',
        { sm: 'max-w-2xl', md: 'max-w-3xl', lg: 'max-w-5xl', xl: 'max-w-7xl', full: 'max-w-none' }[
          size
        ],
        className,
      )}
      {...props}
    />
  ),
);
Container.displayName = 'Container';

export interface PageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  containerSize?: ContainerProps['size'];
}

export function Page({
  title,
  description,
  actions,
  breadcrumbs,
  containerSize,
  className,
  children,
  ...props
}: PageProps) {
  return (
    <div className={cx('py-6 sm:py-8', className)} {...props}>
      <Container {...(containerSize ? { size: containerSize } : {})}>
        {(breadcrumbs || title || description || actions) && (
          <header className="mb-8">
            {breadcrumbs && <div className="mb-4">{breadcrumbs}</div>}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                {title && (
                  <Heading as="h1" size="xl">
                    {title}
                  </Heading>
                )}
                {description && (
                  <Text tone="muted" className="mt-2 max-w-3xl">
                    {description}
                  </Text>
                )}
              </div>
              {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
            </div>
          </header>
        )}
        {children}
      </Container>
    </div>
  );
}

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export const Section = forwardRef<HTMLElement, SectionProps>(
  ({ title, description, action, className, children, ...props }, ref) => (
    <section ref={ref} className={cx('space-y-4', className)} {...props}>
      {(title || description || action) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {title && (
              <Heading as="h2" size="lg">
                {title}
              </Heading>
            )}
            {description && (
              <Text size="sm" tone="muted" className="mt-1">
                {description}
              </Text>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  ),
);
Section.displayName = 'Section';

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  gap?: 0 | 1 | 2 | 3 | 4 | 6 | 8;
  direction?: 'vertical' | 'horizontal';
  align?: 'start' | 'center' | 'end' | 'stretch';
}

export const Stack = forwardRef<HTMLDivElement, StackProps>(
  ({ gap = 4, direction = 'vertical', align = 'stretch', className, ...props }, ref) => (
    <div
      ref={ref}
      className={cx(
        'flex',
        direction === 'vertical' ? 'flex-col' : 'flex-row',
        { 0: 'gap-0', 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4', 6: 'gap-6', 8: 'gap-8' }[gap],
        {
          start: 'items-start',
          center: 'items-center',
          end: 'items-end',
          stretch: 'items-stretch',
        }[align],
        className,
      )}
      {...props}
    />
  ),
);
Stack.displayName = 'Stack';

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  columns?: 1 | 2 | 3 | 4 | 5;
  gap?: StackProps['gap'];
}

export const Grid = forwardRef<HTMLDivElement, GridProps>(
  ({ columns = 1, gap = 4, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cx(
        'grid',
        {
          1: 'grid-cols-1',
          2: 'grid-cols-1 sm:grid-cols-2',
          3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
          4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
          5: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
        }[columns],
        { 0: 'gap-0', 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4', 6: 'gap-6', 8: 'gap-8' }[gap],
        className,
      )}
      {...props}
    />
  ),
);
Grid.displayName = 'Grid';

export interface SplitPaneProps extends HTMLAttributes<HTMLDivElement> {
  aside: ReactNode;
  asidePosition?: 'start' | 'end';
  asideWidth?: 'sm' | 'md' | 'lg';
  collapseBelow?: 'sm' | 'md' | 'lg' | 'never';
}

export function SplitPane({
  aside,
  asidePosition = 'start',
  asideWidth = 'md',
  collapseBelow = 'md',
  className,
  children,
  ...props
}: SplitPaneProps) {
  const widths = { sm: 'w-48', md: 'w-64', lg: 'w-80' };
  const responsive = { sm: 'sm:flex-row', md: 'md:flex-row', lg: 'lg:flex-row', never: 'flex-row' };
  return (
    <div className={cx('flex flex-col gap-6', responsive[collapseBelow], className)} {...props}>
      <aside
        className={cx('shrink-0', widths[asideWidth], asidePosition === 'end' && 'order-last')}
      >
        {aside}
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

interface StateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

function StateContainer({ title, description, action, className, children, ...props }: StateProps) {
  return (
    <div
      className={cx(
        'flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-raised px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {children}
      <Heading as="h2" size="lg" className="mt-4">
        {title}
      </Heading>
      {description && (
        <Text tone="muted" className="mt-2 max-w-md">
          {description}
        </Text>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export interface EmptyStateProps extends StateProps {
  icon?: ReactNode;
}

export function EmptyState({ icon, ...props }: EmptyStateProps) {
  return (
    <StateContainer {...props}>
      {icon && (
        <div aria-hidden="true" className="text-3xl text-muted-foreground">
          {icon}
        </div>
      )}
    </StateContainer>
  );
}

export interface ErrorStateProps extends StateProps {
  retry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ retry, retryLabel = 'Try again', action, ...props }: ErrorStateProps) {
  return (
    <StateContainer
      {...props}
      action={
        action ??
        (retry && (
          <Button variant="secondary" onClick={retry}>
            {retryLabel}
          </Button>
        ))
      }
    >
      <div aria-hidden="true" className="text-3xl text-danger">
        !
      </div>
    </StateContainer>
  );
}

export interface LoadingStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  label?: string;
}

export function LoadingState({
  label = 'Loading content',
  className,
  ...props
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cx(
        'flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg bg-surface-raised text-muted-foreground',
        className,
      )}
      {...props}
    >
      <Spinner aria-hidden="true" />
      <Text size="sm" tone="muted">
        {label}
      </Text>
    </div>
  );
}
