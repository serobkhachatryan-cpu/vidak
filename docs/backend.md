# Backend

## Current state

Platform backend capabilities are hosted as Next.js route handlers in
`apps/web`. W3DS authentication persists platform users, login offers, and
sessions in PostgreSQL through Drizzle ORM. Authenticated creators can also
persist local creator channels, video draft/published metadata, and private
media assets on that store. The durable video model supports an explicit
draft ↔ published lifecycle with visibility and publishing metadata; public
discovery routes and public playback URLs are not exposed yet.

There is still no queue worker, video-processing pipeline, eVault sync, ACL
layer, or public discovery/playback path.

```mermaid
flowchart LR
  Clients["Next.js applications"] --> Auth["apps/web API routes\nW3DS auth + drafts + media"]
  Auth --> DB["PostgreSQL\nusers / sessions / channels / drafts / media_assets"]
  Auth --> Disk["LocalDiskMediaStorage\ndevelopment blobs"]
  Auth --> Platform["Registry + eVault\nserver-side verification"]
  Contracts["@w3ds/auth<br/>contracts and browser storage"] -. client-only boundary .-> Platform
  API["@w3ds/api-client<br/>mock + W3DS cookie clients"] -. client-only boundary .-> Platform
  SDK["@w3ds/sdk<br/>empty export"] -. reserved boundary .-> Platform
  Player["@w3ds/player<br/>empty export"] -. reserved boundary .-> Platform
```

## W3DS authentication backend

`apps/web` exposes these Node.js route handlers:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/offer` | Create a one-time, five-minute `w3ds://auth` login offer. |
| `POST` | `/api/auth/callback` | Receive the wallet callback and verify its signature server-side. |
| `GET` | `/api/auth/offer/:offerId/status` | Let the same-origin SPA poll for login completion. |
| `GET` | `/api/auth/session` | Restore an authenticated platform session. |
| `GET` | `/api/auth/me` | Read the current platform user. |
| `POST` | `/api/auth/refresh` | Rotate an HTTP-only refresh session. |
| `POST` | `/api/auth/logout` | Revoke a platform session and clear cookies. |
| `PATCH` | `/api/auth/profile` | Update the authenticated user's local platform profile. |
| `GET` | `/api/auth/sessions` | List the authenticated user's active platform sessions. |
| `DELETE` | `/api/auth/sessions/:sessionId` | Revoke one of the authenticated user's non-current sessions. |

The backend resolves the W3ID in Registry, loads key-binding certificates from
the resolved eVault's `/whois` endpoint, verifies the Registry-signed ES256
certificates, and verifies the eID wallet's ECDSA P-256 signature over the
one-time session ID. The browser never contacts those protocol services or
receives their certificates or public-key material.

The platform issues signed access and refresh JWTs. Both are set as `HttpOnly`,
`SameSite=Lax` cookies; the access credential has a 15-minute lifetime and the
refresh credential rotates with a seven-day lifetime. `Authorization: Bearer`
access tokens are accepted for server-to-server/API clients. Raw JWTs are never
stored in the database — only session rows and token identifiers (`jti`) used
for validation and rotation.

Protected account routes require a valid cookie or bearer access session. Profile
updates accept only local product fields (`displayName`, optional `avatarUrl`) and
reject anonymous callers with `401`. Session listing returns browser-safe device
session projections for the caller only. Session revocation is scoped to the
caller's own sessions and rejects attempts to revoke the current session with the
typed `invalid_session` error. Email, password, and account-deletion mutations are
not exposed in W3DS mode.

Configure the flow with the root `.env.example` values:

