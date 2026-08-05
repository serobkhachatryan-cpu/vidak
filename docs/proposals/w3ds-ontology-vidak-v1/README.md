# Vidak W3DS Ontology Proposal (v1)

**Status:** ready for MetaState maintainer submission  
**Proposal version:** `w3ds-ontology-vidak-v1`  
**Schemas:** Video, Channel, Playlist, Comment (JSON Schema draft-07)  
**Adapter flag:** `W3DS_ONTOLOGY_ADAPTER_ENABLED` remains **disabled**

## Why this package exists

Live Ontology (`GET https://ontology.w3ds.metastate.foundation/schemas`) does not
currently publish canonical Video, Channel, Playlist, or Comment schemas. Vidak
will not substitute SocialMediaPost, File, or any other existing schema, and
will not invent `schemaId` values.

This directory is the submission-ready proposal MetaState maintainers can copy
into `services/ontology/schemas/` (or the equivalent catalogue source), assign
stable W3ID `schemaId`s, and deploy.

## What MetaState must supply before Vidak enables the adapter

1. **Assigned stable schema IDs (W3IDs)** for each of:
   - Video → `W3DS_ONTOLOGY_SCHEMA_ID_VIDEO`
   - Channel → `W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL`
   - Playlist → `W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST`
   - Comment → `W3DS_ONTOLOGY_SCHEMA_ID_COMMENT`
   - (Profile remains a separate configured schema when the adapter is enabled.)
2. **Deployed catalogue availability** — each schema must be reachable via:
   - `GET {W3DS_ONTOLOGY_BASE_URL}/schemas` (listed with `id` + `title`)
   - `GET {W3DS_ONTOLOGY_BASE_URL}/schemas/:id` (full draft-07 document including
     the assigned `schemaId`)

Until both inputs exist, Vidak keeps Ontology adapter mapping writes fail-closed
and does **not** set `W3DS_ONTOLOGY_ADAPTER_ENABLED=true`.

## Package layout

| Path | Purpose |
| --- | --- |
| `schemas/*.schema.json` | Versioned draft-07 proposals (**no** invented `schemaId`) |
| `examples/*.valid.json` | Fixtures that must validate |
| `examples/*.invalid.json` | Fixtures that must fail validation |
| `mapping-contract.md` | Future Web3 Adapter `ownerEnamePath` + `localToUniversalMap` |
| `README.md` | This maintainer submission guide |

## Schema conventions

- `$schema`: `http://json-schema.org/draft-07/schema#`
- `title`: entity name (`Video`, `Channel`, `Playlist`, `Comment`)
- `additionalProperties`: `false`
- **Ownership:** every entity requires `ownerEName` (`^@[^\s@]+$`). Adapter
  mappings use `ownerEnamePath` (see `mapping-contract.md`).
- **IDs / references:** `id` and cross-entity `*Id` fields are MetaEnvelope
  object ids at the global layer, distinct from Vidak product-local primary keys.
- **Lifecycle / visibility:** Video uses `status` + `visibility`; Playlist and
  optional Channel/Comment visibility use `public` \| `unlisted` \| `private`.
- **Media:** Video `mediaFileUri` / `thumbnailFileUri` (and Channel/Playlist
  image fields) accept only `w3ds://file?id=@<ename>/<meta-envelope-id>`.
  Local storage keys and bare HTTP URLs are invalid at the ontology layer.
- **`schemaId`:** omitted on purpose in proposal files. Ontology publication
  requires MetaState to insert the assigned W3ID before deploy.

## Out of scope for this proposal (intentionally)

- Enabling `W3DS_ONTOLOGY_ADAPTER_ENABLED`
- Inventing or guessing schema IDs
- eVault MetaEnvelope writes, `uploadFile` / `w3ds://file` generation
- Awareness webhooks, ACL API calls, deployment, authentication changes

## Local validation

Contract tests under `apps/web/src/server/w3ds-ontology-proposal.contract.test.ts`
validate each schema and the checked-in examples with Ajv (draft-07). They assert
that proposal schemas do **not** carry a made-up `schemaId`.

## Submission checklist for maintainers

1. Review `schemas/*.schema.json` field names against Mapping Rules property
   naming (Envelope `ontology` = property name).
2. Assign four new W3ID `schemaId` values; do not reuse SocialMediaPost/File IDs.
3. Insert `"schemaId": "<assigned-w3id>"` into each published schema file.
4. Deploy Ontology so `/schemas` lists Video, Channel, Playlist, and Comment.
5. Return the four IDs (and confirm base URL) to Vidak operators.
6. Vidak configures `W3DS_ONTOLOGY_SCHEMA_ID_*`, fills mapping `schemaId` slots
   from `mapping-contract.md`, then may enable the adapter.
