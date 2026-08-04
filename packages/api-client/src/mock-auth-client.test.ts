import { AuthenticationError } from '@w3ds/auth';
import { describe, expect, it } from 'vitest';
import { createAuthClient } from './create-auth-client';
import { MockAuthApiClient } from './mock-auth-client';
import { W3dsAuthClient } from './w3ds-auth-client';

describe('MockAuthApiClient', () => {
  it('logs in, restores a user with a refreshed session, and logs out', async () => {
    const client = new MockAuthApiClient();
    expect(client.provider).toBe('dev');
    expect(client.capabilities.emailPasswordLogin).toBe(true);

    const session = await client.login({
      email: 'demo@w3ds.video',
      password: 'password123',
      remember: true,
    });

    expect(session.provider).toBe('dev');
    expect(session.user).toMatchObject({
      email: 'demo@w3ds.video',
      eName: '@demo.w3id',
      eVaultId: 'evault-demo',
      profile: { displayName: 'Demo Creator', handle: 'demo' },
      permissions: {
        canUpload: true,
        canComment: true,
        canManageOwnChannels: true,
        canModerate: false,
        canAccessAdmin: false,
      },
    });

    expect(session.tokens.refreshToken).toBeDefined();
    const refreshToken = session.tokens.refreshToken as string;
    const refreshed = await client.refresh(refreshToken);

    await expect(client.getCurrentUser(refreshed.tokens.accessToken)).resolves.toMatchObject({
      email: 'demo@w3ds.video',
      eName: '@demo.w3id',
    });
    await client.logout(refreshed.tokens.refreshToken);
    await expect(client.refresh(refreshToken)).rejects.toBeInstanceOf(AuthenticationError);
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
    expect(session.user.eName).toMatch(/^@/);
    expect(session.user.eVaultId).toMatch(/^evault-/);
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

  it('updates profile, email, password, sessions, and deletes accounts', async () => {
    const client = new MockAuthApiClient();
    const session = await client.login({
      email: 'demo@w3ds.video',
      password: 'password123',
      remember: true,
    });
    const accessToken = session.tokens.accessToken;

    const updated = await client.updateProfile(accessToken, { displayName: 'Demo Updated' });
    expect(updated.displayName).toBe('Demo Updated');
    expect(updated.profile.displayName).toBe('Demo Updated');

    const withEmail = await client.changeEmail(accessToken, {
      email: 'demo-new@w3ds.video',
      password: 'password123',
    });
    expect(withEmail.email).toBe('demo-new@w3ds.video');

    await client.changePassword(accessToken, {
      currentPassword: 'password123',
      newPassword: 'password456',
    });
    await expect(
      client.login({
        email: 'demo-new@w3ds.video',
        password: 'password456',
        remember: false,
      }),
    ).resolves.toMatchObject({ user: { email: 'demo-new@w3ds.video' } });

    const sessions = await client.listSessions(accessToken);
    expect(sessions.some((item) => item.current)).toBe(true);

    await client.deleteAccount(accessToken, {
      password: 'password456',
      confirmation: 'DELETE',
    });
    await expect(
      client.login({
        email: 'demo-new@w3ds.video',
        password: 'password456',
        remember: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });
});

describe('createAuthClient', () => {
  it('selects the development provider by default and the W3DS provider when configured', () => {
    expect(createAuthClient({ provider: 'dev' })).toBeInstanceOf(MockAuthApiClient);
    expect(createAuthClient({ provider: 'w3ds' })).toBeInstanceOf(W3dsAuthClient);
  });
});

describe('W3dsAuthClient', () => {
  it('exposes W3DS capabilities and rejects password-based operations', async () => {
    const client = new W3dsAuthClient();
    expect(client.provider).toBe('w3ds');
    expect(client.capabilities).toMatchObject({
      emailPasswordLogin: false,
      passwordRegistration: false,
      w3dsAuthChallenge: true,
    });

    await expect(
      client.login({ email: 'a@b.c', password: 'password123', remember: false }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(client.beginLogin({ remember: true })).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
  });
});
