import {
  type AuthClient,
  AuthenticationError,
  type AuthProviderCapabilities,
  type AuthSession,
  type AuthUser,
  type BeginLoginOptions,
  getAuthProviderCapabilities,
  type LoginChallenge,
  type LoginInput,
  type LoginOfferStatus,
  type RegisterInput,
  type UpdateAuthProfileInput,
  type W3dsAuthChallengeApi,
} from '@w3ds/auth';
import type {
  AuthDeviceSession,
  ChangeEmailInput,
  ChangePasswordInput,
  DeleteAccountInput,
} from '@w3ds/types';

export interface W3dsAuthClientOptions {
  /**
   * Platform API base URL used by later phases for offer/session HTTP calls.
   * Not contacted in Phase 1 — retained so configuration is wired through the provider.
   */
  apiBaseUrl?: string;
}

/**
 * W3DS authentication provider.
 *
 * Phase 1 ships the provider boundary and capability gates only.
 * Platform HTTP (offer / callback / session) arrives in a later milestone —
 * no Registry, eVault, wallet, or protocol traffic is performed here.
 */
export class W3dsAuthClient implements AuthClient, W3dsAuthChallengeApi {
  readonly provider = 'w3ds' as const;
  readonly capabilities: AuthProviderCapabilities = getAuthProviderCapabilities('w3ds');

  readonly apiBaseUrl: string | undefined;

  constructor(options: W3dsAuthClientOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl;
  }

  async login(_input: LoginInput): Promise<AuthSession> {
    throw unsupported('Email and password sign-in is not available with W3DS authentication.');
  }

  async register(_input: RegisterInput): Promise<AuthSession> {
    throw unsupported(
      'Account registration with a password is not available with W3DS authentication.',
    );
  }

  async refresh(_refreshToken: string): Promise<AuthSession> {
    throw unavailable('W3DS session refresh requires the platform authentication API.');
  }

  async getCurrentUser(_accessToken: string): Promise<AuthUser> {
    throw unavailable('W3DS current-user lookup requires the platform authentication API.');
  }

  async logout(_refreshToken?: string): Promise<void> {
    throw unavailable('W3DS logout requires the platform authentication API.');
  }

  async updateProfile(_accessToken: string, _input: UpdateAuthProfileInput): Promise<AuthUser> {
    throw unavailable('W3DS profile updates require the platform authentication API.');
  }

  async changeEmail(_accessToken: string, _input: ChangeEmailInput): Promise<AuthUser> {
    throw unsupported('Email changes are not available with W3DS authentication.');
  }

  async changePassword(_accessToken: string, _input: ChangePasswordInput): Promise<void> {
    throw unsupported('Password changes are not available with W3DS authentication.');
  }

  async listSessions(_accessToken: string): Promise<readonly AuthDeviceSession[]> {
    throw unavailable('W3DS session listing requires the platform authentication API.');
  }

  async revokeSession(
    _accessToken: string,
    _sessionId: string,
  ): Promise<readonly AuthDeviceSession[]> {
    throw unavailable('W3DS session revocation requires the platform authentication API.');
  }

  async deleteAccount(_accessToken: string, _input: DeleteAccountInput): Promise<void> {
    throw unavailable('W3DS account deletion requires the platform authentication API.');
  }

  async beginLogin(_options: BeginLoginOptions): Promise<LoginChallenge> {
    throw unavailable('W3DS login challenges require the platform authentication API.');
  }

  async getOfferStatus(_offerId: string): Promise<LoginOfferStatus> {
    throw unavailable('W3DS offer status requires the platform authentication API.');
  }
}

function unsupported(message: string): AuthenticationError {
  return new AuthenticationError(message, 'unsupported_capability');
}

function unavailable(message: string): AuthenticationError {
  return new AuthenticationError(message, 'provider_unavailable');
}
