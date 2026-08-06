'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AuthProviderCapabilities,
  type AuthProviderId,
  type AuthSession,
  type AuthUser,
  createBrowserTokenStorage,
  type LoginChallenge,
  type LoginChallengeStatus,
  type LoginInput,
  persistAuthSession,
  type RegisterInput,
  restoreStoredSession,
  storeSession,
  toBrowserAuthSession,
} from '@w3ds/auth';
import { Skeleton } from '@w3ds/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { authApiClient } from '../../lib/auth-api-client';
import { getSafeReturnTo } from './auth-session-handoff';

export const authSessionQueryKey = ['auth', 'session'] as const;
const tokenStorage = createBrowserTokenStorage();

export { getSafeReturnTo };

interface AuthenticationContextValue {
  user: AuthUser | undefined;
  session: AuthSession | undefined;
  isLoading: boolean;
  error: Error | null;
  provider: AuthProviderId;
  capabilities: AuthProviderCapabilities;
  login(input: LoginInput): Promise<AuthSession>;
  register(input: RegisterInput): Promise<AuthSession>;
  logout(): Promise<void>;
  updateSessionUser(user: AuthUser): void;
  createLoginChallenge(): Promise<LoginChallenge>;
  getLoginChallengeStatus(offerId: string): Promise<LoginChallengeStatus>;
}

const AuthenticationContext = createContext<AuthenticationContextValue | undefined>(undefined);

async function restoreAuthSession(): Promise<AuthSession | null> {
  if (authApiClient.provider === 'w3ds') {
    return authApiClient.restoreSession();
  }
  return restoreStoredSession(authApiClient, tokenStorage);
}

export function AuthenticationProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: authSessionQueryKey,
    queryFn: restoreAuthSession,
    // Server layout seeds a verified cookie session into the query cache before
    // paint. Keep that result until logout / explicit restore.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const persist = (session: AuthSession, remember: boolean) => {
    // W3DS credentials live in HttpOnly cookies only — never browser storage.
    const next = persistAuthSession(tokenStorage, session, remember);
    queryClient.setQueryData(authSessionQueryKey, next);
    return next;
  };

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => authApiClient.login(input),
  });
  const registerMutation = useMutation({
    mutationFn: (input: RegisterInput) => authApiClient.register(input),
  });

  const value = useMemo<AuthenticationContextValue>(
    () => ({
      user: sessionQuery.data?.user,
      session: sessionQuery.data ?? undefined,
      isLoading: sessionQuery.isPending,
      error: sessionQuery.error,
      provider: authApiClient.provider,
      capabilities: authApiClient.capabilities,
      login: async (input) => persist(await loginMutation.mutateAsync(input), input.remember),
      register: async (input) => persist(await registerMutation.mutateAsync(input), input.remember),
      logout: async () => {
        const stored = tokenStorage.read();
        try {
          await authApiClient.logout(stored?.tokens.refreshToken);
        } finally {
          tokenStorage.clear();
          queryClient.setQueryData(authSessionQueryKey, null);
          queryClient.removeQueries({
            predicate: (query) => query.queryKey[0] !== authSessionQueryKey[0],
          });
        }
      },
      updateSessionUser: (user) => {
        const current = queryClient.getQueryData<AuthSession | null>(authSessionQueryKey);
        if (!current) return;
        const next =
          current.provider === 'w3ds'
            ? toBrowserAuthSession({ ...current, user })
            : { ...current, user };
        if (current.provider !== 'w3ds') {
          const stored = tokenStorage.read();
          storeSession(tokenStorage, next, stored?.remember ?? false);
        }
        queryClient.setQueryData(authSessionQueryKey, next);
      },
      createLoginChallenge: () => authApiClient.createLoginChallenge(),
      getLoginChallengeStatus: (offerId) => authApiClient.getLoginChallengeStatus(offerId),
    }),
    [
      loginMutation,
      queryClient,
      registerMutation,
      sessionQuery.data,
      sessionQuery.error,
      sessionQuery.isPending,
    ],
  );

  return <AuthenticationContext.Provider value={value}>{children}</AuthenticationContext.Provider>;
}

export function useAuthentication() {
  const context = useContext(AuthenticationContext);
  if (!context) throw new Error('useAuthentication must be used inside AuthenticationProvider.');
  return context;
}

export function useCurrentUser() {
  return useAuthentication().user;
}

export function SessionLoadingSkeleton() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
      <div role="status" aria-busy="true" aria-label="Loading session" className="w-full space-y-4">
        <Skeleton aria-hidden="true" className="h-8 w-40" />
        <Skeleton aria-hidden="true" className="h-10 w-full" />
        <Skeleton aria-hidden="true" className="h-10 w-full" />
        <Skeleton aria-hidden="true" className="h-10 w-28" />
      </div>
    </div>
  );
}

function RedirectingSkeleton() {
  return (
    <main
      className="flex min-h-screen items-center justify-center"
      aria-busy="true"
      aria-label="Redirecting"
    >
      <span role="status">Redirecting</span>
    </main>
  );
}

function useReturnTo() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return `${pathname}${searchParams.size ? `?${searchParams}` : ''}`;
}

export function AuthenticationGuard({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuthentication();
  const router = useRouter();
  const returnTo = useReturnTo();

  useEffect(() => {
    if (!isLoading && !user) router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [isLoading, returnTo, router, user]);

  if (isLoading) return <SessionLoadingSkeleton />;
  if (!user) return <RedirectingSkeleton />;
  return <>{children}</>;
}

export function AnonymousRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuthentication();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = getSafeReturnTo(searchParams.get('returnTo'));

  useEffect(() => {
    if (!isLoading && user) router.replace(returnTo);
  }, [isLoading, returnTo, router, user]);

  if (isLoading) return <SessionLoadingSkeleton />;
  if (user) return <RedirectingSkeleton />;
  return <>{children}</>;
}
