# W3DS Resource Authorization

**Status:** Phase 2 — durable authorization sync (fail-closed without official SDK)  
**Date:** 2026-08-04  
**Scope:** Server-only authorization model + durable grant/revoke/reconcile sync layer  
**Non-goals:** Route/UI wiring, automatic background workers, share-management UI, fabricated eVault HTTP

---

## 1. Purpose

Vidak authenticates users through W3DS (`w3ds://auth`) and enforces local
ownership plus product visibility on video/media routes. Authorization is split
into:

1. **Phase 1 foundation** — provider-neutral resource/subject/scope model and
   local policy evaluation
2. **Phase 2 sync layer** — durable, retryable ownership/grant synchronization
   through an official W3DS authorization/ACL client boundary

Phase 2 persists sync intent and can drive remote mutations **only** via
officially supported SDK methods. This repository does **not** currently install
those methods, so production remains fail-closed for remote sync.

---

## 2. Model (Phase 1)

### Subject (canonical identity)

| Field | Source | Role |
| --- | --- | --- |
| `platformUserId` | `AuthUser.id` / JWT `sub` | Local ownership key |
| `eName` | Verified W3ID (`@…`) | Global identity for grants |
| `eVaultId` | Registry-resolved vault id | Ownership / ACL binding |

**Not subjects:** email, display name, browser storage keys, client-supplied ids.

### Resource

| Kind | Local row | Opaque id |
| --- | --- | --- |
| `creator_video` | `videos.id` | `vra_1_v_<digest>_<encodedLocalId>` |
| `media_asset` | `media_assets.id` | `vra_1_m_<digest>_<encodedLocalId>` |

Opaque `resourceId` values are the stable keys used by the sync layer.

### Access scopes

| Scope | Meaning |
| --- | --- |
| `video:owner` | Owner draft/publish/unpublish mutations |
| `video:read` | Read video metadata |
| `video:discover` | Appear in anonymous discovery listing |
| `media:owner` | Owner media upload/download/delete |
| `media:read` | Stream/download media |

Scopes are product vocabulary — not raw eVault ACL arrays.

Local policy still mirrors current ownership and public/unlisted/private rules.
`authorize()` does not perform remote ACL evaluation.

---

## 3. Durable synchronization (Phase 2)

### Official client boundary

`W3dsAuthorizationOfficialClient` is the only allowed remote mutation surface:

- `ensureResourceOwner`
- `grantAccess`
- `revokeAccess`
- optional `listAccessGrants` (reconcile read-back)

Implementations may wrap installed SDK methods only. Raw GraphQL/HTTP ACL calls
are not permitted.

`resolveW3dsAuthorizationOfficialClient()` currently returns **unavailable**
because:

1. `@w3ds/sdk` is an empty module with no authorization/ACL API
2. No installed dependency documents a supported authorization-mutation client
3. Remote mutation credentials beyond existing W3DS auth gates are therefore
   undefined

Exact gap strings live in `W3DS_AUTHORIZATION_SDK_GAPS` and are surfaced by
config diagnostics and `sdk_unavailable` errors.

### Sync service operations

`W3dsAuthorizationSyncService` supports:

| Operation | Behavior |
| --- | --- |
| `grant` | Persist intent=`grant`, ensure owner, grant scope; idempotent |
| `revoke` | Persist intent=`revoke`, revoke remote access; idempotent; retries never restore access |
| `reconcile` | Ensure owner, grant intended entries, revoke previously tracked grants omitted from the intended set |

All operations fail closed when:

- W3DS auth configuration is missing
- the official client is unavailable / misconfigured
- a remote mutation throws

They never silently fall back to a local grant or report successful remote sync
on failure.

### Sync states

Table: `w3ds_authorization_sync` (one row per `resourceId` + `subjectEName` + `scope`)

| `sync_status` | Meaning |
| --- | --- |
| `pending` | Intent recorded; remote mutation not yet confirmed |
| `synced` | Remote grant confirmed for intent=`grant` |
| `revoked` | Remote revoke confirmed for intent=`revoke` |
| `failed` | Last remote attempt failed; safe redacted `failure_reason` stored |

Also persisted: resource/subject/scope intent, optional `external_grant_id` /
`external_owner_binding_id`, `attempt_count`, `last_attempted_at`,
`last_synced_at`.

### Retry semantics

1. Re-running `grant` after `synced` is a no-op (no duplicate remote grant).
2. Re-running `revoke` after `revoked` is a no-op (access stays revoked).
3. Re-running after `failed` increments `attempt_count` and retries the remote
   mutation for the current intent.
4. Changing intent (`grant` ↔ `revoke`) resets status to `pending` and clears
   the previous failure reason before the next attempt.
