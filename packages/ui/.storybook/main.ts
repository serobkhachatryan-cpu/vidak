import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: [
    '../src/**/*.stories.@(ts|tsx)',
    '../../channel-page/src/**/*.stories.@(ts|tsx)',
    '../../upload-page/src/**/*.stories.@(ts|tsx)',
    '../../user-profile-page/src/**/*.stories.@(ts|tsx)',
    '../../watch-page/src/**/*.stories.@(ts|tsx)',
  ],
  addons: [],
  framework: '@storybook/react-vite',
};
export default config;