- `DATABASE_URL` (required for W3DS mode; unused by `AUTH_PROVIDER=dev`)
- `W3DS_REGISTRY_BASE_URL`
- `W3DS_AUTH_JWT_SECRET` (32+ secret characters)
- `W3DS_AUTH_PLATFORM_NAME` (optional; defaults to `vidak`)
- `W3DS_AUTH_MIN_WALLET_VERSION` (optional temporary compatibility gate)
- `MEDIA_STORAGE_ROOT` (optional; local-disk MediaStorage root, defaults to `.data/media`)
- `MEDIA_MAX_UPLOAD_BYTES` (optional; raw upload body limit, defaults to `104857600` / 100 MiB)
- `MEDIA_ALLOWED_CONTENT_TYPES` (optional; comma-separated MIME allowlist, defaults to `video/mp4,video/webm,video/quicktime`)

If W3DS auth is enabled without `DATABASE_URL`, route handlers return a clear
`configuration_error` (HTTP 503). Development email/password auth does not use
PostgreSQL and remains unaffected.

## Creator video drafts

Authenticated W3DS users can persist editable video draft metadata owned by a
local creator channel. Product responses reuse the existing `Video` and
`Channel` shapes from `@w3ds/types` — there is no parallel protocol-shaped model.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/videos/drafts` | Create a draft for the authenticated user (auto-provisions their channel). |
| `GET` | `/api/videos/drafts` | List the authenticated user's own drafts. |
| `GET` | `/api/videos/drafts/:videoId` | Read one owned draft. |
| `PATCH` | `/api/videos/drafts/:videoId` | Update owned draft metadata. |
| `DELETE` | `/api/videos/drafts/:videoId` | Delete one owned draft. |

### Ownership model

1. Every draft route requires a durable W3DS access session (cookie or bearer).
2. Anonymous requests return `401` (`invalid_session`).
3. On first draft write, the service idempotently finds or creates one local
   creator channel for the authenticated platform user (`owner_id` unique).
4. Drafts are scoped to that owner/channel. Cross-user reads, updates, and
   deletes return `404` (`not_found`) so resource existence is not disclosed.
5. Draft routes only operate on `status: "draft"` rows. Publish/unpublish is a
   separate store/domain lifecycle (see below); public HTTP routes for that
   lifecycle are not exposed in this phase.

`CreatorVideoService` depends on a `CreatorVideoStore` interface:

- **Production / runtime:** `PostgresCreatorVideoStore` via `DATABASE_URL`
- **Unit tests only:** `InMemoryCreatorVideoStore` injected explicitly — never
  used as a production fallback

Session validation reuses the existing W3DS auth helpers (`getBearerToken`,
access cookie, `W3dsAuthService.getSession`). Route handlers do not duplicate
cookie/bearer parsing or write ad-hoc SQL.

### Client wiring

- `AUTH_PROVIDER=w3ds` selects `W3dsVideoApiClient`, a same-origin cookie client
  (`credentials: 'include'`) for draft CRUD. It never reads or stores tokens in
  the browser.
- `AUTH_PROVIDER=dev` keeps `MockVideoApiClient` unchanged for development.
- The upload UI saves editable draft metadata only and labels the result as a
  draft that is not published.

### Non-goals (explicit)

Draft metadata routes do **not** implement:

- Multipart `formData()` upload parsing that buffers whole files
- Public playback URLs or `w3ds://file` protocol references
- Transcoding / processing pipelines
- eVault writes, ontology mapping, ACLs, or Awareness
- Public discovery / watch routes keyed by `publicVideoId`
- Creator UI publish controls or Next.js publish HTTP endpoints
- Changes to unrelated watch, channel, search, or public feed behavior
- Changes to the development provider's mock `createVideo` / `publishVideo`
  semantics

Private media bytes are transferred through the dedicated media routes below.

## Video publishing lifecycle (store / domain)

The persisted `videos` model has an explicit product lifecycle and a separate
visibility field. Publishing metadata is durable; public routes that would
consume it are intentionally deferred.

### Lifecycle states

| `status` | Meaning |
| --- | --- |
| `draft` | Editable owner-only working copy. Draft CRUD and media upload attach here. |
| `published` | Owner has published the video. Draft CRUD no longer targets the row; media rows and ownership remain intact. |

