/**
 * Static Vidak-owned private Ontology catalogue.
 *
 * Serves draft-07 schemas with stable Vidak schema IDs for platform-local use.
 * Read-only: no register/write endpoint. Not a MetaState Ontology deployment.
 */

import {
  isVidakPrivateSchemaId,
  titleForVidakPrivateSchemaId,
  VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
  VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
  VIDAK_PRIVATE_ONTOLOGY_TITLES,
  VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
  VIDAK_PRIVATE_SCHEMA_IDS,
  type VidakPrivateOntologyTitle,
  type VidakPrivateSchemaId,
} from './ids';
import channelSchema from './schemas/Channel.schema.json';
import commentSchema from './schemas/Comment.schema.json';
import playlistSchema from './schemas/Playlist.schema.json';
import videoSchema from './schemas/Video.schema.json';

/** Cache policy for the versioned static catalogue. */
export const VIDAK_PRIVATE_ONTOLOGY_CACHE_CONTROL =
  'public, max-age=300, stale-while-revalidate=86400';

export const VIDAK_PRIVATE_ONTOLOGY_JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': VIDAK_PRIVATE_ONTOLOGY_CACHE_CONTROL,
  'X-Content-Type-Options': 'nosniff',
  'X-Vidak-Ontology-Ownership': VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
  'X-Vidak-Ontology-Visibility': VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
  'X-Vidak-Ontology-Catalogue': VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
} as const;

export interface VidakPrivateOntologySchemaDocument {
  $schema: string;
  $id: string;
  $comment: string;
  schemaId: VidakPrivateSchemaId;
  title: VidakPrivateOntologyTitle;
  description: string;
  type: 'object';
  additionalProperties: false;
  required: string[];
  properties: Record<string, unknown>;
}

export interface VidakPrivateOntologySchemaListItem {
  id: VidakPrivateSchemaId;
  title: VidakPrivateOntologyTitle;
  ownership: typeof VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP;
  visibility: typeof VIDAK_PRIVATE_ONTOLOGY_VISIBILITY;
  catalogue: typeof VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION;
  /** Explicit non-claim: these are not MetaState-issued W3IDs. */
  metastateIssuedW3id: false;
  canonicalPublicW3dsSchema: false;
}

export interface VidakPrivateOntologyListResponse {
  ownership: typeof VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP;
  visibility: typeof VIDAK_PRIVATE_ONTOLOGY_VISIBILITY;
  catalogue: typeof VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION;
  compatibility: 'w3ds-ontology-get-schemas';
  metastateIssuedW3id: false;
  canonicalPublicW3dsSchema: false;
  note: string;
  schemas: VidakPrivateOntologySchemaListItem[];
}

export interface VidakPrivateOntologySchemaResponse extends VidakPrivateOntologySchemaDocument {
  ownership: typeof VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP;
  visibility: typeof VIDAK_PRIVATE_ONTOLOGY_VISIBILITY;
  catalogue: typeof VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION;
  metastateIssuedW3id: false;
  canonicalPublicW3dsSchema: false;
}

export interface VidakPrivateOntologyErrorBody {
  error: {
    code: 'schema_not_found' | 'invalid_schema_id';
    message: string;
    ownership: typeof VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP;
    visibility: typeof VIDAK_PRIVATE_ONTOLOGY_VISIBILITY;
    catalogue: typeof VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION;
    metastateIssuedW3id: false;
    canonicalPublicW3dsSchema: false;
  };
}

const SCHEMA_BY_TITLE: Record<VidakPrivateOntologyTitle, VidakPrivateOntologySchemaDocument> = {
  Video: videoSchema as VidakPrivateOntologySchemaDocument,
  Channel: channelSchema as VidakPrivateOntologySchemaDocument,
  Playlist: playlistSchema as VidakPrivateOntologySchemaDocument,
  Comment: commentSchema as VidakPrivateOntologySchemaDocument,
};

const LIST_NOTE =
  'Vidak-owned private Ontology catalogue for platform-local use only. Schema IDs are stable Vidak identifiers, not MetaState-issued W3IDs or canonical public W3DS schemas.';

function assertCatalogueIntegrity(): void {
  for (const title of VIDAK_PRIVATE_ONTOLOGY_TITLES) {
    const schema = SCHEMA_BY_TITLE[title];
    const expectedId = VIDAK_PRIVATE_SCHEMA_IDS[title];
    if (schema.title !== title) {
      throw new Error(`Private ontology schema title mismatch for ${title}`);
    }
    if (schema.schemaId !== expectedId) {
      throw new Error(`Private ontology schemaId mismatch for ${title}`);
    }
    if (schema.$schema !== 'http://json-schema.org/draft-07/schema#') {
      throw new Error(`Private ontology schema must be draft-07: ${title}`);
    }
  }
}

assertCatalogueIntegrity();

export function listVidakPrivateOntologySchemas(): VidakPrivateOntologyListResponse {
  return {
    ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
    visibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
    catalogue: VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
    compatibility: 'w3ds-ontology-get-schemas',
    metastateIssuedW3id: false,
    canonicalPublicW3dsSchema: false,
    note: LIST_NOTE,
    schemas: VIDAK_PRIVATE_ONTOLOGY_TITLES.map((title) => ({
      id: VIDAK_PRIVATE_SCHEMA_IDS[title],
      title,
      ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
      visibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
      catalogue: VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
      metastateIssuedW3id: false,
      canonicalPublicW3dsSchema: false,
    })),
  };
}

export function getVidakPrivateOntologySchema(
  schemaIdRaw: string,
):
  | { ok: true; schema: VidakPrivateOntologySchemaResponse }
  | { ok: false; status: 400 | 404; body: VidakPrivateOntologyErrorBody } {
  const schemaId = decodeSchemaIdParam(schemaIdRaw);
  if (!schemaId) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: 'invalid_schema_id',
          message: 'schemaId path parameter is required.',
          ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
          visibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
          catalogue: VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
          metastateIssuedW3id: false,
          canonicalPublicW3dsSchema: false,
        },
      },
    };
  }

  if (!isVidakPrivateSchemaId(schemaId)) {
    return {
      ok: false,
      status: 404,
      body: {
        error: {
          code: 'schema_not_found',
          message: `No Vidak private ontology schema for id "${schemaId}". IDs are Vidak-owned, not MetaState W3IDs.`,
          ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
          visibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
          catalogue: VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
          metastateIssuedW3id: false,
          canonicalPublicW3dsSchema: false,
        },
      },
    };
  }

  const title = titleForVidakPrivateSchemaId(schemaId);
  const document = SCHEMA_BY_TITLE[title];
  return {
    ok: true,
    schema: {
      ...document,
      ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
      visibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
      catalogue: VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION,
      metastateIssuedW3id: false,
      canonicalPublicW3dsSchema: false,
    },
  };
}

export function decodeSchemaIdParam(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** W3DS-compatible list projection: [{ id, title }, ...] plus ownership labels. */
export function toW3dsCompatibleSchemaSummaries(
  response: VidakPrivateOntologyListResponse,
): Array<{ id: string; title: string }> {
  return response.schemas.map(({ id, title }) => ({ id, title }));
}
