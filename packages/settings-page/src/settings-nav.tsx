import { type KeyboardEvent, useRef } from 'react';
import {
  type SettingsSectionId,
  settingsNavId,
  settingsPanelId,
  settingsSectionLabels,
  settingsSectionOrder,
} from './settings-constants';
import { nextSettingsSection } from './settings-page-helpers';
import { cx, focusRing } from './styles';

export interface SettingsNavProps {
  scope: string;
  activeSection: SettingsSectionId;
  sections?: readonly SettingsSectionId[];
  onChange: (section: SettingsSectionId) => void;
}

export function SettingsNav({
  scope,
  activeSection,
  sections = settingsSectionOrder,
  onChange,
}: SettingsNavProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextSettingsSection(activeSection, event.key, sections);
    if (!next) return;
    event.preventDefault();
    onChange(next);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)?.focus();
  };

  return (
    <nav aria-label="Settings sections">
      <div
        ref={listRef}
        role="tablist"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-border pb-2 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:pb-0 md:pr-4"
      >
        {sections.map((section) => {
          const selected = activeSection === section;
          return (
            <button
              key={section}
              type="button"
              role="tab"
              id={settingsNavId(scope, section)}
              data-section={section}
              aria-selected={selected}
              aria-controls={settingsPanelId(scope, section)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(section)}
              className={cx(
                'shrink-0 rounded-md px-3 py-2 text-left font-sans text-sm font-semibold transition-colors duration-fast',
                focusRing,
                selected
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
              )}
            >
              {settingsSectionLabels[section]}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
