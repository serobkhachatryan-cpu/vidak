import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  getVidakPrivateOntologySchema,
  listVidakPrivateOntologySchemas,
  toW3dsCompatibleSchemaSummaries,
  VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
  VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
  VIDAK_PRIVATE_ONTOLOGY_TITLES,
  VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
  VIDAK_PRIVATE_SCHEMA_IDS,
  type VidakPrivateOntologyTitle,
} from './index';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(moduleDir, 'schemas');
const proposalExamplesDir = join(
  moduleDir,
  '../../../../../docs/proposals/w3ds-ontology-vidak-v1/examples',
);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function examplePath(title: VidakPrivateOntologyTitle, kind: 'valid' | 'invalid'): string {
  return join(proposalExamplesDir, `${title.toLowerCase()}.${kind}.json`);
}

describe('Vidak private Ontology catalogue contracts', () => {
  it('ships exactly four versioned private schema documents', () => {
    expect(readdirSync(schemasDir).sort()).toEqual([
      'Channel.schema.json',
      'Comment.schema.json',
      'Playlist.schema.json',
      'Video.schema.json',
    ]);
  });

  it('lists W3DS-compatible id/title summaries with private ownership labels', () => {
    const listed = listVidakPrivateOntologySchemas();
    expect(listed.ownership).toBe(VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP);
    expect(listed.visibility).toBe(VIDAK_PRIVATE_ONTOLOGY_VISIBILITY);
    expect(listed.catalogue).toBe(VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION);
    expect(listed.metastateIssuedW3id).toBe(false);
    expect(listed.canonicalPublicW3dsSchema).toBe(false);
    expect(listed.schemas).toHaveLength(4);

    const summaries = toW3dsCompatibleSchemaSummaries(listed);
    expect(summaries).toEqual([
      { id: VIDAK_PRIVATE_SCHEMA_IDS.Video, title: 'Video' },
      { id: VIDAK_PRIVATE_SCHEMA_IDS.Channel, title: 'Channel' },
      { id: VIDAK_PRIVATE_SCHEMA_IDS.Playlist, title: 'Playlist' },
      { id: VIDAK_PRIVATE_SCHEMA_IDS.Comment, title: 'Comment' },
    ]);
  });

  for (const title of VIDAK_PRIVATE_ONTOLOGY_TITLES) {
    describe(title, () => {
      const schemaId = VIDAK_PRIVATE_SCHEMA_IDS[title];
      const listed = getVidakPrivateOntologySchema(schemaId);

      it('is draft-07 with a stable Vidak-owned schemaId (not a MetaState W3ID)', () => {
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        const schema = listed.schema;
        expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
        expect(schema.title).toBe(title);
        expect(schema.schemaId).toBe(schemaId);
        expect(schemaId.startsWith('vidak:private:ontology:v1:')).toBe(true);
        expect(schema.ownership).toBe('vidak_private');
        expect(schema.visibility).toBe('private');
        expect(schema.metastateIssuedW3id).toBe(false);
        expect(schema.canonicalPublicW3dsSchema).toBe(false);
        expect(schema.$comment).toMatch(/PRIVATE Vidak-owned/i);
        expect(schema.$comment).toMatch(/not a MetaState-issued W3ID/i);
        expect(schema.additionalProperties).toBe(false);
        // Must not reuse MetaState documentation example UUIDs.
        expect(JSON.stringify(schema)).not.toMatch(/550e8400-e29b-41d4-a716-44665544000[0-9]/i);
      });

      it('requires ownerEName and documents id/reference fields', () => {
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        const required = listed.schema.required;
        const properties = listed.schema.properties as Record<string, { pattern?: string }>;
        expect(required).toContain('ownerEName');
        expect(required).toContain('id');
        expect(properties.ownerEName?.pattern).toBe('^@[^\\s@]+$');
      });

      it('accepts the valid proposal example and rejects the invalid example', () => {
        expect(listed.ok).toBe(true);
        if (!listed.ok) return;
        const ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(ajv);
        const validate = ajv.compile(listed.schema);
        expect(validate(readJson(examplePath(title, 'valid')))).toBe(true);
        expect(validate(readJson(examplePath(title, 'invalid')))).toBe(false);
        expect(validate.errors?.length).toBeGreaterThan(0);
      });
    });
  }

  it('validates Video media fields as w3ds://file URIs only', () => {
    const result = getVidakPrivateOntologySchema(VIDAK_PRIVATE_SCHEMA_IDS.Video);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const properties = result.schema.properties as {
      mediaFileUri: { pattern?: string };
      thumbnailFileUri: { pattern?: string };
      status: { enum?: string[] };
      visibility: { enum?: string[] };
    };
    expect(properties.mediaFileUri.pattern).toBe('^w3ds://file\\?id=@[^/\\s]+/[^\\s]+$');
    expect(properties.thumbnailFileUri.pattern).toBe('^w3ds://file\\?id=@[^/\\s]+/[^\\s]+$');
    expect(properties.status.enum).toEqual(['draft', 'processing', 'published', 'archived']);
    expect(properties.visibility.enum).toEqual(['public', 'unlisted', 'private']);
  });

  it('returns 404 contract for unknown and MetaState-looking schema IDs', () => {
    for (const id of [
      'missing',
      '550e8400-e29b-41d4-a716-446655440001',
      'vidak:private:ontology:v1:profile',
    ]) {
      const result = getVidakPrivateOntologySchema(id);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe('schema_not_found');
      expect(result.body.error.ownership).toBe('vidak_private');
      expect(result.body.error.metastateIssuedW3id).toBe(false);
    }
  });
});
