import { describe, expect, it } from 'vitest';
import { colorThemes, createCssVariables, spacing, tailwindPreset, zIndex } from './index';

describe('design tokens', () => {
  it('exports the full spacing and layering scales', () => {
    expect(spacing[4]).toBe('1rem');
    expect(zIndex.modal).toBeGreaterThan(zIndex.fixed);
  });

  it('provides distinct light and dark semantic themes', () => {
    expect(colorThemes.light.background).toBe('var(--w3ds-color-white)');
    expect(colorThemes.dark.background).toBe('var(--w3ds-color-slate-950)');
  });

  it('generates namespaced CSS custom properties for each theme', () => {
    expect(createCssVariables('light')).toContain(
      '--w3ds-color-primary: var(--w3ds-color-blue-600)',
    );
    expect(createCssVariables('dark')).toContain(
      '--w3ds-color-primary: var(--w3ds-color-blue-500)',
    );
    expect(createCssVariables()).toContain('--w3ds-spacing-4: 1rem');
  });

  it('maps semantic colours and breakpoints for Tailwind consumers', () => {
    expect(tailwindPreset.theme.extend.colors.primary).toBe('var(--w3ds-color-primary)');
    expect(tailwindPreset.theme.screens.lg).toBe('64rem');
  });
});