5. Partial remote failure leaves the row `failed` and throws `sync_failed`
   (503). Callers must not treat the resource as remotely synchronized.

### Secret handling

- W3DS credentials and raw remote errors stay server-only
- `failure_reason` is passed through `redactAuthorizationFailureReason` before
  persistence (strips bearer tokens, JWTs, password/secret fields, credential
  URLs)
- Sync records, credentials, and remote payloads must not be returned to browser
  clients or logged in raw form

---

## 4. Providers and capabilities

| Provider id | Selected when | Role |
| --- | --- | --- |
| `local` | `AUTH_PROVIDER=dev` (default), or `W3DS_AUTHZ_PROVIDER=local` | Explicit development/local policy |
| `w3ds` | `AUTH_PROVIDER=w3ds` (default), or `W3DS_AUTHZ_PROVIDER=w3ds` | W3DS-oriented boundary |

| Capability | `local` | `w3ds` (today) | `w3ds` + official SDK client |
| --- | --- | --- | --- |
| `localPolicyEvaluation` | yes | yes | yes |
| `remoteGrantEvaluation` | no | no | no (no evaluate API installed) |
| `remoteGrantMutation` | no | no | yes |
| `grantSynchronization` | no | no | yes |

Rules:

1. Development never silently claims W3DS remote capabilities.
2. Constructing the W3DS provider without W3DS auth configuration fails closed
   (`configuration_error` / 503).
3. Requiring sync/mutation without an official client fails closed
   (`capability_unavailable` / `sdk_unavailable` / 503) and reports the exact
   missing SDK gaps.
4. `authorize()` remains local-policy-only; sync is a separate server adapter.

---

## 5. Server-only configuration

Do not expose these values through `NEXT_PUBLIC_*`.

| Variable | Purpose |
| --- | --- |
| `AUTH_PROVIDER` | Auth mode; defaults authz provider (`dev` → `local`, `w3ds` → `w3ds`) |
| `W3DS_AUTHZ_PROVIDER` | Optional override: `local` \| `w3ds` |
| `W3DS_REGISTRY_BASE_URL` | Part of W3DS authorization configured gate |
| `W3DS_AUTH_JWT_SECRET` | Part of configured gate (≥ 32 characters) |
| `DATABASE_URL` | Durable identity/session/sync store |

“Configured” means W3DS auth secrets + registry + database are present. It does
**not** enable remote mutation until an official authorization SDK client exists.

When an official SDK is added later, document any additional SDK-required
credentials here. Do not invent them ahead of the SDK.

---

## 6. Implementation location

| Path | Role |
| --- | --- |
| `apps/web/src/server/resource-authorization.ts` | Model, policy, providers, opaque ids |
| `apps/web/src/server/w3ds-authorization-sync.ts` | Durable sync service + redaction |
| `apps/web/src/server/w3ds-authorization-official-client.ts` | Official client boundary + fake test client |
| `apps/web/src/server/w3ds-authorization-sync-store.ts` | Durable sync persistence |
| `apps/web/src/server/db/schema.ts` | `w3ds_authorization_sync` table |
| `apps/web/drizzle/0004_*.sql` | Migration |

Browser packages do not import these modules. Routes/UI are not wired in this
phase. No automatic background worker is started.

---

## 7. Operational failure behavior

| Condition | Result |
| --- | --- |
| `AUTH_PROVIDER`/`W3DS_AUTHZ_PROVIDER` selects `w3ds` without auth config | Provider construction fails (`configuration_error` / 503) |
| Sync called without official SDK client | `sdk_unavailable` / 503 with exact missing capability text |
| Sync called without auth config | `configuration_error` / 503 |
| Remote ensure/grant/revoke throws | Row → `failed`, redacted reason stored, `sync_failed` / 503 |
| Duplicate grant/revoke | No-op success using durable terminal state |
| Official client becomes available later | Inject/resolve client; capabilities flip on for mutation/sync |

Monitor `sdk_unavailable`, `configuration_error`, and `sync_failed` separately
from client auth failures (`invalid_session` / 401).

---

## 8. Explicit non-goals (this phase)

- Fabricated eVault GraphQL/HTTP ACL integrations
- Automatic background retry workers
- Share-management routes or UI
- Changes to public/discovery/media route behavior
- Browser secrets or protocol URLs in the client bundle
- Channel/collection authorization (deferred)

---

## 9. Acceptance criteria

1. Subjects remain W3DS identity fields only.
2. Opaque Phase 1 resource ids are the sync keys.
3. Grant / revoke / reconcile are idempotent and durable.
4. Missing official SDK/config fails closed with exact gap reporting.
5. Remote failures never report successful sync or fall back to local grants.
6. Secrets and raw remote errors are redacted from persisted failure reasons.
7. No route/UI/worker behavior changes ship in this phase.
