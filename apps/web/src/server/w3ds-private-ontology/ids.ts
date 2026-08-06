/**
 * Stable, immutable Vidak-owned private Ontology schema IDs.
 *
 * These identifiers are NOT MetaState-issued W3IDs and MUST NOT be treated as
 * canonical public W3DS Ontology schema IDs. They exist only for Vidak's
 * private, platform-local catalogue at /api/w3ds/ontology.
 */

export const VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP = 'vidak_private' as const;
export const VIDAK_PRIVATE_ONTOLOGY_VISIBILITY = 'private' as const;
export const VIDAK_PRIVATE_ONTOLOGY_CATALOGUE_VERSION = 'vidak-private-ontology-v1' as const;

/** Entity titles published by the private catalogue (draft-07). */
export const VIDAK_PRIVATE_ONTOLOGY_TITLES = ['Video', 'Channel', 'Playlist', 'Comment'] as const;

export type VidakPrivateOntologyTitle = (typeof VIDAK_PRIVATE_ONTOLOGY_TITLES)[number];

/**
 * Immutable Vidak-owned schema IDs. Changing these breaks stored MetaEnvelope
 * ontology references — treat as append-only across catalogue versions.
 */
export const VIDAK_PRIVATE_SCHEMA_IDS = {
  Video: 'vidak:private:ontology:v1:video',
  Channel: 'vidak:private:ontology:v1:channel',
  Playlist: 'vidak:private:ontology:v1:playlist',
  Comment: 'vidak:private:ontology:v1:comment',
} as const satisfies Record<VidakPrivateOntologyTitle, string>;

export type VidakPrivateSchemaId = (typeof VIDAK_PRIVATE_SCHEMA_IDS)[VidakPrivateOntologyTitle];

export const VIDAK_PRIVATE_SCHEMA_ID_LIST: readonly VidakPrivateSchemaId[] = [
  VIDAK_PRIVATE_SCHEMA_IDS.Video,
  VIDAK_PRIVATE_SCHEMA_IDS.Channel,
  VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
  VIDAK_PRIVATE_SCHEMA_IDS.Comment,
];

export function isVidakPrivateSchemaId(value: string): value is VidakPrivateSchemaId {
  return (VIDAK_PRIVATE_SCHEMA_ID_LIST as readonly string[]).includes(value);
}

export function titleForVidakPrivateSchemaId(
  schemaId: VidakPrivateSchemaId,
): VidakPrivateOntologyTitle {
  for (const title of VIDAK_PRIVATE_ONTOLOGY_TITLES) {
    if (VIDAK_PRIVATE_SCHEMA_IDS[title] === schemaId) return title;
  }
  throw new Error(`Unknown Vidak private schemaId: ${schemaId}`);
}
