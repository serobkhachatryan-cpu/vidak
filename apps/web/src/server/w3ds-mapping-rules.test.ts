import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCUMENTED_W3DS_ONTOLOGY_BASE_URL, type W3dsOntologyAdapterConfig } from './server-config';
import { entityTypeForAdapterTable, W3DS_ADAPTER_ENTITY_TABLES } from './w3ds-adapter-mapping';
import {
  bundledOfficialMappingRuleSources,
  loadOfficialMappingRules,
  W3DS_OFFICIAL_MAPPING_RULES_VERSION,
  W3dsMappingRulesError,
} from './w3ds-mapping-rules';
import {
  DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS,
  DOCUMENTED_W3DS_USER_SCHEMA_ID,
} from './w3ds-schema-id-policy';

const officialAdapter: W3dsOntologyAdapterConfig = {
  ontologyBaseUrl: `${DOCUMENTED_W3DS_ONTOLOGY_BASE_URL}/`,
  mappingVersion: W3DS_OFFICIAL_MAPPING_RULES_VERSION,
  schemaIds: {
    profile: 'schema-profile-configured',
    channel: 'schema-channel-configured',
    video: 'schema-video-configured',
    playlist: 'schema-playlist-configured',
    comment: 'schema-comment-configured',
  },
};

function cloneSource(index: number): Record<string, unknown> {
  const source = bundledOfficialMappingRuleSources()[index];
  return { ...(source as Record<string, unknown>) };
}

describe('official Mapping Rules loader', () => {
  it('maps tableName to adapter entity types without inventing tables', () => {
    expect(entityTypeForAdapterTable(W3DS_ADAPTER_ENTITY_TABLES.video)).toBe('video');
    expect(entityTypeForAdapterTable(W3DS_ADAPTER_ENTITY_TABLES.channel)).toBe('channel');
    expect(entityTypeForAdapterTable('unknown_table')).toBeUndefined();
  });

  it('injects configured schemaIds and never reports remote W3DS success', () => {
    const loaded = loadOfficialMappingRules({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    });

    expect(loaded.mappingVersion).toBe(1);
    expect(loaded.officialEVaultWrites).toBe(false);
    expect(loaded.metastateEVaultWrites).toBe(false);
    expect(loaded.remoteW3dsNetworkCalls).toBe(false);
    expect(loaded.interoperablePublicW3ds).toBe(false);
    expect(loaded.httpEvaultClientConstructed).toBe(false);

    const byTable = Object.fromEntries(loaded.documents.map((doc) => [doc.tableName, doc]));
    expect(byTable.videos?.schemaId).toBe('schema-video-configured');
    expect(byTable.creator_channels?.schemaId).toBe('schema-channel-configured');
    expect(byTable.playlists?.schemaId).toBe('schema-playlist-configured');
    expect(byTable.comments?.schemaId).toBe('schema-comment-configured');
    expect(byTable.videos?.ownerEnamePath).toBe('w3ds_platform_users(ownerId.eName)');
    expect(byTable.comments?.ownerEnamePath).toBe('w3ds_platform_users(authorId.eName)');
    expect(JSON.stringify(loaded.documents)).not.toMatch(/ASSIGNED_BY_METASTATE/);
  });

  it('keeps bundled sources as mapping-contract placeholders, not live IDs', () => {
    for (const source of bundledOfficialMappingRuleSources()) {
      const record = source as { schemaId: string; tableName: string };
      expect(record.schemaId).toMatch(/^<ASSIGNED_BY_METASTATE:(Video|Channel|Playlist|Comment)>$/);
      expect(record.schemaId).not.toBe(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost);
    }
  });

  it('rejects private mode, missing adapter config, and unavailable mapping versions', () => {
    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'vidak_private',
        ontologyAdapter: officialAdapter,
      }),
    ).toThrow(/W3DS_ONTOLOGY_MODE=metastate_official/);

    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: null,
      }),
    ).toThrow(W3dsMappingRulesError);

    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: { ...officialAdapter, mappingVersion: 2 },
      }),
    ).toThrow(/version 2 is not available/);
  });

  it('rejects placeholder, private, and example schema IDs from configuration', () => {
    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: {
          ...officialAdapter,
          schemaIds: {
            ...officialAdapter.schemaIds,
            video: '<ASSIGNED_BY_METASTATE:Video>',
          },
        },
      }),
    ).toThrow(/placeholder/i);

    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: {
          ...officialAdapter,
          schemaIds: {
            ...officialAdapter.schemaIds,
            channel: 'vidak:private:ontology:v1:channel',
          },
        },
      }),
    ).toThrow(/private schema IDs/);

    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: {
          ...officialAdapter,
          schemaIds: {
            ...officialAdapter.schemaIds,
            video: DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost,
          },
        },
      }),
    ).toThrow(/example ontology ID/);

    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: {
          ...officialAdapter,
          schemaIds: {
            ...officialAdapter.schemaIds,
            video: DOCUMENTED_W3DS_USER_SCHEMA_ID,
          },
        },
      }),
    ).toThrow(/example ontology ID/);
  });

  it('rejects baked-in example schemaIds, unknown keys, and invented directives', () => {
    const withExampleId = cloneSource(0);
    withExampleId.schemaId = DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost;
    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: officialAdapter,
        documents: [withExampleId, cloneSource(1), cloneSource(2), cloneSource(3)],
      }),
    ).toThrow(/must not bake in schemaId/);

    const withUnknownKey = cloneSource(0);
    withUnknownKey.customDirective = 'nope';
    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: officialAdapter,
        documents: [withUnknownKey, cloneSource(1), cloneSource(2), cloneSource(3)],
      }),
    ).toThrow(/undocumented key/);

    const withInventedDirective = cloneSource(0);
    withInventedDirective.localToUniversalMap = {
      ...(withInventedDirective.localToUniversalMap as Record<string, string>),
      title: '__invented(title)',
    };
    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: officialAdapter,
        documents: [withInventedDirective, cloneSource(1), cloneSource(2), cloneSource(3)],
      }),
    ).toThrow(/undocumented directive/);
  });

  it('rejects incomplete table coverage and missing ownerEnamePath', () => {
    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: officialAdapter,
        documents: [cloneSource(0), cloneSource(1), cloneSource(2)],
      }),
    ).toThrow(/missing the required table "comments"/);

    const missingOwner = cloneSource(0);
    delete missingOwner.ownerEnamePath;
    expect(() =>
      loadOfficialMappingRules({
        ontologyMode: 'metastate_official',
        ontologyAdapter: officialAdapter,
        documents: [missingOwner, cloneSource(1), cloneSource(2), cloneSource(3)],
      }),
    ).toThrow(/ownerEnamePath/);
  });
});

describe('official Mapping Rules are not loaded from the browser tree', () => {
  it('keeps the loader server-only next to the adapter mapping foundation', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'w3ds-mapping-rules.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/w3ds-platform-evault['"]/);
    expect(source).not.toMatch(/new RegistryPlatformEVaultClient/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
