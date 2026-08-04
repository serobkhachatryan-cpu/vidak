'use client';

import type { AppearancePreference } from '@w3ds/types';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const storageKey = 'w3ds-appearance';

function readStoredAppearance(): AppearancePreference {
  if (typeof window === 'undefined') return 'system';
  const value = window.localStorage.getItem(storageKey);
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  return 'system';
}

function resolveTheme(appearance: AppearancePreference): 'light' | 'dark' {
  if (appearance !== 'system') return appearance;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface AppearancePreferenceContextValue {
  appearance: AppearancePreference;
  resolvedTheme: 'light' | 'dark';
  setAppearance: (appearance: AppearancePreference) => void;
}

const AppearancePreferenceContext = createContext<AppearancePreferenceContextValue | undefined>(
  undefined,
);

export function AppearancePreferenceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<AppearancePreference>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    setAppearanceState(readStoredAppearance());
  }, []);

  useEffect(() => {
    const apply = () => setResolvedTheme(resolveTheme(appearance));
    apply();
    if (appearance !== 'system' || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [appearance]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [resolvedTheme]);

  const setAppearance = useCallback((next: AppearancePreference) => {
    setAppearanceState(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(storageKey, next);
  }, []);

  const value = useMemo(
    () => ({ appearance, resolvedTheme, setAppearance }),
    [appearance, resolvedTheme, setAppearance],
  );

  return (
    <AppearancePreferenceContext.Provider value={value}>
      {children}
    </AppearancePreferenceContext.Provider>
  );
}

export function useAppearancePreference() {
  const context = useContext(AppearancePreferenceContext);
  if (!context) {
    throw new Error('useAppearancePreference must be used inside AppearancePreferenceProvider.');
  }
  return context;
}
