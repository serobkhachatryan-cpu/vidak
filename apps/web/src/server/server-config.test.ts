import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
  loadServerSecurityConfig,
  normalizeOrigin,
  readW3dsAaasWebhookConfig,
  readW3dsOntologyMode,
  resolveCookieSecurityConfig,
  resolveRequestCookieSecure,
  ServerConfigError,
  validateServerConfigAtStartup,
} from './server-config';
import { VIDAK_PRIVATE_SCHEMA_IDS } from './w3ds-private-ontology';

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
    expect(config.ontologyMode).toBe('vidak_private');
    expect(config.w3ds).toBeNull();
    expect(config.cookies).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
    expect(config.trustedOrigins).toEqual([]);
  });

  it('defaults Ontology mode to vidak_private and keeps metastate_official opt-in', () => {
    expect(readW3dsOntologyMode({})).toBe('vidak_private');
    expect(readW3dsOntologyMode({ W3DS_ONTOLOGY_MODE: 'vidak_private' })).toBe('vidak_private');
    expect(readW3dsOntologyMode({ W3DS_ONTOLOGY_MODE: 'metastate_official' })).toBe(
      'metastate_official',
    );
    expect(() => readW3dsOntologyMode({ W3DS_ONTOLOGY_MODE: 'other' })).toThrow(
      /W3DS_ONTOLOGY_MODE must be/,
    );
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
    expect(config.ontologyMode).toBe('vidak_private');
    expect(config.w3ds?.ontologyMode).toBe('vidak_private');
    expect(config.w3ds?.ontologyAdapter).toBeNull();
  });

  it('fills Vidak private Video domain schema IDs when ontology mode is vidak_private', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'production',
      ...w3dsEnv,
      W3DS_ONTOLOGY_MODE: 'vidak_private',
      W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
      W3DS_ONTOLOGY_BASE_URL: 'https://vidak.example/api/w3ds/ontology',
      W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'schema-profile-local',
      W3DS_ADAPTER_MAPPING_VERSION: '2',
    });

    expect(config.ontologyMode).toBe('vidak_private');
    expect(config.w3ds?.ontologyAdapter).toEqual({
      ontologyBaseUrl: 'https://vidak.example/api/w3ds/ontology',
      mappingVersion: 2,
      schemaIds: {
        profile: 'schema-profile-local',
        channel: VIDAK_PRIVATE_SCHEMA_IDS.Channel,
        video: VIDAK_PRIVATE_SCHEMA_IDS.Video,
        playlist: VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
        comment: VIDAK_PRIVATE_SCHEMA_IDS.Comment,
      },
    });
  });

  it('validates Ontology base URL and every entity schemaId in metastate_official mode', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'production',
      ...w3dsEnv,
      W3DS_ONTOLOGY_MODE: 'metastate_official',
      W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
      W3DS_ONTOLOGY_BASE_URL: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
      W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'schema-profile',
      W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: 'schema-channel',
      W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: 'schema-video',
      W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: 'schema-playlist',
      W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: 'schema-comment',
      W3DS_ADAPTER_MAPPING_VERSION: '2',
    });

    expect(config.ontologyMode).toBe('metastate_official');
    expect(config.w3ds?.ontologyAdapter).toEqual({
      ontologyBaseUrl: `${DOCUMENTED_W3DS_ONTOLOGY_BASE_URL}/`,
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
        W3DS_ONTOLOGY_MODE: 'metastate_official',
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
      }),
    ).toThrow(/W3DS_ONTOLOGY_SCHEMA_ID_PROFILE/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_ONTOLOGY_MODE: 'metastate_official',
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
        W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'TODO',
        W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: 'schema-channel',
        W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: 'schema-video',
        W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: 'schema-playlist',
        W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: 'schema-comment',
      }),
    ).toThrow(/placeholder schema IDs/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_ONTOLOGY_MODE: 'metastate_official',
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
        W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'schema-profile',
        W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: VIDAK_PRIVATE_SCHEMA_IDS.Channel,
        W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: VIDAK_PRIVATE_SCHEMA_IDS.Video,
        W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
        W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: VIDAK_PRIVATE_SCHEMA_IDS.Comment,
      }),
    ).toThrow(/rejects Vidak private schema IDs/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_ONTOLOGY_MODE: 'metastate_official',
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
        W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'schema-profile',
        W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: 'schema-channel',
        W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: '<ASSIGNED_BY_METASTATE:Video>',
        W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: 'schema-playlist',
        W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: 'schema-comment',
      }),
    ).toThrow(/placeholder schema IDs/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_ONTOLOGY_MODE: 'metastate_official',
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
        W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'schema-profile',
        W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: 'schema-channel',
        W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: '550e8400-e29b-41d4-a716-446655440001',
        W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: 'schema-playlist',
        W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: 'schema-comment',
      }),
    ).toThrow(/example ontology ID/);

    expect(() =>
      loadServerSecurityConfig({
        NODE_ENV: 'production',
        ...w3dsEnv,
        W3DS_ONTOLOGY_MODE: 'metastate_official',
        W3DS_ONTOLOGY_ADAPTER_ENABLED: 'true',
        W3DS_ONTOLOGY_BASE_URL: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
        W3DS_ONTOLOGY_SCHEMA_ID_PROFILE: 'schema-profile-local',
        W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL: 'schema-channel',
        W3DS_ONTOLOGY_SCHEMA_ID_VIDEO: 'schema-video',
        W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST: 'schema-playlist',
        W3DS_ONTOLOGY_SCHEMA_ID_COMMENT: 'schema-comment',
      }),
    ).toThrow(/private Profile latch/);
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

  it('marks Secure cookies from the client connection, not NODE_ENV alone', () => {
    expect(
      resolveRequestCookieSecure(new Request('http://127.0.0.1:3910/api/auth/offer/x/continue')),
    ).toBe(false);
    expect(
      resolveRequestCookieSecure(
        new Request('https://vidak.postplatforms.com/api/auth/offer/x/continue'),
      ),
    ).toBe(true);
    expect(
      resolveRequestCookieSecure(
        new Request('http://127.0.0.1:3910/api/auth/offer/x/continue', {
          headers: { 'x-forwarded-proto': 'https' },
        }),
      ),
    ).toBe(true);
  });

  it('requires both AaaS webhook secret and an explicit signature encoding', () => {
    expect(readW3dsAaasWebhookConfig({})).toBeNull();
    expect(
      readW3dsAaasWebhookConfig({
        W3DS_AAAS_WEBHOOK_SECRET: 'secret',
        W3DS_AAAS_SIGNATURE_ENCODING: 'base64',
      }),
    ).toEqual({ secret: 'secret', encoding: 'base64' });
  });
});
