# Vidak Web3 Adapter mapping contract (future)

**Status:** documentation only — not loaded by the runtime adapter  
**Proposal:** `w3ds-ontology-vidak-v1`  
**Depends on:** MetaState-assigned `schemaId` values published in Ontology

These Mapping Rules sketches show the intended `ownerEnamePath` and
`localToUniversalMap` once catalogue IDs exist. Every `schemaId` slot below is
an explicit placeholder string, **not** a W3ID. Do not copy the placeholder into
env vars or production mapping JSON.

Table names match `W3DS_ADAPTER_ENTITY_TABLES` in
`apps/web/src/server/w3ds-adapter-mapping.ts`.

---

## Video → `videos`

```json
{
  "tableName": "videos",
  "schemaId": "<ASSIGNED_BY_METASTATE:Video>",
  "ownerEnamePath": "w3ds_platform_users(ownerId.eName)",
  "localToUniversalMap": {
    "id": "id",
    "ownerEName": "w3ds_platform_users(ownerId.eName),ownerEName",
    "channelId": "creator_channels(channelId.id),channelId",
    "title": "title",
    "description": "description",
    "status": "status",
    "visibility": "visibility",
    "durationSeconds": "durationSeconds",
    "mediaFileUri": "__file(mediaFileUri),mediaFileUri",
    "thumbnailUrl": "__file(thumbnailUrl),thumbnailFileUri",
    "category": "category",
    "language": "language",
    "tags": "tags",
    "publicVideoId": "publicVideoId",
    "publishedAt": "__date(publishedAt)",
    "createdAt": "__date(createdAt)",
    "updatedAt": "__date(updatedAt)",
    "viewCount": "viewCount",
    "likeCount": "likeCount",
    "commentCount": "commentCount"
  }
}
```

Notes:

- `mediaFileUri` is designed for a future `w3ds://file` value. Values that are
  already `w3ds://file` URIs pass through `__file` unchanged; local upload
  payloads are not generated in this proposal phase.
- Product `thumbnailUrl` maps to ontology `thumbnailFileUri` via `__file`.
- Local `storage_key` on `media_assets` remains platform-private and is **not**
  mapped.

---

## Channel → `creator_channels`

```json
{
  "tableName": "creator_channels",
  "schemaId": "<ASSIGNED_BY_METASTATE:Channel>",
  "ownerEnamePath": "w3ds_platform_users(ownerId.eName)",
  "localToUniversalMap": {
    "id": "id",
    "ownerEName": "w3ds_platform_users(ownerId.eName),ownerEName",
    "handle": "handle",
    "name": "name",
    "description": "description",
    "avatarUrl": "__file(avatarUrl),avatarFileUri",
    "bannerUrl": "__file(bannerUrl),bannerFileUri",
    "subscriberCount": "subscriberCount",
    "videoCount": "videoCount",
    "createdAt": "__date(createdAt)",
    "updatedAt": "__date(updatedAt)"
  }
}
```

Ownership decision for this proposal: channel MetaEnvelopes live in the
**creator** eVault (`ownerEnamePath` → owner user eName), not a separate Group
eVault.

---

## Playlist → `playlists`

```json
{
  "tableName": "playlists",
  "schemaId": "<ASSIGNED_BY_METASTATE:Playlist>",
  "ownerEnamePath": "w3ds_platform_users(ownerId.eName)",
  "localToUniversalMap": {
    "id": "id",
    "ownerEName": "w3ds_platform_users(ownerId.eName),ownerEName",
    "channelId": "creator_channels(channelId.id),channelId",
    "title": "title",
    "description": "description",
    "visibility": "visibility",
    "thumbnailUrl": "__file(thumbnailUrl),thumbnailFileUri",
    "items": "items",
    "createdAt": "__date(createdAt)",
    "updatedAt": "__date(updatedAt)"
  }
}
```

`items[].videoId` must resolve to Video MetaEnvelope ids after ID mapping exists.
The local `playlists` table is reserved until the product table ships.

---

## Comment → `comments`

```json
{
  "tableName": "comments",
  "schemaId": "<ASSIGNED_BY_METASTATE:Comment>",
  "ownerEnamePath": "w3ds_platform_users(authorId.eName)",
  "localToUniversalMap": {
    "id": "id",
    "ownerEName": "w3ds_platform_users(authorId.eName),ownerEName",
    "videoId": "videos(videoId.id),videoId",
    "parentId": "comments(parentId.id),parentId",
    "body": "body",
    "visibility": "visibility",
    "createdAt": "__date(createdAt)",
    "updatedAt": "__date(updatedAt)",
    "likeCount": "likeCount",
    "replyCount": "replyCount"
  }
}
```

Viewer-only fields (`viewerReaction`, dislike UX) stay platform-local and are
omitted from the universal map.

---

## Enabling sequence (after MetaState publishes)

1. Confirm each title appears on `GET /schemas` with the assigned id.
2. Set `W3DS_ONTOLOGY_BASE_URL` and every `W3DS_ONTOLOGY_SCHEMA_ID_*`.
3. Replace `<ASSIGNED_BY_METASTATE:…>` placeholders with those IDs in runtime
   mapping JSON (not committed until IDs are real).
4. Only then set `W3DS_ONTOLOGY_ADAPTER_ENABLED=true`.
