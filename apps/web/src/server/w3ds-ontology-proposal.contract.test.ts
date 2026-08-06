import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const proposalRoot = join(repoRoot, 'docs/proposals/w3ds-ontology-vidak-v1');
const schemasDir = join(proposalRoot, 'schemas');
const examplesDir = join(proposalRoot, 'examples');

const entityTitles = ['Video', 'Channel', 'Playlist', 'Comment'] as const;
type EntityTitle = (typeof entityTitles)[number];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function schemaPath(title: EntityTitle): string {
  return join(schemasDir, `${title}.schema.json`);
}

function examplePath(title: EntityTitle, kind: 'valid' | 'invalid'): string {
  return join(examplesDir, `${title.toLowerCase()}.${kind}.json`);
}

describe('W3DS ontology proposal v1 (local draft-07 contracts)', () => {
  it('ships exactly the four proposed entity schemas', () => {
    const files = readdirSync(schemasDir).sort();
    expect(files).toEqual([
      'Channel.schema.json',
      'Comment.schema.json',
      'Playlist.schema.json',
      'Video.schema.json',
    ]);
  });

  for (const title of entityTitles) {
    describe(title, () => {
      const schema = readJson(schemaPath(title)) as Record<string, unknown>;

      it('is draft-07, titled, strict, and has no invented schemaId', () => {
        expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
        expect(schema.title).toBe(title);
        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).toBe(false);
        expect(schema).not.toHaveProperty('schemaId');
        expect(JSON.stringify(schema)).not.toMatch(/550e8400-e29b-41d4-a716-44665544000[0-9]/i);
      });

      it('requires ownerEName and documents id/reference fields', () => {
        const required = schema.required as string[];
        const properties = schema.properties as Record<string, { pattern?: string }>;
        expect(required).toContain('ownerEName');
        expect(required).toContain('id');
        expect(properties.ownerEName?.pattern).toBe('^@[^\\s@]+$');
      });

      it('accepts the valid example and rejects the invalid example', () => {
        const ajv = new Ajv({ allErrors: true, strict: false });
        addFormats(ajv);
        const validate = ajv.compile(schema);
        const validExample = readJson(examplePath(title, 'valid'));
        const invalidExample = readJson(examplePath(title, 'invalid'));

        expect(validate(validExample)).toBe(true);
        expect(validate(invalidExample)).toBe(false);
        expect(validate.errors?.length).toBeGreaterThan(0);
      });
    });
  }

  it('designs Video media fields for w3ds://file only', () => {
    const schema = readJson(schemaPath('Video')) as {
      properties: {
        mediaFileUri: { pattern?: string };
        thumbnailFileUri: { pattern?: string };
      };
    };
    expect(schema.properties.mediaFileUri.pattern).toContain('w3ds://file');
    expect(schema.properties.thumbnailFileUri.pattern).toContain('w3ds://file');
  });
});
