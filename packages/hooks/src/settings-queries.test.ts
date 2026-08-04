import { defaultUserPreferences } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import { mergeUserPreferences } from './settings-queries';

describe('mergeUserPreferences', () => {
  it('merges nested notification and privacy patches', () => {
    const merged = mergeUserPreferences(defaultUserPreferences, {
      appearance: 'dark',
      notifications: { emailMarketing: true },
      privacy: { searchableByEmail: true },
    });

    expect(merged.appearance).toBe('dark');
    expect(merged.language).toBe(defaultUserPreferences.language);
    expect(merged.notifications.emailMarketing).toBe(true);
    expect(merged.notifications.emailComments).toBe(
      defaultUserPreferences.notifications.emailComments,
    );
    expect(merged.privacy.searchableByEmail).toBe(true);
    expect(merged.privacy.allowMentions).toBe(defaultUserPreferences.privacy.allowMentions);
  });
});
