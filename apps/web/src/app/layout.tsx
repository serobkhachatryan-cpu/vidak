import { platformName } from '@w3ds/config';
import type { Metadata, Viewport } from 'next';
import { readServerAuthSession } from '../features/auth/read-server-auth-session';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  metadataBase: new URL('https://vidak.postplatforms.com'),
  title: { default: platformName, template: `%s · ${platformName}` },
  description: 'A decentralized home for videos, channels, and playlists.',
  applicationName: platformName,
  openGraph: {
    type: 'website',
    siteName: platformName,
    title: platformName,
    description: 'A decentralized home for videos, channels, and playlists.',
  },
  twitter: {
    card: 'summary_large_image',
    title: platformName,
    description: 'A decentralized home for videos, channels, and playlists.',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1325' },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const initialSession = await readServerAuthSession();

  return (
    <html lang="en">
      <body>
        <Providers initialSession={initialSession}>{children}</Providers>
      </body>
    </html>
  );
}
