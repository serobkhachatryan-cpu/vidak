/**
 * Adapter registry for video-like records already documented in this repository.
 *
 * Official W3DS Ontology: File, Chat, Message, GroupManifest, plus `w3ds-file-v1`.
 * Also listed: call-session records this repo already reads through eVault
 * `metaEnvelopes(filter: { ontologyId })`. Those are source adapters, not
 * product categories.
 *
 * Official Message.type is text | image | file | system, with mediaUrl on
 * image/file. This repo also already reads Meshenger video/circle messages
 * through the same Message ontology. Adapters must inventory both, but only
 * playable video media — type=file still requires a video MIME type or a
 * video filename; ZIPs and documents are never cards.
 *
 * Pagination: documented eVault `metaEnvelopes` uses `pageInfo.hasNextPage` /
 * `endCursor`. The inventory scanner follows every page of Chat, Message
 * (including `search: { fields: ["chatId"] }` history), File, w3ds-file-v1,
 * GroupManifest, and call-session on each authorized vault. That matches the
 * eID/Meshenger client's documented record types without calling Meshenger
 * private HTTP APIs or inventing GraphQL fields.
 */
export const documentedVideoSourceIds = [
  'w3ds-file',
  'file-record',
  'call-recording',
  'video-message',
] as const;

/** Official Message.type values from Ontology schema 550e8400-e29b-41d4-a716-446655440004. */
export const documentedMessageTypes = ['text', 'image', 'file', 'system'] as const;

/** Message types this repo already reads on the same Message ontology. */
export const documentedVideoMessageTypes = ['video', 'circle'] as const;

export type DocumentedVideoSourceId = (typeof documentedVideoSourceIds)[number];

export const documentedVideoSources: ReadonlyArray<{
  id: DocumentedVideoSourceId;
  ontologyId: string;
  kind: 'file' | 'call-recording' | 'video-message';
}> = [
  { id: 'w3ds-file', ontologyId: 'w3ds-file-v1', kind: 'file' },
  { id: 'file-record', ontologyId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', kind: 'file' },
  {
    id: 'call-recording',
    ontologyId: 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd',
    kind: 'call-recording',
  },
  {
    id: 'video-message',
    ontologyId: '550e8400-e29b-41d4-a716-446655440004',
    kind: 'video-message',
  },
];

/** Chat / group records used to follow authorized and historical references, never as UI categories. */
export const documentedAuthorizationOntologies = {
  chat: '550e8400-e29b-41d4-a716-446655440003',
  groupManifest: 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e',
} as const;

export function documentedOntologyId(id: DocumentedVideoSourceId): string {
  const source = documentedVideoSources.find((item) => item.id === id);
  if (!source) throw new Error(`Unknown documented video source: ${id}`);
  return source.ontologyId;
}
