import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCUMENTED_W3DS_ONTOLOGY_BASE_URL, type W3dsOntologyAdapterConfig } from './server-config';
import {
  createW3dsOfficialHttpEvaultClient,
  requireW3dsOfficialEVaultClient,
  resolveW3dsOfficialAdapterWriteGate,
  resolveW3dsOfficialEVaultClient,
  W3DS_OFFICIAL_EVAULT_CLIENT_GAPS,
  W3dsOfficialAdapterGateError,
} from './w3ds-official-adapter-gate';
import { VIDAK_PRIVATE_SCHEMA_IDS } from './w3ds-private-ontology';
import { VIDAK_PRIVATE_PROFILE_SCHEMA_ID_LATCH } from './w3ds-schema-id-policy';

const officialAdapter: W3dsOntologyAdapterConfig = {
  ontologyBaseUrl: `${DOCUMENTED_W3DS_ONTOLOGY_BASE_URL}/`,
  mappingVersion: 1,
  schemaIds: {
    profile: 'schema-profile-configured',
    channel: 'schema-channel-configured',
    video: 'schema-video-configured',
    playlist: 'schema-playlist-configured',
    comment: 'schema-comment-configured',
  },
};

const privateAdapter: W3dsOntologyAdapterConfig = {
  ontologyBaseUrl: 'https://vidak.example/api/w3ds/ontology',
  mappingVersion: 1,
  schemaIds: {
    profile: VIDAK_PRIVATE_PROFILE_SCHEMA_ID_LATCH,
    channel: VIDAK_PRIVATE_SCHEMA_IDS.Channel,
    video: VIDAK_PRIVATE_SCHEMA_IDS.Video,
    playlist: VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
    comment: VIDAK_PRIVATE_SCHEMA_IDS.Comment,
  },
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function listFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path));
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('official adapter write gate', () => {
  it('resolves the official eVault client as unavailable', () => {
    expect(resolveW3dsOfficialEVaultClient()).toEqual({
      status: 'unavailable',
      missing: [...W3DS_OFFICIAL_EVAULT_CLIENT_GAPS],
    });
    expect(() => requireW3dsOfficialEVaultClient()).toThrow(W3dsOfficialAdapterGateError);
  });

  it('does not construct an HTTP eVault client in vidak_private even when the adapter is enabled', () => {
    const gate = resolveW3dsOfficialAdapterWriteGate({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateAdapter,
    });
    expect(gate).toMatchObject({
      allowed: false,
      officialEVaultWrites: false,
      metastateEVaultWrites: false,
      remoteW3dsNetworkCalls: false,
      interoperablePublicW3ds: false,
      httpEvaultClientConstructed: false,
      officialEvaultClient: 'unavailable',
      code: 'mode_unavailable',
    });
    expect(() =>
      createW3dsOfficialHttpEvaultClient({
        ontologyMode: 'vidak_private',
        ontologyAdapter: privateAdapter,
      }),
    ).toThrow(/must not construct an official HTTP eVault client/);
  });

  it('keeps metastate_official writes disabled until the official client exists', () => {
    const gate = resolveW3dsOfficialAdapterWriteGate({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.officialEVaultWrites).toBe(false);
    expect(gate.httpEvaultClientConstructed).toBe(false);
    expect(gate.remoteW3dsNetworkCalls).toBe(false);
    expect(gate.interoperablePublicW3ds).toBe(false);
    expect(gate.code).toBe('http_evault_client_unavailable');
    expect(() =>
      createW3dsOfficialHttpEvaultClient({
        ontologyMode: 'metastate_official',
        ontologyAdapter: officialAdapter,
      }),
    ).toThrow(/official eVault client is unavailable/);
  });

  it('does not import or construct the platform HTTP eVault client', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'w3ds-official-adapter-gate.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]\.\/w3ds-platform-evault['"]/);
    expect(source).not.toMatch(/new RegistryPlatformEVaultClient/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});

describe('P1A browser W3DS boundary', () => {
  it('does not add Mapping Rules, Ontology, or eVault clients to browser packages', () => {
    const roots = [
      join(repoRoot, 'packages/api-client/src'),
      join(repoRoot, 'packages/hooks/src'),
      join(repoRoot, 'apps/web/src/features'),
    ];
    const forbidden = [
      'w3ds-mapping-rules',
      'w3ds-official-adapter-gate',
      'w3ds-schema-id-policy',
      'w3ds-platform-evault',
      'w3ds-adapter-mapping',
      'ontology.w3ds.metastate.foundation',
      'createMetaEnvelope',
      'X-ENAME',
    ];

    for (const root of roots) {
      for (const file of listFiles(root)) {
        const source = readFileSync(file, 'utf8');
        for (const needle of forbidden) {
          expect(source, `${file} must not contain ${needle}`).not.toContain(needle);
        }
      }
    }
  });
});
