import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AppShell,
  Breadcrumbs,
  EmptyState,
  ErrorState,
  Grid,
  Header,
  LoadingState,
  MobileNavigationDrawer,
  Sidebar,
  SplitPane,
} from './layout.js';

describe('layout components', () => {
  it('renders semantic application regions and current navigation state', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        header={<Header brand="W3DS" />}
        sidebar={<Sidebar items={[{ label: 'Library', href: '/library', current: true }]} />}
      >
        <p>Library content</p>
      </AppShell>,
    );

    expect(markup).toContain('<header');
    expect(markup).toContain('<main');
    expect(markup).toContain('<aside');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('bg-background');
  });

  it('marks the final breadcrumb as the current page', () => {
    const markup = renderToStaticMarkup(
      <Breadcrumbs items={[{ label: 'Workspace', href: '/' }, { label: 'Videos' }]} />,
    );

    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('href="/"');
    expect(markup).toContain('aria-current="page"');
  });

  it('renders an accessible modal drawer only when open', () => {
    const openMarkup = renderToStaticMarkup(
      <MobileNavigationDrawer open onClose={() => undefined}>Menu links</MobileNavigationDrawer>,
    );
    const closedMarkup = renderToStaticMarkup(
      <MobileNavigationDrawer open={false} onClose={() => undefined}>Menu links</MobileNavigationDrawer>,
    );

    expect(openMarkup).toContain('role="dialog"');
    expect(openMarkup).toContain('aria-modal="true"');
    expect(openMarkup).toContain('aria-label="Close navigation menu"');
    expect(closedMarkup).toBe('');
  });

  it('uses responsive grid and split-pane layouts', () => {
    const grid = renderToStaticMarkup(<Grid columns={3}>Items</Grid>);
    const splitPane = renderToStaticMarkup(<SplitPane aside="Filters">Content</SplitPane>);

    expect(grid).toContain('lg:grid-cols-3');
    expect(splitPane).toContain('md:flex-row');
    expect(splitPane).toContain('<aside');
  });

  it('communicates empty, error, and loading feedback states', () => {
    const empty = renderToStaticMarkup(<EmptyState title="Nothing here" />);
    const error = renderToStaticMarkup(<ErrorState title="Unable to load" retry={() => undefined} />);
    const loading = renderToStaticMarkup(<LoadingState label="Loading videos" />);

    expect(empty).toContain('Nothing here');
    expect(error).toContain('Try again');
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-label="Loading videos"');
  });
});
