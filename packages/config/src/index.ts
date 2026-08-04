export const platformName = 'W3DS Video';

/**
 * Environment variable names for authentication provider selection.
 * Prefer `NEXT_PUBLIC_AUTH_PROVIDER` in the web app so the value is available
 * in the browser bundle; `AUTH_PROVIDER` is the authoritative server/build value.
 * Production Node startup requires `AUTH_PROVIDER` explicitly — do not rely on
 * the development default there. Never put secrets in `NEXT_PUBLIC_*` vars.
 */
export const authProviderEnvVars = {
  public: 'NEXT_PUBLIC_AUTH_PROVIDER',
  shared: 'AUTH_PROVIDER',
} as const;

/** Default auth provider when no environment value is set (non-production only). */
export const defaultAuthProvider = 'dev' as const;
