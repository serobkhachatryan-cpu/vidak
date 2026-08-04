import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'W3DS Admin',
  description: 'W3DS platform administration',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
