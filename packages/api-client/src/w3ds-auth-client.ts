import {
  type AuthClient,
  AuthenticationError,
  type AuthProviderCapabilities,
  type AuthSession,
  type AuthUser,
  getAuthProviderCapabilities,
  type LoginChallenge,
  type LoginChallengeStatus,
  type LoginInput,
  type RegisterInput,
  type UpdateAuthProfileInput,
} from '@w3ds/auth';
import type {
  AuthDeviceSession,
  ChangeEmailInput,
  ChangePasswordInput,
  DeleteAccountInput,
} from '@w3ds/types';

export interface W3dsAuthClientOptions {
  /** Origin for platform auth routes. Defaults to same-origin relative paths. */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

interface OfferResponse {
  offerId: string;
  uri: string;
  expiresAt: string;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

interface RequestOptions {
  /** When false, a 401 does not trigger cookie refresh + retry. */
  allowRefresh?: boolean;
}

/**
 * W3DS authentication provider — same-origin HTTP client for Vidak `/api/auth/*`.
 *
 * The browser never contacts Registry, eVault, or other protocol services.
 * Session credentials are carried as HttpOnly cookies set by the platform routes.
 */
export class W3dsAuthClient implements AuthClient {
  readonly provider = 'w3ds' as const;
  readonly capabilities: AuthProviderCapabilities = getAuthProviderCapabilities('w3ds');

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private refreshInFlight: Promise<AuthSession> | undefined;

  constructor(options: W3dsAuthClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createLoginChallenge(): Promise<LoginChallenge> {
    const offer = await this.requestJson<OfferResponse>('/api/auth/offer');
    return {
      offerId: offer.offerId,
      signInUri: offer.uri,
      expiresAt: offer.expiresAt,
    };
  }

  async getLoginChallengeStatus(offerId: string): Promise<LoginChallengeStatus> {
    const encoded = encodeURIComponent(offerId);
    return this.requestJson<LoginChallengeStatus>(`/api/auth/offer/${encoded}/status`);
  }

  async restoreSession(): Promise<AuthSession | null> {
    try {
      return await this.requestJson<AuthSession>('/api/auth/session');
    } catch {
      return null;
    }
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
    return this.refreshWithCookies();
  }

  async getCurrentUser(_accessToken: string): Promise<AuthUser> {
    return this.requestJson<AuthUser>('/api/auth/me');
  }

  async logout(_refreshToken?: string): Promise<void> {
    try {
      await this.request('/api/auth/logout', { method: 'POST' }, { allowRefresh: false });
    } catch {
      // Local logout still clears client state even if the network call fails.
    }
  }

  async updateProfile(_accessToken: string, input: UpdateAuthProfileInput): Promise<AuthUser> {
    return this.requestJson<AuthUser>('/api/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async changeEmail(_accessToken: string, _input: ChangeEmailInput): Promise<AuthUser> {
    throw unsupported('Email changes are not available with W3DS authentication.');
  }

  async changePassword(_accessToken: string, _input: ChangePasswordInput): Promise<void> {
    throw unsupported('Password changes are not available with W3DS authentication.');
  }

  async listSessions(_accessToken: string): Promise<readonly AuthDeviceSession[]> {
    return this.requestJson<readonly AuthDeviceSession[]>('/api/auth/sessions');
  }

  async revokeSession(
    _accessToken: string,
    sessionId: string,
  ): Promise<readonly AuthDeviceSession[]> {
    const encoded = encodeURIComponent(sessionId);
    return this.requestJson<readonly AuthDeviceSession[]>(`/api/auth/sessions/${encoded}`, {
      method: 'DELETE',
    });
  }

  async deleteAccount(_accessToken: string, _input: DeleteAccountInput): Promise<void> {
    throw unsupported('Account deletion is not available with W3DS authentication.');
  }

  private refreshWithCookies(): Promise<AuthSession> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.requestJson<AuthSession>(
        '/api/auth/refresh',
        { method: 'POST' },
        { allowRefresh: false },
      ).finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async requestJson<T>(
    path: string,
    init?: RequestInit,
    options?: RequestOptions,
  ): Promise<T> {
    const response = await this.request(path, init, options);
    return (await response.json()) as T;
  }

  private async request(
    path: string,
    init?: RequestInit,
    options: RequestOptions = {},
  ): Promise<Response> {
    const allowRefresh = options.allowRefresh ?? true;
    const response = await this.fetchImpl(this.url(path), {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (response.ok || response.status === 204) return response;

    if (response.status === 401 && allowRefresh && canAttemptRefresh(path)) {
      try {
        await this.refreshWithCookies();
      } catch {
        throw new AuthenticationError('Authentication session is invalid.', 'invalid_session');
      }
      return this.request(path, init, { allowRefresh: false });
    }

    const body = await readErrorBody(response);
    const code = mapAuthErrorCode(body.error?.code, response.status);
    throw new AuthenticationError(body.error?.message ?? 'Authentication request failed.', code);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

function canAttemptRefresh(path: string): boolean {
  return !path.endsWith('/api/auth/refresh') && !path.endsWith('/api/auth/logout');
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function unsupported(message: string): AuthenticationError {
  return new AuthenticationError(message, 'unsupported_capability');
}

async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}

function mapAuthErrorCode(code: string | undefined, status: number): AuthenticationError['code'] {
  switch (code) {
    case 'invalid_credentials':
    case 'email_in_use':
    case 'invalid_session':
    case 'invalid_password':
    case 'weak_password':
    case 'confirmation_mismatch':
    case 'validation_failed':
    case 'unsupported_capability':
    case 'provider_unavailable':
      return code;
    default:
      return status === 401 || status === 403 ? 'invalid_session' : 'provider_unavailable';
  }
}
