import { authProviderEnvVars, defaultAuthProvider } from '@w3ds/config';
import type { NextConfig } from 'next';

const authProvider =
  process.env[authProviderEnvVars.public]?.trim() ||
  process.env[authProviderEnvVars.shared]?.trim() ||
  defaultAuthProvider;

const browserSecurityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  },
  {
    key: 'Content-Security-Policy',
    value:
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; upgrade-insecure-requests",
  },
];

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
        // Protect all documents and same-origin API/media responses. The CSP
        // keeps Next's required inline runtime/style bootstrap while denying
        // frames, plugins, and ambient browser permissions.
        source: '/:path*',
        headers: browserSecurityHeaders,
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
