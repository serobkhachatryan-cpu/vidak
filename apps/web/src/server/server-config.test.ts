import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadServerSecurityConfig,
  normalizeOrigin,
  resolveCookieSecurityConfig,
  ServerConfigError,
  validateServerConfigAtStartup,
} from './server-config';

const w3dsEnv = {
  AUTH_PROVIDER: 'w3ds',
  APP_ORIGIN: 'https://vidak.example',
  W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
  W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
} as const;

describe('server security configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to explicit development auth without requiring W3DS secrets', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'development',
    });
    expect(config.authProvider).toBe('dev');
    expect(config.authProviderExplicit).toBe(false);
    expect(config.w3ds).toBeNull();
    expect(config.cookies).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
    expect(config.trustedOrigins).toEqual([]);
  });

  it('rejects missing AUTH_PROVIDER in production', () => {
    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
      }),
    ).toThrow(ServerConfigError);
    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
      }),
    ).toThrow(/AUTH_PROVIDER must be set explicitly/);
  });

  it('allows explicit AUTH_PROVIDER=dev in production without W3DS secrets', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'dev',
    });
    expect(config.authProvider).toBe('dev');
    expect(config.authProviderExplicit).toBe(true);
    expect(config.cookies.secure).toBe(true);
    expect(config.w3ds).toBeNull();
  });

  it('rejects incomplete W3DS configuration in production instead of falling back to dev', () => {
    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        AUTH_PROVIDER: 'w3ds',
        APP_ORIGIN: 'https://vidak.example',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
        W3DS_AUTH_JWT_SECRET: 'short',
        DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
      }),
    ).toThrow(/W3DS_AUTH_JWT_SECRET/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        AUTH_PROVIDER: 'w3ds',
        APP_ORIGIN: 'https://vidak.example',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
        W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
      }),
    ).toThrow(/DATABASE_URL/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        AUTH_PROVIDER: 'w3ds',
        W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
        W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
        DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
      }),
    ).toThrow(/APP_ORIGIN/);
  });

  it('loads complete production W3DS configuration with trusted origins', () => {
    const config = validateServerConfigAtStartup({
      NODE_ENV: 'production',
      ...w3dsEnv,
      TRUSTED_ORIGINS: 'https://preview.vidak.example, https://admin.vidak.example',
      W3DS_AUTH_PLATFORM_NAME: 'vidak-prod',
      MEDIA_MAX_UPLOAD_BYTES: '2048',
    });

    expect(config.authProvider).toBe('w3ds');
    expect(config.w3ds).toMatchObject({
      platformName: 'vidak-prod',
      registryBaseUrl: 'https://registry.example.com',
      databaseUrl: w3dsEnv.DATABASE_URL,
    });
    expect(config.w3ds?.jwtSecret).toHaveLength(32);
    expect(config.cookies).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
    expect(config.trustedOrigins).toEqual([
      'https://vidak.example',
      'https://preview.vidak.example',
      'https://admin.vidak.example',
    ]);
    expect(config.mediaUploadLimits.maxUploadBytes).toBe(2048);
  });

  it('keeps platform eVault provisioning disabled until explicitly enabled', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'production',
      ...w3dsEnv,
    });
    expect(config.w3ds?.platformEVault).toBeNull();
  });

  it('validates the complete server-only platform eVault profile when enabled', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'production',
      ...w3dsEnv,
      W3DS_PLATFORM_EVAULT_ENABLED: 'true',
      W3DS_PROVISIONER_BASE_URL: 'https://provisioner.example.com',
      W3DS_PLATFORM_EVAULT_VERIFICATION_ID: 'provision-only-secret',
      W3DS_PLATFORM_EVAULT_DISPLAY_NAME: 'Vidak',
      W3DS_PLATFORM_EVAULT_DESCRIPTION: 'Decentralized video publishing',
      W3DS_PLATFORM_EVAULT_LOGO_URL: 'https://vidak.example/logo.png',
      W3DS_PLATFORM_EVAULT_CATEGORY: 'Social',
    });

    expect(config.w3ds?.platformEVault).toEqual({
      provisionerBaseUrl: 'https://provisioner.example.com/',
      verificationId: 'provision-only-secret',
      profile: {
        platformName: 'vidak',
        displayName: 'Vidak',
        description: 'Decentralized video publishing',
        version: '1.0.0',
        url: 'https://vidak.example/',
        logoUrl: 'https://vidak.example/logo.png',
        category: 'Social',
      },
    });
  });

  it('rejects incomplete platform eVault provisioning configuration', () => {
    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_PLATFORM_EVAULT_ENABLED: 'true',
      }),
    ).toThrow(/W3DS_PROVISIONER_BASE_URL/);
  });

  it('keeps Ontology adapter mappings disabled until schema IDs are supplied', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'production',
      ...w3dsEnv,
    });
    expect(config.w3ds?.ontologyAdapter).toBeNull();
  });

  it('validates Ontology base URL and every entity schemaId when enabled', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'production',
      ...w3dsEnv,
      W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
      W3DS_ONTOLOGY_BASE_URL: 'https://ontology.example.com',
      W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'schema-profile',
      W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: 'schema-channel',
      W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: 'schema-video',
      W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: 'schema-playlist',
      W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: 'schema-comment',
      W3DS_ADAPTER_MAPPING_VERSION: '2',
    });

    expect(config.w3ds?.ontologyAdapter).toEqual({
      ontologyBaseUrl: 'https://ontology.example.com/',
      mappingVersion: 2,
      schemaIds: {
        profile: 'schema-profile',
        channel: 'schema-channel',
        video: 'schema-video',
        playlist: 'schema-playlist',
        comment: 'schema-comment',
      },
    });
  });

  it('rejects incomplete Ontology adapter configuration instead of guessing schema IDs', () => {
    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: 'https://ontology.example.com',
      }),
    ).toThrow(/W3DS_ONTOLOGY_SCHEMA_ID_PROFILE/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: 'https://ontology.example.com',
        W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'TODO',
        W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: 'schema-channel',
        W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: 'schema-video',
        W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: 'schema-playlist',
        W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: 'schema-comment',
      }),
    ).toThrow(/placeholder schema IDs/);
  });

  it('does not treat NEXT_PUBLIC_AUTH_PROVIDER as an explicit production provider', () => {
    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        NEXT_PUBLIC_AUTH_PROVIDER: 'w3ds',
        ...w3dsEnv,
        AUTH_PROVIDER: undefined,
      }),
    ).toThrow(/AUTH_PROVIDER must be set explicitly/);
  });

  it('normalizes origins and cookie security helpers', () => {
    expect(normalizeOrigin('https://vidak.example/app')).toBe('https://vidak.example');
    expect(normalizeOrigin('vidak.example')).toBe('https://vidak.example');
    expect(normalizeOrigin('ftp://vidak.example')).toBeUndefined();
    expect(resolveCookieSecurityConfig('development').secure).toBe(false);
    expect(resolveCookieSecurityConfig('production').secure).toBe(true);
  });
});