`processing` and `archived` remain in the product `VideoStatus` union for later
phases and are rejected by publish/unpublish transitions today
(`invalid_transition` / 409).

### Visibility (independent of lifecycle)

Reuse the existing `visibility` column — do not introduce a second competing
field:

| `visibility` | Meaning |
| --- | --- |
| `private` | Owner-intended private access only. |
| `unlisted` | Reachable by opaque link later; not listed in public discovery. |
| `public` | Intended for public discovery once public routes exist. |

Publish and unpublish **do not** change visibility. A published video may remain
`private` or `unlisted`.

### Publishing metadata

| Field | Meaning |
| --- | --- |
| `published_at` / `publishedAt` | Timestamp of the current publication. Set on transition into `published`; cleared on unpublish. |
| `public_video_id` / `publicVideoId` | Opaque, stable public identifier (`pub_<id>`). Assigned on first publish; unique when set; **preserved** across unpublish/republish for later public routes. |

### Store / domain transitions

`CreatorVideoStore` / `CreatorVideoService` expose:

- `publishOwnedVideo` / `publishVideo`
- `unpublishOwnedVideo` / `unpublishVideo`

Rules:

1. **Ownership** — only the owning platform user may publish or unpublish.
   Missing or cross-user ids return `not_found` / 404 (no existence disclosure).
2. **Ready media precondition** — publish succeeds only when the video has at
   least one attached `media_assets` row with `upload_state = ready`. Otherwise
   `precondition_failed` / 409. The PostgreSQL path checks this inside the same
   transaction as the status update.
3. **Publish** (`draft` → `published`) — sets `status`, `publishedAt` (if unset
   for this publication), and `publicVideoId` (if never assigned). Preserves
   ownership, `createdAt`, visibility, tags/metadata, and media links.
4. **Unpublish** (`published` → `draft`) — sets `status` back to `draft` and
   clears `publishedAt`. Preserves `publicVideoId`, ownership, visibility, and
   media integrity.
5. **Idempotency** —
   - Publish on an already-published owned video returns the existing row
     unchanged (same `publishedAt` and `publicVideoId`).
   - Unpublish on an already-draft owned video returns the existing row
     unchanged.
6. **Integrity** — publish/unpublish never reassign `owner_id` / `channel_id`,
   never rewrite media asset rows, and never invent a second visibility field.

No Next.js publish/unpublish route, public watch path, or feed ingestion is
wired in this phase.

## Media asset storage and protected transfer routes

