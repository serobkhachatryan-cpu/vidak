import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: [
    '@w3ds/api-client',
    '@w3ds/auth',
    '@w3ds/hooks',
    '@w3ds/ui',
    '@w3ds/user-profile-page',
    '@w3ds/watch-page',
  ],
};
export default nextConfig;
