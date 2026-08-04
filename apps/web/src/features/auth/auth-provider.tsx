'use client';

import {
  type AuthSession,
  type AuthUser,
  createBrowserTokenStorage,
  hasAnyRole,
  hasRole,
  type LoginInput,
  type RegisterInput,
  type Role,
} from '@w3ds/auth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect } from 'react';
import { Skeleton } from '@w3ds/ui';
import { authApiClient } from '../../lib/auth-api-client';

const authQueryKey = ['auth', 'session'] as const;
const tokenStorage = createBrowserTokenStorage();

interface AuthenticationContextValue {
  user: AuthUser | undefined;
  session: AuthSession | undefined;
  isLoading: boolean;
  error: Error | null;
  login(input: LoginInput): Promise<AuthSession>;
  register(input: RegisterInput): Promise<AuthSession>;
  logout(): Promise<void>;
}

const AuthenticationContext = createContext<AuthenticationContextValue | undefined>(undefined);

async function restoreSession(): Promise<AuthSession | null> {
  const stored = tokenStorage.read();
  if (!stored) return null;
  try {
    const session = await authApiClient.refresh(stored.tokens.refreshToken);
    tokenStorage.write({ ...session, remember: stored.remember });
    return session;
  } catch {
    tokenStorage.clear();
    return null;
  }
}

export function AuthenticationProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: authQueryKey,
    queryFn: restoreSession,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const persist = (session: AuthSession, remember: boolean) => {
    tokenStorage.write({ ...session, remember });
    queryClient.setQueryData(authQueryKey, session);
    queryClient.setQueryData(['auth', 'current-user'], session.user);
    return session;
  };

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => authApiClient.login(input),
  });
  const registerMutation = useMutation({
    mutationFn: (input: RegisterInput) => authApiClient.register(input),
  });

  const value: AuthenticationContextValue = {
    user: sessionQuery.data?.user,
    session: sessionQuery.data ?? undefined,
    isLoading: sessionQuery.isPending,
    error: sessionQuery.error,
    login: async (input) => persist(await loginMutation.mutateAsync(input), input.remember),
    register: async (input) => persist(await registerMutation.mutateAsync(input), input.remember),
    logout: async () => {
      const stored = tokenStorage.read();
      try {
        await authApiClient.logout(stored?.tokens.refreshToken);
      } finally {
        tokenStorage.clear();
        queryClient.setQueryData(authQueryKey, null);
        queryClient.removeQueries({ queryKey: ['auth', 'current-user'] });
      }
    },
  };

  return <AuthenticationContext.Provider value={value}>{children}</AuthenticationContext.Provider>;
}

export function useAuthentication() {
  const context = useContext(AuthenticationContext);
  if (!context) throw new Error('useAuthentication must be used inside AuthenticationProvider.');
  return context;
}

export function useCurrentUser() {
  const { session } = useAuthentication();
  return useQuery({
    queryKey: ['auth', 'current-user'],
    queryFn: () => authApiClient.getCurrentUser(session?.tokens.accessToken ?? ''),
    enabled: Boolean(session),
    initialData: session?.user,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function usePermission(role: Role | readonly Role[]) {
  const { user } = useAuthentication();
  return typeof role === 'string' ? hasRole(user, role) : hasAnyRole(user, role);
}

export function useUserProfile() {
  return useAuthentication().user;
}

export function SessionLoadingSkeleton() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
      <div className="w-full space-y-4" aria-label="Loading session">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-28" />
      </div>
    </div>
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

  if (isLoading || !user) return <SessionLoadingSkeleton />;
  return <>{children}</>;
}

export function AnonymousRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuthentication();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/';

  useEffect(() => {
    if (!isLoading && user) router.replace(returnTo);
  }, [isLoading, returnTo, router, user]);

  if (isLoading || user) return <SessionLoadingSkeleton />;
  return <>{children}</>;
}
