import {
  breakpoints,
  colorPrimitives,
  colorThemes,
  elevation,
  motion,
  radius,
  spacing,
  typography,
  zIndex,
} from './tokens';

type TokenValue = string | number;
type TokenTree = { readonly [key: string]: TokenValue | TokenTree };

const kebabCase = (value: string) =>
  value
    .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
    .replaceAll('.', '-')
    .toLowerCase();

function flattenTokens(
  tokens: TokenTree,
  prefix: string[] = [],
): Array<readonly [string, TokenValue]> {
  return Object.entries(tokens).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flattenTokens(value as TokenTree, [...prefix, kebabCase(key)])
      : [[`--w3ds-${[...prefix, kebabCase(key)].filter(Boolean).join('-')}`, value] as const],
  );
}

function declarationBlock(tokens: TokenTree, prefix: string): string {
  return flattenTokens(tokens, [prefix])
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

const baseTokens = {
  color: colorPrimitives,
  spacing,
  radius,
  elevation,
  motion,
  fontFamily: typography.fontFamily,
  fontWeight: typography.fontWeight,
  letterSpacing: typography.letterSpacing,
  fontSize: Object.fromEntries(
    Object.entries(typography.fontSize).map(([name, [size]]) => [name, size]),
  ),
  breakpoints,
  zIndex,
} satisfies TokenTree;

/**
 * Creates a stylesheet that exposes all non-responsive tokens plus the selected
 * semantic colour theme. The package's `styles.css` is the ready-to-import
 * version generated from this same token model.
 */
export function createCssVariables(theme: keyof typeof colorThemes = 'light'): string {
  return `:root {\n${declarationBlock(baseTokens, '')}\n${declarationBlock(colorThemes[theme], 'color')}\n}`;
}

export const cssVariables = {
  light: createCssVariables('light'),
  dark: createCssVariables('dark'),
} as const;
