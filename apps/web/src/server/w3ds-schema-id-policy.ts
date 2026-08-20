/**
 * Fail-closed schemaId policy for official Ontology adapter configuration.
 *
 * IDs come from operator configuration. This module never invents schemaIds and
 * rejects placeholders, Vidak-private IDs, and documented example ontology IDs
 * used for the wrong entity. Source: .agents/skills/w3ds/reference/registry.md
 * canonical ontology table.
 */

import type { W3dsAdapterEntityType } from './w3ds-adapter-types';
import { isVidakPrivateSchemaId } from './w3ds-private-ontology';

/** Published User ontology. Valid for `profile` only — never Video/Channel/Playlist/Comment. */
export const DOCUMENTED_W3DS_USER_SCHEMA_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Documented example ontology IDs from the Registry/Ontology reference.
 * They must not be reused as Vidak Video/Channel/Playlist/Comment schemaIds.
 */
export const DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS = {
  User: DOCUMENTED_W3DS_USER_SCHEMA_ID,
  SocialMediaPost: '550e8400-e29b-41d4-a716-446655440001',
  Group: '550e8400-e29b-41d4-a716-446655440003',
  Ledger: '550e8400-e29b-41d4-a716-446655440006',
  Currency: '550e8400-e29b-41d4-a716-446655440008',
  Account: '6fda64db-fd14-4fa2-bd38-77d2e5e6136d',
  BindingDocument: 'b1d0a8c3-4e5f-6789-0abc-def012345678',
  File: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  W3dsFileV1: 'w3ds-file-v1',
} as const;

/** Private-mode Profile config latch — not a MetaState W3ID. */
export const VIDAK_PRIVATE_PROFILE_SCHEMA_ID_LATCH = 'schema-profile-local';

const videoDomainEntities = new Set<W3dsAdapterEntityType>([
  'channel',
  'video',
  'playlist',
  'comment',
]);

export class W3dsSchemaIdPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W3dsSchemaIdPolicyError';
  }
}

export function isDisallowedPlaceholderSchemaId(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (lower === 'todo' || lower === 'changeme' || lower === 'undefined' || lower === 'null') {
    return true;
  }
  if (lower.includes('assigned_by_metastate')) return true;
  return false;
}

export function isDocumentedExampleOntologySchemaId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return Object.values(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS).some(
    (exampleId) => exampleId.toLowerCase() === normalized,
  );
}

/**
 * Official-mode schemaId check. Does not treat an operator-supplied unknown
 * W3ID as valid catalogue membership — that remains a MetaState gate. It only
 * refuses IDs that are known-invalid.
 */
export function assertAllowedOfficialSchemaId(
  entityType: W3dsAdapterEntityType,
  schemaId: string,
): void {
  const normalized = schemaId.trim();
  if (isDisallowedPlaceholderSchemaId(normalized)) {
    throw new W3dsSchemaIdPolicyError(
      `Official adapter schemaId for ${entityType} is a placeholder ("${normalized}"). Do not guess Ontology IDs.`,
    );
  }
  if (normalized.startsWith('vidak:private:') || isVidakPrivateSchemaId(normalized)) {
    throw new W3dsSchemaIdPolicyError(
      `W3DS_ONTOLOGY_MODE=metastate_official rejects Vidak private schema IDs for ${entityType} ("${normalized}").`,
    );
  }
  if (normalized === VIDAK_PRIVATE_PROFILE_SCHEMA_ID_LATCH) {
    throw new W3dsSchemaIdPolicyError(
      `Official adapter schemaId for ${entityType} cannot use the private Profile latch ("${normalized}").`,
    );
  }

  const isExample = isDocumentedExampleOntologySchemaId(normalized);
  if (!isExample) return;

  const isUserOntology = normalized.toLowerCase() === DOCUMENTED_W3DS_USER_SCHEMA_ID.toLowerCase();
  if (entityType === 'profile' && isUserOntology) return;

  throw new W3dsSchemaIdPolicyError(
    `Official adapter schemaId for ${entityType} cannot use a documented example ontology ID ("${normalized}"). Video/Channel/Playlist/Comment IDs must be MetaState-assigned; do not reuse User, SocialMediaPost, Group, File, or w3ds-file-v1.`,
  );
}

export function assertAllowedOfficialSchemaIds(
  schemaIds: Record<W3dsAdapterEntityType, string>,
): void {
  for (const entityType of videoDomainEntities) {
    const schemaId = schemaIds[entityType];
    assertAllowedOfficialSchemaId(entityType, schemaId);
  }
  assertAllowedOfficialSchemaId('profile', schemaIds.profile);
}