Server-only durable media metadata, a private blob adapter, and authenticated
transfer routes let creators upload, inspect, download, and delete media for
their own video drafts. Bytes never leave private storage as public URLs.

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/videos/drafts/:videoId/media` | Stream-upload a raw media body into an owned draft. |
| `GET` | `/api/videos/drafts/:videoId/media/:assetId` | Read owned asset metadata (no storage key / path). |
| `GET` | `/api/videos/drafts/:videoId/media/:assetId/content` | Stream owned asset bytes from private storage. |
| `DELETE` | `/api/videos/drafts/:videoId/media/:assetId` | Delete the owned asset row and private blob. |

Every route requires a durable W3DS access session via `Authorization: Bearer`
or the `w3ds_access` HttpOnly cookie (same helper as auth/draft routes).

### Upload contract (`POST …/media`)

Raw body upload — **not** multipart. Request headers:

| Header | Required | Rules |
| --- | --- | --- |
| `Content-Type` | yes | Must be in the allowlist (default `video/mp4`, `video/webm`, `video/quicktime`). Parameters after `;` are ignored. |
| `Content-Length` | yes | Non-negative integer. Rejected when greater than `MEDIA_MAX_UPLOAD_BYTES` (default 100 MiB). |
| `X-Original-Filename` | yes | Client filename metadata. Path segments are stripped; max 512 characters. |
| Body | yes | Raw media bytes streamed by the server (never fully buffered via `formData()`). |

Successful response: `201` with public asset JSON:

```json
{
  "id": "…",
  "ownerId": "…",
  "videoId": "…",
  "originalFilename": "clip.mp4",
  "contentType": "video/mp4",
  "byteSize": 1234,
  "uploadState": "ready",
  "createdAt": "…",
  "updatedAt": "…"
}
```

Responses never include `storageKey`, filesystem paths, or public playback URLs.

Atomic create lifecycle:

1. Authenticate and validate draft ownership, content type, and declared size.
2. Create an `uploading` `media_assets` row with an opaque storage key.
3. Stream body bytes into private temporary storage, enforcing max size and
   `Content-Length` while reading chunks.
4. Finalize (promote temp → durable object) and mark the asset `ready`.
5. On any failure: abort temporary storage, delete any final object, and remove
   the incomplete database row.

### Metadata / download / delete

- `GET …/media/:assetId` returns the public asset projection above (`200`).
- `GET …/media/:assetId/content` streams bytes with:
  - `Content-Type` from the asset
  - `Content-Length` from the asset
  - `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`
  - `Cache-Control: private, no-store`
  - `X-Content-Type-Options: nosniff`
  - Only `uploadState: ready` assets are downloadable; otherwise `404`.
- `DELETE …/media/:assetId` removes the database row then best-effort deletes
  the private blob (`204`). Storage cleanup failures do not resurrect the row.

### Error responses

All errors use `{ "error": { "code", "message" } }`:

| Status | Code | When |
| --- | --- | --- |
| `401` | `invalid_session` | Missing/invalid cookie or bearer session. |
| `404` | `not_found` | Missing draft/asset, cross-user access, or not-ready download. |
| `400` | `validation_failed` | Missing/invalid headers, size mismatch vs `Content-Length`. |
| `413` | `payload_too_large` | Declared or streamed size exceeds limit / `Content-Length`. |
| `415` | `unsupported_media_type` | `Content-Type` outside the allowlist. |
| `500` | `internal_error` | Unexpected storage/stream failure (failed uploads are cleaned up). |

### Private-access guarantees

1. Anonymous callers receive `401`; cross-user callers receive `404` (no
   existence disclosure).
2. Ownership is checked before any storage read or write.
3. Clients never receive storage keys, absolute filesystem paths, signed URLs,
   or public CDN/playback URLs from these routes.
4. Downloads are authenticated streams from private MediaStorage only.

### `media_assets` model

| Column | Purpose |
| --- | --- |
| `id` | Opaque asset identifier. |
| `owner_id` | Platform user that owns the asset (FK → `w3ds_platform_users`). |
| `video_id` | Creator video draft the asset belongs to (FK → `videos`, `ON DELETE CASCADE`). |
| `storage_key` | Opaque MediaStorage object key (unique). Never a user-supplied path; never returned on the wire. |
| `original_filename` | Client-provided filename retained as metadata only. |
| `content_type` | MIME type metadata. |
| `byte_size` | Declared object size in bytes (non-negative integer). |
| `upload_state` | Lifecycle: `pending` → `uploading` → `ready` / `failed`. |
| `created_at` / `updated_at` | Timestamps with time zone. |

Ownership is enforced at the store and service layers:

1. `createAsset` succeeds only when `video_id` is a draft owned by the same
   `owner_id`.
2. Reads, state updates, and deletes are scoped by `(asset_id, owner_id)`.
3. Cross-user access returns “not found” rather than disclosing existence.
4. Deleting a draft cascades media asset rows in PostgreSQL.

`MediaAssetStore` mirrors the draft store split:

- **Production / runtime:** `PostgresMediaAssetStore` via `DATABASE_URL`
- **Unit tests only:** `InMemoryMediaAssetStore` injected explicitly — never
  used as a production fallback

`MediaAssetService` (`getMediaAssetService()`) composes the store with
`LocalDiskMediaStorage` and the configured upload limits for route handlers.

### `MediaStorage` contract

```ts
interface MediaStorage {
  createStorageKey(): string;
  write(storageKey: string, data: Uint8Array): Promise<void>;
  read(storageKey: string): Promise<Uint8Array>;
  openUpload(): Promise<MediaUploadSession>; // temp write → finalize/abort
  openReadStream(storageKey: string): Promise<ReadableStream<Uint8Array>>;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
}
```

Rules:

- Storage keys are opaque (`media_<uuid>`). Path separators, `..`, and other
  traversal forms are rejected before any filesystem resolve.
- `LocalDiskMediaStorage` is the development implementation: final objects are
  flat files under a private root (`MEDIA_STORAGE_ROOT`, or `.data/media`), and
  in-flight uploads stage under a private `.uploads/` directory before finalize.
- Object bytes are never stored in PostgreSQL; only metadata and the opaque key
  are durable in `media_assets`.
- Callers that delete an asset row should also `MediaStorage.delete` the
  returned `storageKey` so orphaned blobs are cleaned up.

This layer intentionally stops short of multipart buffering, signed/public URLs,
transcoding, and eVault file envelopes.

### Browser client upload contract

`@w3ds/api-client` (`W3dsVideoApiClient`) talks to these routes with
same-origin `credentials: 'include'` (HttpOnly session cookie). The browser
never receives W3DS tokens, storage keys, filesystem paths, or public media
URLs.

| Client method | Route | Notes |
| --- | --- | --- |
| `uploadDraftMedia(videoId, file, options)` | `POST …/media` | Raw `Blob` body + `Content-Type` / `X-Original-Filename`. Progress via XHR `upload.onprogress`. `Content-Length` is set by the browser. |
| `getDraftMedia(videoId, assetId)` | `GET …/media/:assetId` | Public asset JSON only. |
| `deleteDraftMedia(videoId, assetId)` | `DELETE …/media/:assetId` | `204` on success. |
| `draftMediaContentPath(videoId, assetId)` | path helper | Same-origin authenticated content path for private preview (`<video src>`), not a public URL. |

Creator upload UI (`@w3ds/upload-page`) persists a draft before media transfer,
shows idle / validating / uploading / complete / failed / cancelled states,
displays attached asset metadata, and removes assets through `deleteDraftMedia`.
Development auth keeps `MockVideoApiClient` simulated uploads.

## Persistence model

Server-only tables (Drizzle schema in `apps/web/src/server/db/schema.ts`):

| Table | Purpose |
| --- | --- |
| `w3ds_platform_users` | Platform users unique by `e_name`, with eVault metadata and product profile projection. |
| `w3ds_login_offers` | One-time login offers with expiry, status (`pending` / `verifying` / `completed` / `expired` / `failed`), and failure codes. |
| `w3ds_platform_sessions` | Platform sessions with user id, access/refresh `jti` identifiers, expiry timestamps, and revocation. |
| `creator_channels` | Local creator channel per platform user (`owner_id` unique); product `Channel` projection. |
| `videos` | Creator videos with draft/published lifecycle, visibility, publishing metadata (`published_at`, unique `public_video_id`), title/description/tags, and timestamps. |
| `media_assets` | Durable media metadata for video-owned blobs (opaque storage key, content type, size, upload state). |

`W3dsAuthService` depends on a `W3dsAuthStore` interface:

- **Production / runtime:** `PostgresW3dsAuthStore` via `DATABASE_URL`
- **Unit tests only:** `InMemoryW3dsAuthStore` injected explicitly — never used as a production fallback

Offer consumption is concurrency-safe: claiming a pending offer for verification
is atomic (`SELECT … FOR UPDATE` then status transition), so an offer completes
at most once across multiple application instances. Refresh rotation updates
token identifiers in place and rejects reused refresh credentials. Offer and
session expiry are enforced by normal store reads/updates; there is no separate
background cleanup job required for correctness.

Database credentials, Registry/eVault traffic, raw JWTs, and table rows stay on
the server. Browser responses continue to use cookie-only W3DS sessions and
browser-safe session projections from `@w3ds/auth`.

## Migration workflow

Migrations live in `apps/web/drizzle/` and are managed with Drizzle Kit.

```bash
# After schema changes
pnpm db:generate

