# Vidak private Ontology catalogue (platform-local)

**Status:** implemented read-only catalogue inside `apps/web`  
**Ownership:** `private` / `vidak_private` / Vidak-owned  
**Compatibility:** W3DS Ontology *read* API shape only (`GET /schemas`, `GET /schemas/:id`)  
**Not:** MetaState Ontology, MetaState-issued W3IDs, or canonical public W3DS schemas

## Why this exists

Live MetaState Ontology does not publish Video, Channel, Playlist, or Comment
schemas, and there is no documented public schema-submission route. Vidak
therefore hosts a **private, versioned catalogue** for its own platform use so
adapters and validators can resolve stable schema IDs without pretending those
IDs came from MetaState.

This catalogue **replaces the external Ontology dependency for Vidak platform
use only**. It does not make Vidak a public Ontology authority for other
platforms.

## Stable Vidak-owned schema IDs (immutable)

| Title | schemaId |
| --- | --- |
| Video | `vidak:private:ontology:v1:video` |
| Channel | `vidak:private:ontology:v1:channel` |
| Playlist | `vidak:private:ontology:v1:playlist` |
| Comment | `vidak:private:ontology:v1:comment` |

These IDs are intentionally **not** UUID W3IDs. Do not present them as
MetaState-issued or as canonical public W3DS Ontology IDs.

## Route contract

Base path: `/api/w3ds/ontology`

### `GET /api/w3ds/ontology/schemas`

- **Auth:** none (public read-only)
- **200:** JSON object with `ownership: "vidak_private"`, `visibility: "private"`,
  catalogue metadata, and `schemas: [{ id, title, ownership, ... }, ...]`
- **Headers:** `Content-Type: application/json`,
  `Cache-Control: public, max-age=300, stale-while-revalidate=86400`,
  `X-Vidak-Ontology-Ownership: vidak_private`,
  `X-Vidak-Ontology-Visibility: private`
- **Writes:** none — there is no register/create endpoint

W3DS-compatible projection of each entry still exposes `id` + `title`.

### `GET /api/w3ds/ontology/schemas/[schemaId]`

- **Auth:** none (public read-only)
- **200:** draft-07 JSON Schema including `schemaId`, `title`, `ownerEName`,
  references, lifecycle/visibility fields, and `w3ds://file` URI patterns,
  plus private ownership labels
- **400:** empty/invalid path parameter (`invalid_schema_id`)
- **404:** unknown id (`schema_not_found`) — including MetaState-looking UUIDs
- **Cache:** same as list on 200; `no-store` on errors

## Configuration

```bash
# Default / recommended for Vidak platform-local catalogue consumption.
# metastate_official stays disabled unless set explicitly.
W3DS_ONTOLOGY_MODE=vidak_private

# Optional: enable adapter mappings against the private catalogue.
# Keep false until mapping sync is intentionally activated.
# W3DS_ONTOLOGY_ADAPTER_ENABLED=false
# W3DS_ONTOLOGY_BASE_URL=https://<vidak-host>/api/w3ds/ontology
# W3DS_ONTOLOGY_SCHEMA_ID_PROFILE=<configured-profile-schema-id>
# Video/Channel/Playlist/Comment IDs default to the Vidak private IDs above
# when W3DS_ONTOLOGY_MODE=vidak_private.

# Explicit MetaState official catalogue (disabled by default).
# W3DS_ONTOLOGY_MODE=metastate_official
# W3DS_ONTOLOGY_ADAPTER_ENABLED=true
# W3DS_ONTOLOGY_BASE_URL=https://ontology.w3ds.metastate.foundation
# W3DS_ONTOLOGY_SCHEMA_ID_* must be MetaState-assigned IDs (not vidak:private:*)
```

Activate private mode with:

```bash
W3DS_ONTOLOGY_MODE=vidak_private
```

(or omit `W3DS_ONTOLOGY_MODE` — default is `vidak_private`).

## Interoperability limitations (explicit)

1. **Not canonical W3DS Ontology.** Other W3DS platforms and MetaState services
   will not recognize `vidak:private:ontology:v1:*` as public schema IDs.
2. **No cross-platform MetaEnvelope portability** for these four types until
   MetaState assigns and publishes official W3IDs.
3. **No schema registration API.** Catalogue is static files in the repository;
   updates require a versioned code change, not a runtime POST.
4. **Private catalogue ≠ official ACL / Awareness / eVault federation.** Hosting
   schemas locally does not grant MetaState network write authority.
5. **Proposal package remains separate.** `docs/proposals/w3ds-ontology-vidak-v1/`
   still omits `schemaId` for any future MetaState submission; this private
   catalogue is the Vidak-owned runtime source of truth for platform-local use.
6. **`metastate_official` is opt-in** and rejects Vidak private IDs so the two
   modes cannot be silently mixed.

## Source layout

| Path | Purpose |
| --- | --- |
| `apps/web/src/server/w3ds-private-ontology/schemas/*.schema.json` | Versioned draft-07 documents with Vidak `schemaId` |
| `apps/web/src/server/w3ds-private-ontology/` | Catalogue service + immutable ID constants |
| `apps/web/src/app/api/w3ds/ontology/schemas/` | Next.js route handlers |
| `docs/architecture/w3ds-private-ontology.md` | This boundary document |
