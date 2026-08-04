import { type KeyboardEvent, useRef } from 'react';
import { cx, focusRing } from './styles';

export const channelTabOrder = ['videos', 'shorts', 'playlists', 'about'] as const;

export type ChannelTabId = (typeof channelTabOrder)[number];

export const channelTabLabels: Record<ChannelTabId, string> = {
  videos: 'Videos',
  shorts: 'Shorts',
  playlists: 'Playlists',
  about: 'About',
};

/** Ids are scoped to a rendered instance so several channel pages can share a document. */
export const channelTabId = (scope: string, tab: ChannelTabId) => `${scope}-tab-${tab}`;
export const channelPanelId = (scope: string, tab: ChannelTabId) => `${scope}-panel-${tab}`;

function tabIndexForKey(key: string, current: number, total: number): number | undefined {
  if (key === 'ArrowRight') return (current + 1) % total;
  if (key === 'ArrowLeft') return (current + total - 1) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return undefined;
}

export function ChannelTabs({
  scope,
  activeTab,
  onChange,
}: {
  scope: string;
  activeTab: ChannelTabId;
  onChange: (tab: ChannelTabId) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextIndex = tabIndexForKey(
      event.key,
      channelTabOrder.indexOf(activeTab),
      channelTabOrder.length,
    );
    const nextTab = nextIndex === undefined ? undefined : channelTabOrder[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    onChange(nextTab);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${nextTab}"]`)?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Channel sections"
      onKeyDown={onKeyDown}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {channelTabOrder.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={channelTabId(scope, tab)}
          data-tab={tab}
          aria-selected={activeTab === tab}
          aria-controls={channelPanelId(scope, tab)}
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
          {channelTabLabels[tab]}
        </button>
      ))}
    </div>
  );
}
