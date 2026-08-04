import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Card, Checkbox, Heading, Input, Label, Skeleton, Text } from './index';

const meta = {
  title: 'Patterns/Authentication',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function AuthenticationCard({
  register = false,
  error,
  isSubmitting = false,
}: {
  register?: boolean;
  error?: string;
  isSubmitting?: boolean;
}) {
  return (
    <Card elevated className="w-96 space-y-6">
      <div className="space-y-2">
        <Heading as="h1" size="xl">
          {register ? 'Create your account' : 'Welcome back'}
        </Heading>
        <Text tone="muted">
          {register ? 'Start sharing with the community.' : 'Sign in to continue.'}
        </Text>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-danger bg-danger/10 px-3 py-2 font-sans text-sm text-danger"
        >
          {error}
        </div>
      )}
      <form className="space-y-4" onSubmit={(event) => event.preventDefault()}>
        {register && (
          <div className="space-y-1.5">
            <Label htmlFor="story-display-name">Display name</Label>
            <Input
              id="story-display-name"
              name="displayName"
              placeholder="Ada Lovelace"
              required
              autoComplete="name"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="story-email">Email</Label>
          <Input
            id="story-email"
            name="email"
            type="email"
            placeholder="you@example.com"
            required
            autoComplete="email"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="story-password">Password</Label>
          <Input
            id="story-password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={register ? 'new-password' : 'current-password'}
          />
        </div>
        <Checkbox id="story-remember" name="remember" label="Remember me on this device" />
        <Button
          type="submit"
          className="w-full"
          isLoading={isSubmitting}
          loadingText={register ? 'Creating account' : 'Signing in'}
        >
          {register ? 'Create account' : 'Sign in'}
        </Button>
      </form>
    </Card>
  );
}

export const Login: Story = { render: () => <AuthenticationCard /> };
export const Register: Story = { render: () => <AuthenticationCard register /> };
export const SubmitError: Story = {
  render: () => <AuthenticationCard error="Email or password is incorrect." />,
};
export const Submitting: Story = {
  render: () => <AuthenticationCard isSubmitting />,
};
export const LoadingSession: Story = {
  render: () => (
    <div role="status" aria-busy="true" aria-label="Loading session" className="w-96 space-y-4">
      <Skeleton aria-hidden="true" className="h-8 w-40" />
      <Skeleton aria-hidden="true" className="h-10 w-full" />
      <Skeleton aria-hidden="true" className="h-10 w-full" />
      <Skeleton aria-hidden="true" className="h-10 w-28" />
    </div>
  ),
};
