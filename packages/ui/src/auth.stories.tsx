import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Card, Checkbox, Heading, Input, Label, Skeleton, Text } from './index';

const meta = {
  title: 'Patterns/Authentication',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function AuthenticationCard({ register = false }: { register?: boolean }) {
  return (
    <Card elevated className="w-96 space-y-6">
      <div className="space-y-2">
        <Heading as="h1" size="xl">{register ? 'Create your account' : 'Welcome back'}</Heading>
        <Text tone="muted">{register ? 'Start sharing with the community.' : 'Sign in to continue.'}</Text>
      </div>
      <div className="space-y-4">
        {register && (
          <div className="space-y-1.5">
            <Label htmlFor="story-display-name">Display name</Label>
            <Input id="story-display-name" placeholder="Ada Lovelace" />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="story-email">Email</Label>
          <Input id="story-email" type="email" placeholder="you@example.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="story-password">Password</Label>
          <Input id="story-password" type="password" />
        </div>
        <Checkbox id="story-remember" label="Remember me on this device" />
        <Button className="w-full">{register ? 'Create account' : 'Sign in'}</Button>
      </div>
    </Card>
  );
}

export const Login: Story = { render: () => <AuthenticationCard /> };
export const Register: Story = { render: () => <AuthenticationCard register /> };
export const LoadingSession: Story = {
  render: () => (
    <div className="w-96 space-y-4" aria-label="Loading session">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-28" />
    </div>
  ),
};
