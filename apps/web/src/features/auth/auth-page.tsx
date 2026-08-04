'use client';

import { AuthenticationError, type LoginInput, type RegisterInput } from '@w3ds/auth';
import { Button, Card, Checkbox, Heading, Input, Label, Text } from '@w3ds/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AnonymousRoute, useAuthentication } from './auth-provider';

type Mode = 'login' | 'register';

function errorMessage(error: unknown) {
  return error instanceof AuthenticationError
    ? error.message
    : 'We could not complete that request. Please try again.';
}

export function AuthPage({ mode }: { mode: Mode }) {
  const { login, register } = useAuthentication();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isRegister = mode === 'register';
  const returnTo = searchParams.get('returnTo') || '/';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const common: LoginInput = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      remember: form.get('remember') === 'on',
    };
    setIsSubmitting(true);
    try {
      if (isRegister) {
        await register({ ...common, displayName: String(form.get('displayName') ?? '') } satisfies RegisterInput);
      } else {
        await login(common);
      }
      router.replace(returnTo);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnonymousRoute>
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
        <Card elevated className="w-full max-w-md space-y-6 p-6 sm:p-8">
          <div className="space-y-2">
            <Heading as="h1" size="xl">{isRegister ? 'Create your account' : 'Welcome back'}</Heading>
            <Text tone="muted">
              {isRegister ? 'Start sharing with the W3DS Video community.' : 'Sign in to continue to W3DS Video.'}
            </Text>
          </div>
          {error && (
            <div role="alert" className="rounded-md border border-danger bg-danger/10 px-3 py-2 font-sans text-sm text-danger">
              {error}
            </div>
          )}
          <form className="space-y-4" onSubmit={submit}>
            {isRegister && (
              <div className="space-y-1.5">
                <Label htmlFor="displayName">Display name</Label>
                <Input id="displayName" name="displayName" required autoComplete="name" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
              />
            </div>
            <Checkbox id="remember" name="remember" label="Remember me on this device" />
            <Button type="submit" className="w-full" isLoading={isSubmitting} loadingText={isRegister ? 'Creating account' : 'Signing in'}>
              {isRegister ? 'Create account' : 'Sign in'}
            </Button>
          </form>
          <Text size="sm" tone="muted">
            {isRegister ? 'Already have an account?' : 'New to W3DS Video?'}{' '}
            <Link
              href={isRegister ? `/login?returnTo=${encodeURIComponent(returnTo)}` : `/register?returnTo=${encodeURIComponent(returnTo)}`}
              className="font-semibold text-primary hover:underline"
            >
              {isRegister ? 'Sign in' : 'Create an account'}
            </Link>
          </Text>
          {!isRegister && <Text size="xs" tone="muted">Demo account: demo@w3ds.video / password123</Text>}
        </Card>
      </main>
    </AnonymousRoute>
  );
}
