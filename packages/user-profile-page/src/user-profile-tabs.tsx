import { type KeyboardEvent, useRef } from 'react';
import { cx, focusRing } from './styles';

export const userProfileTabOrder = ['videos', 'playlists', 'about'] as const;

export type UserProfileTabId = (typeof userProfileTabOrder)[number];

export const userProfileTabLabels: Record<UserProfileTabId, string> = {
  videos: 'Videos',
  playlists: 'Playlists',
  about: 'About',
};

/** Ids are scoped to a rendered instance so several profiles can share a document. */
export const userProfileTabId = (scope: string, tab: UserProfileTabId) => `${scope}-tab-${tab}`;
export const userProfilePanelId = (scope: string, tab: UserProfileTabId) => `${scope}-panel-${tab}`;

function tabIndexForKey(key: string, current: number, total: number): number | undefined {
  if (key === 'ArrowRight') return (current + 1) % total;
  if (key === 'ArrowLeft') return (current + total - 1) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return undefined;
}

export interface UserProfileTabsProps {
  scope: string;
  activeTab: UserProfileTabId;
  onChange: (tab: UserProfileTabId) => void;
}

export function UserProfileTabs({ scope, activeTab, onChange }: UserProfileTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextIndex = tabIndexForKey(
      event.key,
      userProfileTabOrder.indexOf(activeTab),
      userProfileTabOrder.length,
    );
    const nextTab = nextIndex === undefined ? undefined : userProfileTabOrder[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    onChange(nextTab);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${nextTab}"]`)?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Profile sections"
      onKeyDown={onKeyDown}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {userProfileTabOrder.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={userProfileTabId(scope, tab)}
          data-tab={tab}
          aria-selected={activeTab === tab}
          aria-controls={userProfilePanelId(scope, tab)}
          tabIndex={activeTab === tab ? 0 : -1}
          onClick={() => onChange(tab)}
          className={cx(
            'shrink-0 border-b-2 px-4 py-3 font-sans text-sm font-semibold transition-colors duration-fast',
            focusRing,
            activeTab === tab
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {userProfileTabLabels[tab]}
        </button>
      ))}
    </div>
  );
}
