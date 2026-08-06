import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import {
  VIDAK_PRIVATE_ONTOLOGY_CACHE_CONTROL,
  VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
  VIDAK_PRIVATE_SCHEMA_IDS,
} from '../../../../../server/w3ds-private-ontology';
import { GET as getSchemaById } from './[schemaId]/route';
import { GET as listSchemas } from './route';

describe('GET /api/w3ds/ontology/schemas', () => {
  it('returns the private catalogue listing with cache and ownership headers', async () => {
    const response = await listSchemas();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(response.headers.get('Cache-Control')).toBe(VIDAK_PRIVATE_ONTOLOGY_CACHE_CONTROL);
    expect(response.headers.get('X-Vidak-Ontology-Ownership')).toBe('vidak_private');
    expect(response.headers.get('X-Vidak-Ontology-Visibility')).toBe('private');
    expect(response.headers.get('X-Vidak-Ontology-Catalogue')).toBe(
      VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
    );

    const body = (await response.json()) as {
      ownership: string;
      visibility: string;
      metastateIssuedW3id: boolean;
      canonicalPublicW3dsSchema: boolean;
      schemas: Array<{ id: string; title: string; ownership: string }>;
    };
    expect(body.ownership).toBe('vidak_private');
    expect(body.visibility).toBe('private');
    expect(body.metastateIssuedW3id).toBe(false);
    expect(body.canonicalPublicW3dsSchema).toBe(false);
    expect(body.schemas.map((s) => s.title)).toEqual(['Video', 'Channel', 'Playlist', 'Comment']);
    expect(body.schemas.map((s) => s.id)).toEqual([
      VIDAK_PRIVATE_SCHEMA_IDS.Video,
      VIDAK_PRIVATE_SCHEMA_IDS.Channel,
      VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
      VIDAK_PRIVATE_SCHEMA_IDS.Comment,
    ]);
    expect(body.schemas.every((s) => s.ownership === 'vidak_private')).toBe(true);
  });
});

describe('GET /api/w3ds/ontology/schemas/[schemaId]', () => {
  it('returns a draft-07 Video schema for the stable Vidak private ID', async () => {
    const response = await getSchemaById(
      new NextRequest(
        `https://vidak.example/api/w3ds/ontology/schemas/${encodeURIComponent(VIDAK_PRIVATE_SCHEMA_IDS.Video)}`,
      ),
      { params: Promise.resolve({ schemaId: VIDAK_PRIVATE_SCHEMA_IDS.Video }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(VIDAK_PRIVATE_ONTOLOGY_CACHE_CONTROL);
    expect(response.headers.get('X-Vidak-Ontology-Ownership')).toBe('vidak_private');

    const body = (await response.json()) as {
      $schema: string;
      schemaId: string;
      title: string;
      ownership: string;
      visibility: string;
      metastateIssuedW3id: boolean;
      required: string[];
      properties: { ownerEName: { pattern?: string }; mediaFileUri: { pattern?: string } };
    };
    expect(body.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(body.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Video);
    expect(body.title).toBe('Video');
    expect(body.ownership).toBe('vidak_private');
    expect(body.visibility).toBe('private');
    expect(body.metastateIssuedW3id).toBe(false);
    expect(body.required).toContain('ownerEName');
    expect(body.properties.ownerEName.pattern).toBe('^@[^\\s@]+$');
    expect(body.properties.mediaFileUri.pattern).toContain('w3ds://file');
  });

  it('decodes percent-encoded schema IDs', async () => {
    const encoded = encodeURIComponent(VIDAK_PRIVATE_SCHEMA_IDS.Channel);
    const response = await getSchemaById(
      new NextRequest(`https://vidak.example/api/w3ds/ontology/schemas/${encoded}`),
      { params: Promise.resolve({ schemaId: encoded }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaId: VIDAK_PRIVATE_SCHEMA_IDS.Channel,
      title: 'Channel',
      ownership: 'vidak_private',
    });
  });

  it('returns strict JSON 404 for unknown schema IDs', async () => {
    const response = await getSchemaById(
      new NextRequest(
        'https://vidak.example/api/w3ds/ontology/schemas/550e8400-e29b-41d4-a716-446655440001',
      ),
      {
        params: Promise.resolve({
          schemaId: '550e8400-e29b-41d4-a716-446655440001',
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Vidak-Ontology-Ownership')).toBe('vidak_private');

    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        ownership: string;
        metastateIssuedW3id: boolean;
      };
    };
    expect(body.error.code).toBe('schema_not_found');
    expect(body.error.ownership).toBe('vidak_private');
    expect(body.error.metastateIssuedW3id).toBe(false);
    expect(body.error.message).toMatch(/Vidak private ontology schema/);
  });

  it('returns JSON 400 for an empty schemaId', async () => {
    const response = await getSchemaById(
      new NextRequest('https://vidak.example/api/w3ds/ontology/schemas/'),
      { params: Promise.resolve({ schemaId: '   ' }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_schema_id', ownership: 'vidak_private' },
    });
  });
});
