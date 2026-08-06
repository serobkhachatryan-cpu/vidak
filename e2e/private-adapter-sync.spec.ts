import { expect, test } from '@playwright/test';

/**
 * End-to-end coverage for the Vidak-private ontology surface used by private
 * adapter sync. Sync itself is server-only (no public mutation endpoints);
 * durable projection behavior is covered by Vitest unit/integration suites.
 */
test('private ontology catalogue is Vidak-owned and not MetaState-issued', async ({ request }) => {
  const list = await request.get('/api/w3ds/ontology/schemas');
  expect(list.ok()).toBeTruthy();
  expect(list.headers()['x-vidak-ontology-ownership']).toBe('vidak_private');
  expect(list.headers()['x-vidak-ontology-visibility']).toBe('private');

  const body = (await list.json()) as {
    ownership: string;
    visibility: string;
    metastateIssuedW3id: boolean;
    canonicalPublicW3dsSchema: boolean;
    schemas: Array<{ id: string; ownership: string; metastateIssuedW3id: boolean }>;
  };

  expect(body.ownership).toBe('vidak_private');
  expect(body.visibility).toBe('private');
  expect(body.metastateIssuedW3id).toBe(false);
  expect(body.canonicalPublicW3dsSchema).toBe(false);
  expect(body.schemas).toHaveLength(4);
  expect(body.schemas.every((schema) => schema.ownership === 'vidak_private')).toBe(true);
  expect(body.schemas.every((schema) => schema.metastateIssuedW3id === false)).toBe(true);
  expect(body.schemas.map((schema) => schema.id).sort()).toEqual([
    'vidak:private:ontology:v1:channel',
    'vidak:private:ontology:v1:comment',
    'vidak:private:ontology:v1:playlist',
    'vidak:private:ontology:v1:video',
  ]);

  const video = await request.get('/api/w3ds/ontology/schemas/vidak:private:ontology:v1:video');
  expect(video.ok()).toBeTruthy();
  const videoBody = (await video.json()) as {
    schemaId: string;
    ownership: string;
    metastateIssuedW3id: boolean;
    canonicalPublicW3dsSchema: boolean;
  };
  expect(videoBody.schemaId).toBe('vidak:private:ontology:v1:video');
  expect(videoBody.ownership).toBe('vidak_private');
  expect(videoBody.metastateIssuedW3id).toBe(false);
  expect(videoBody.canonicalPublicW3dsSchema).toBe(false);
});
