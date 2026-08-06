'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthSession } from '@w3ds/auth';
import { type ReactNode, useState } from 'react';
import { AuthenticationProvider, authSessionQueryKey } from '../features/auth/auth-provider';
import { AppearancePreferenceProvider } from '../features/settings/appearance-preference';

export function Providers({
  children,
  initialSession = null,
}: {
  children: ReactNode;
  /** Server-verified cookie session seeded before the first client paint. */
  initialSession?: AuthSession | null;
}) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: 1, staleTime: 30_000 },
      },
    });
    if (initialSession) {
      client.setQueryData(authSessionQueryKey, initialSession);
    }
    return client;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <AuthenticationProvider>
        <AppearancePreferenceProvider>{children}</AppearancePreferenceProvider>
      </AuthenticationProvider>
    </QueryClientProvider>
  );
}
