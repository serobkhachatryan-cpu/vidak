import { breakpoints, elevation, radius, spacing, typography, zIndex } from './tokens';

const semanticColor = (name: string) => `var(--w3ds-color-${name})`;

/**
 * Framework-agnostic Tailwind preset shape. It intentionally avoids a
 * Tailwind runtime dependency so consumers can use it with Tailwind v3 or v4.
 */
export const tailwindPreset = {
  theme: {
    extend: {
      colors: {
        background: semanticColor('background'),
        foreground: semanticColor('foreground'),
        surface: semanticColor('surface'),
        'surface-raised': semanticColor('surface-raised'),
        muted: semanticColor('muted'),
        'muted-foreground': semanticColor('muted-foreground'),
        border: semanticColor('border'),
        primary: semanticColor('primary'),
        'primary-foreground': semanticColor('primary-foreground'),
        success: semanticColor('success'),
        'success-foreground': semanticColor('success-foreground'),
        warning: semanticColor('warning'),
        'warning-foreground': semanticColor('warning-foreground'),
        danger: semanticColor('danger'),
        'danger-foreground': semanticColor('danger-foreground'),
      },
      fontFamily: typography.fontFamily,
      fontSize: typography.fontSize,
      fontWeight: typography.fontWeight,
      letterSpacing: typography.letterSpacing,
      spacing,
      borderRadius: radius,
      boxShadow: elevation,
      transitionDuration: {
        fast: 'var(--w3ds-motion-duration-fast)',
        normal: 'var(--w3ds-motion-duration-normal)',
        slow: 'var(--w3ds-motion-duration-slow)',
      },
      transitionTimingFunction: {
        in: 'var(--w3ds-motion-easing-in)',
        out: 'var(--w3ds-motion-easing-out)',
        'in-out': 'var(--w3ds-motion-easing-in-out)',
      },
      zIndex,
    },
    screens: breakpoints,
  },
} as const;

export default tailwindPreset;
