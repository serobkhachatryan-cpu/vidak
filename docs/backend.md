# Backend

## Current state

Platform backend capabilities are hosted as Next.js route handlers in
`apps/web`. W3DS authentication persists platform users, login offers, and
sessions in PostgreSQL through Drizzle ORM. Authenticated creators can also
persist local creator channels and video draft metadata on that store.

There is still no media storage, queue worker, video-processing pipeline,
eVault sync, ACL layer, or public publish path.

```mermaid
flowchart LR
  Clients["Next.js applications"] --> Auth["apps/web API routes\nW3DS auth + drafts"]
  Auth --> DB["PostgreSQL\nusers / sessions / channels / drafts"]
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
5. Draft rows always use product `status: "draft"`. Publishing is intentionally
   unavailable in this milestone.

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

This milestone does **not** implement:

- File upload, blob/object storage, or `w3ds://file` references
- Transcoding / processing pipelines
- eVault writes, ontology mapping, ACLs, or Awareness
- Marking a draft as published / public feed ingestion
- Changes to unrelated watch, channel, search, or public feed behavior
- Changes to the development provider's mock `createVideo` / `publishVideo`
  semantics

## Persistence model

Server-only tables (Drizzle schema in `apps/web/src/server/db/schema.ts`):

| Table | Purpose |
| --- | --- |
| `w3ds_platform_users` | Platform users unique by `e_name`, with eVault metadata and product profile projection. |
| `w3ds_login_offers` | One-time login offers with expiry, status (`pending` / `verifying` / `completed` / `expired` / `failed`), and failure codes. |
| `w3ds_platform_sessions` | Platform sessions with user id, access/refresh `jti` identifiers, expiry timestamps, and revocation. |
| `creator_channels` | Local creator channel per platform user (`owner_id` unique); product `Channel` projection. |
| `videos` | Creator video drafts (`status = draft`) with title, description, visibility, tags, language/category, and timestamps. |

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
   deploying application instances that speak W3DS auth / drafts.
4. Prefer multiple Node instances behind a load balancer; session/offer/draft
   state is shared through PostgreSQL, so process-local maps must not be
   reintroduced.
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
- Drizzle migrations under `apps/web/drizzle/` version the W3DS auth and
  creator-draft schema.

When additional backend domains are introduced, document their API versioning,
authorization model, persistence strategy, storage lifecycle, observability,
and operational runbooks alongside the implementation.
