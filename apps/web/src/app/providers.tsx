'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { AuthenticationProvider } from '../features/auth/auth-provider';
import { AppearancePreferenceProvider } from '../features/settings/appearance-preference';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 30_000 },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthenticationProvider>
        <AppearancePreferenceProvider>{children}</AppearancePreferenceProvider>
      </AuthenticationProvider>
    </QueryClientProvider>
  );
}
