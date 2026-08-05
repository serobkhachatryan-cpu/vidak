import { authProviderEnvVars, defaultAuthProvider } from '@w3ds/config';
import type { NextConfig } from 'next';

const authProvider =
  process.env[authProviderEnvVars.public]?.trim() ||
  process.env[authProviderEnvVars.shared]?.trim() ||
  defaultAuthProvider;

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
  serverExternalPackages: ['pg', 'drizzle-orm'],
  env: {
    // Expose only the provider id to the client bundle — never secrets or origins.
    [authProviderEnvVars.public]: authProvider,
  },
  // Cookie-authenticated APIs remain same-origin only. The W3DS eID gateway
  // at /api/auth handles its own narrow, credential-free CORS response.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
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
