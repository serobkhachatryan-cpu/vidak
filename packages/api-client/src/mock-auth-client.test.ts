import { AuthenticationError } from '@w3ds/auth';
import { describe, expect, it } from 'vitest';
import { MockAuthApiClient } from './mock-auth-client';

describe('MockAuthApiClient', () => {
  it('logs in, restores a user with a refreshed session, and logs out', async () => {
    const client = new MockAuthApiClient();
    const session = await client.login({
      email: 'demo@w3ds.video',
      password: 'password123',
      remember: true,
    });
    const refreshed = await client.refresh(session.tokens.refreshToken);

    await expect(client.getCurrentUser(refreshed.tokens.accessToken)).resolves.toMatchObject({
      email: 'demo@w3ds.video',
    });
    await client.logout(refreshed.tokens.refreshToken);
    await expect(client.refresh(refreshed.tokens.refreshToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(client.getCurrentUser(refreshed.tokens.accessToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('creates accounts and reports authentication errors', async () => {
    const client = new MockAuthApiClient();
    const session = await client.register({
      displayName: 'New Creator',
      email: 'new@example.com',
      password: 'password123',
      remember: false,
    });

    expect(session.user.roles).toEqual(['creator']);
    await expect(
      client.register({
        displayName: 'Duplicate',
        email: 'new@example.com',
        password: 'password123',
        remember: false,
      }),
    ).rejects.toMatchObject({ code: 'email_in_use' });
    await expect(
      client.login({ email: 'new@example.com', password: 'wrong', remember: false }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });
});
