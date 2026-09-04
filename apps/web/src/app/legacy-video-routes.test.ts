import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect }));

import LegacyMeshengerPage from './meshenger/page';
import SubscriptionsPage from './subscriptions/page';
import YourVideosPage from './your-videos/page';

describe('legacy video routes', () => {
  beforeEach(() => {
    redirect.mockReset();
  });

  it('sends old Your videos bookmarks to the canonical My videos filter', () => {
    YourVideosPage();
    expect(redirect).toHaveBeenCalledWith('/?tab=yours');
  });

  it('does not retain Meshenger as a separate product destination', () => {
    LegacyMeshengerPage();
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('sends old subscriptions links to usable public-video browsing', () => {
    SubscriptionsPage();
    expect(redirect).toHaveBeenCalledWith('/?tab=explore');
  });
});
