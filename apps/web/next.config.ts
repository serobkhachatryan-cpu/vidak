import type { NextConfig } from 'next';

const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? process.env.AUTH_PROVIDER ?? 'dev';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  env: {
    // Expose AUTH_PROVIDER to the client bundle as NEXT_PUBLIC_AUTH_PROVIDER.
    NEXT_PUBLIC_AUTH_PROVIDER: authProvider,
  },
  transpilePackages: [
    '@w3ds/api-client',
    '@w3ds/auth',
    '@w3ds/channel-page',
    '@w3ds/hooks',
    '@w3ds/ui',
    '@w3ds/upload-page',
    '@w3ds/user-profile-page',
    '@w3ds/settings-page',
    '@w3ds/watch-page',
  ],
};
export default nextConfig;
