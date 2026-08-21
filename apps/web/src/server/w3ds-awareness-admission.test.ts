import { describe, expect, it, vi } from 'vitest';
import { DOCUMENTED_W3DS_ONTOLOGY_BASE_URL, type W3dsOntologyAdapterConfig } from './server-config';
import { admitW3dsAwarenessEnvelope } from './w3ds-awareness-admission';
import { W3DS_OFFICIAL_MAPPING_RULES_VERSION } from './w3ds-mapping-rules';
import { DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS } from './w3ds-schema-id-policy';

vi.mock('server-only', () => ({}));

const officialAdapter: W3dsOntologyAdapterConfig = {
  ontologyBaseUrl: DOCUMENTED_W3DS_ONTOLOGY_BASE_URL,
  mappingVersion: W3DS_OFFICIAL_MAPPING_RULES_VERSION,
  schemaIds: {
    profile: 'schema-profile-configured',
    channel: 'schema-channel-configured',
    video: 'schema-video-configured',
    playlist: 'schema-playlist-configured',
    comment: 'schema-comment-configured',
  },
};

function envelope(schemaId = officialAdapter.schemaIds.channel) {
  return {
    id: 'global-channel-1',
    w3id: '@creator.w3id',
    schemaId,
    data: { name: 'Creator' },
  };
}

describe('W3DS Awareness schema admission', () => {
  it('ignores every packet until the official ontology mode and complete adapter config are enabled', () => {
    expect(
      admitW3dsAwarenessEnvelope({
        envelope: envelope(),
        ontologyMode: 'vidak_private',
        ontologyAdapter: officialAdapter,
      }),
    ).toEqual({ status: 'ignored' });
    expect(
      admitW3dsAwarenessEnvelope({
        envelope: envelope(),
        ontologyMode: 'metastate_official',
        ontologyAdapter: null,
      }),
    ).toEqual({ status: 'ignored' });
  });

  it('makes only an explicitly configured Mapping Rules schema eligible', () => {
    const admitted = admitW3dsAwarenessEnvelope({
      envelope: envelope(),
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    });
    expect(admitted).toMatchObject({
      status: 'eligible',
      mapping: { tableName: 'creator_channels', schemaId: officialAdapter.schemaIds.channel },
    });

    expect(
      admitW3dsAwarenessEnvelope({
        envelope: envelope('unknown-schema'),
        ontologyMode: 'metastate_official',
        ontologyAdapter: officialAdapter,
      }),
    ).toEqual({ status: 'ignored' });
  });

  it('admits the separately configured Video mapping while leaving other schemas ignored', () => {
    const admitted = admitW3dsAwarenessEnvelope({
      envelope: envelope(officialAdapter.schemaIds.video),
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    });
    expect(admitted).toMatchObject({
      status: 'eligible',
      mapping: { tableName: 'videos', schemaId: officialAdapter.schemaIds.video },
    });
  });

  it('fails closed rather than reuse documented example ontology IDs', () => {
    expect(
      admitW3dsAwarenessEnvelope({
        envelope: envelope(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost),
        ontologyMode: 'metastate_official',
        ontologyAdapter: {
          ...officialAdapter,
          schemaIds: {
            ...officialAdapter.schemaIds,
            channel: DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost,
          },
        },
      }),
    ).toEqual({ status: 'ignored' });
  });
});
