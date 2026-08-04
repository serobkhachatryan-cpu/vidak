import type { Preview } from '@storybook/react-vite';
import { createElement } from 'react';
import '@w3ds/design-tokens/styles.css';

const preview: Preview = {
  parameters: { controls: { expanded: true } },
  decorators: [
    (Story, context) =>
      createElement(
        'div',
        {
          'data-theme': context.globals.theme,
          className: context.globals.theme === 'dark' ? 'dark' : undefined,
          style: {
            background: 'var(--w3ds-color-background)',
            color: 'var(--w3ds-color-foreground)',
            minHeight: '100vh',
            padding: '2rem',
          },
        },
        createElement(Story),
      ),
  ],
  globalTypes: {
    theme: {
      description: 'Color theme',
      defaultValue: 'light',
      toolbar: { items: ['light', 'dark'] },
    },
  },
};
export default preview;
