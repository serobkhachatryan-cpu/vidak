export const colorPrimitives = {
  white: '#ffffff',
  black: '#0b0d12',
  slate: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
    950: '#020617',
  },
  blue: {
    50: '#eff6ff',
    100: '#dbeafe',
    200: '#bfdbfe',
    300: '#93c5fd',
    400: '#60a5fa',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    800: '#1e40af',
    900: '#1e3a8a',
  },
  emerald: { 50: '#ecfdf5', 100: '#d1fae5', 500: '#10b981', 600: '#059669', 700: '#047857' },
  amber: { 50: '#fffbeb', 100: '#fef3c7', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
  red: { 50: '#fef2f2', 100: '#fee2e2', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c' },
} as const;

export const colorThemes = {
  light: {
    background: 'var(--w3ds-color-white)',
    foreground: 'var(--w3ds-color-slate-900)',
    surface: 'var(--w3ds-color-white)',
    surfaceRaised: 'var(--w3ds-color-slate-50)',
    muted: 'var(--w3ds-color-slate-100)',
    mutedForeground: 'var(--w3ds-color-slate-600)',
    border: 'var(--w3ds-color-slate-200)',
    ring: 'var(--w3ds-color-blue-500)',
    primary: 'var(--w3ds-color-blue-600)',
    primaryForeground: 'var(--w3ds-color-white)',
    success: 'var(--w3ds-color-emerald-600)',
    successForeground: 'var(--w3ds-color-white)',
    warning: 'var(--w3ds-color-amber-500)',
    warningForeground: 'var(--w3ds-color-slate-900)',
    danger: 'var(--w3ds-color-red-600)',
    dangerForeground: 'var(--w3ds-color-white)',
  },
  dark: {
    background: 'var(--w3ds-color-slate-950)',
    foreground: 'var(--w3ds-color-slate-50)',
    surface: 'var(--w3ds-color-slate-900)',
    surfaceRaised: 'var(--w3ds-color-slate-800)',
    muted: 'var(--w3ds-color-slate-800)',
    mutedForeground: 'var(--w3ds-color-slate-400)',
    border: 'var(--w3ds-color-slate-700)',
    ring: 'var(--w3ds-color-blue-400)',
    primary: 'var(--w3ds-color-blue-500)',
    primaryForeground: 'var(--w3ds-color-white)',
    success: 'var(--w3ds-color-emerald-500)',
    successForeground: 'var(--w3ds-color-slate-950)',
    warning: 'var(--w3ds-color-amber-500)',
    warningForeground: 'var(--w3ds-color-slate-950)',
    danger: 'var(--w3ds-color-red-500)',
    dangerForeground: 'var(--w3ds-color-white)',
  },
} as const;

export const colors = { primitives: colorPrimitives, themes: colorThemes } as const;

export const typography = {
  fontFamily: {
    sans: 'Inter, ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
  },
  fontSize: {
    xs: ['0.75rem', { lineHeight: '1rem' }],
    sm: ['0.875rem', { lineHeight: '1.25rem' }],
    base: ['1rem', { lineHeight: '1.5rem' }],
    lg: ['1.125rem', { lineHeight: '1.75rem' }],
    xl: ['1.25rem', { lineHeight: '1.75rem' }],
    '2xl': ['1.5rem', { lineHeight: '2rem' }],
    '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
    '4xl': ['2.25rem', { lineHeight: '2.5rem' }],
  },
  fontWeight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  letterSpacing: { tight: '-0.025em', normal: '0', wide: '0.025em' },
} as const;

export const spacing = {
  0: '0',
  px: '1px',
  0.5: '0.125rem',
  1: '0.25rem',
  1.5: '0.375rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
} as const;

export const radius = {
  none: '0',
  sm: '0.125rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  full: '9999px',
} as const;

export const elevation = {
  none: 'none',
  sm: '0 1px 2px rgb(15 23 42 / 0.08)',
  md: '0 4px 6px -1px rgb(15 23 42 / 0.1), 0 2px 4px -2px rgb(15 23 42 / 0.1)',
  lg: '0 10px 15px -3px rgb(15 23 42 / 0.1), 0 4px 6px -4px rgb(15 23 42 / 0.1)',
  xl: '0 20px 25px -5px rgb(15 23 42 / 0.12), 0 8px 10px -6px rgb(15 23 42 / 0.12)',
} as const;

export const motion = {
  duration: { instant: '0ms', fast: '150ms', normal: '200ms', slow: '300ms', slower: '500ms' },
  easing: {
    linear: 'linear',
    in: 'cubic-bezier(0.4, 0, 1, 1)',
    out: 'cubic-bezier(0, 0, 0.2, 1)',
    inOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
} as const;

export const breakpoints = {
  sm: '40rem',
  md: '48rem',
  lg: '64rem',
  xl: '80rem',
  '2xl': '96rem',
} as const;

export const zIndex = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  fixed: 1200,
  modalBackdrop: 1300,
  modal: 1400,
  popover: 1500,
  tooltip: 1600,
} as const;