# Apply migrations to the database in DATABASE_URL
pnpm db:migrate
```

Local PostgreSQL (optional Compose profile):

```bash
docker compose --profile postgres up -d postgres
# DATABASE_URL=postgresql://vidak:vidak@127.0.0.1:5432/vidak
pnpm db:migrate
```

Package scripts:

| Script | Package | Action |
| --- | --- | --- |
| `db:generate` | root / `@w3ds/web` | Generate SQL from the Drizzle schema |
| `db:migrate` | root / `@w3ds/web` | Apply migrations with `drizzle-orm` migrator |

## Production operational requirements

1. Provision a shared PostgreSQL database reachable by every W3DS app instance.
2. Set `DATABASE_URL`, `W3DS_REGISTRY_BASE_URL`, and `W3DS_AUTH_JWT_SECRET` in the
   server environment only — never `NEXT_PUBLIC_*` for these values.
3. Run `pnpm db:migrate` (or the equivalent release job) before or as part of
   deploying application instances that speak W3DS auth / drafts / media assets.
4. Prefer multiple Node instances behind a load balancer; session/offer/draft
   and media-asset metadata is shared through PostgreSQL, so process-local maps
   must not be reintroduced. Local-disk MediaStorage is for development only.
5. Rotate `W3DS_AUTH_JWT_SECRET` only with a planned invalidation of existing
   sessions (changing the secret invalidates outstanding JWTs).
6. Keep Registry and eVault base URLs server-side; do not expose them to the
   browser bundle.
7. Monitor auth configuration failures (`configuration_error` / 503) separately
   from client credential failures (`invalid_session` / 401).

## Other server-side behavior

The applications can be built and served by Next.js. This is the only current
server runtime:

- Each app exposes the standard `next dev`, `next build`, and `next start`
  scripts.
- The Dockerfile builds one selected application and runs its standalone
  Next.js server.
- The included Compose configuration builds and exposes the `web` application
  on port 3000 with `NODE_ENV=production`, and optionally starts PostgreSQL via
  the `postgres` profile.

## Package boundaries

The monorepo already reserves packages that can host future backend-facing
concerns:

| Package | Current implementation |
| --- | --- |
| `@w3ds/auth` | Authentication contracts, role helpers, and browser token-storage adapters. |
| `@w3ds/api-client` | Typed mock clients plus W3DS cookie clients for auth and video drafts. |
| `@w3ds/sdk` | Empty module. |
| `@w3ds/player` | Empty module. |
| `@w3ds/types` | Product domain types including `Video`, `Channel`, and draft inputs. |
| `@w3ds/utils` | Exports a generic `identity` helper only. |
| `@w3ds/config` | Exports the `platformName` constant only. |

These boundaries should be treated as ownership locations, not public APIs or
service contracts.

## Delivery and verification

Backend-oriented infrastructure is limited to the repository tooling:

- GitHub Actions validates pull requests and pushes to `main` with lint,
  typecheck, unit tests, build, Storybook build, and browser tests.
- Docker supports production builds for a selected app through the `APP` build
  argument.
- pnpm workspaces and Turborepo manage dependency ordering and task execution.
- Drizzle migrations under `apps/web/drizzle/` version the W3DS auth,
  creator-video (including publish lifecycle), and media-asset schema.

When additional backend domains are introduced, document their API versioning,
authorization model, persistence strategy, storage lifecycle, observability,
and operational runbooks alongside the implementation.
