import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: ['@w3ds/api-client', '@w3ds/hooks', '@w3ds/ui'],
};
export default nextConfig;
