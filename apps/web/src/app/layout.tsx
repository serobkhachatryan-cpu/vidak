import { platformName } from '@w3ds/config';
import type { Metadata } from 'next';
import { readServerAuthSession } from '../features/auth/read-server-auth-session';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: platformName,
  description: 'Decentralized video hosting',
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
