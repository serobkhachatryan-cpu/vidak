# W3DS Resource Authorization Foundation

**Status:** Phase 1 foundation (policy evaluation only)  
**Date:** 2026-08-04  
**Scope:** Server-only authorization model for creator videos and media  
**Non-goals:** Route/UI wiring, eVault ACL mutations, grant sync, share management

---

## 1. Purpose

Vidak already authenticates users through W3DS (`w3ds://auth`) and enforces
local ownership plus product visibility on video/media routes. This foundation
adds a **provider-neutral, server-only authorization model** that later phases
can use to delegate access decisions to W3DS without rewriting product semantics.

Phase 1:

- Defines resource, subject, owner, and access-scope types
- Evaluates the **same** local ownership / visibility rules used today
- Exposes an authorization-provider interface with explicit capability detection
- Does **not** change route handlers, public APIs, or UI behavior
- Performs **no** Registry / eVault / ACL network mutations

---

## 2. Model

### Subject (canonical identity)

Authorization subjects are derived only from authenticated W3DS platform
identity:

| Field | Source | Role |
| --- | --- | --- |
| `platformUserId` | `AuthUser.id` / JWT `sub` | Local ownership key |
| `eName` | Verified W3ID (`@…`) | Global identity for later grants |
| `eVaultId` | Registry-resolved vault id | Future ownership / ACL binding |

**Not subjects:** email, display name, browser storage keys, client-supplied ids,
or any identifier the browser can forge.

Anonymous callers are modeled as `{ kind: 'anonymous' }` and never synthesize a
subject.

### Resource

| Kind | Local row | Opaque id |
| --- | --- | --- |
| `creator_video` | `videos.id` | `vra_1_v_<digest>_<encodedLocalId>` |
| `media_asset` | `media_assets.id` | `vra_1_m_<digest>_<encodedLocalId>` |

Opaque `resourceId` values are deterministic and server-decodable. They are
suitable as stable keys for later W3DS-backed ownership and grant
synchronization. They are not public product URLs (those continue to use
`publicVideoId`).

### Owner

```ts
{ platformUserId: string; eName?: string }
```

Ownership decisions today compare `platformUserId`. `eName` is retained on the
descriptor for later `ownerEnamePath` / grant sync.

### Access scopes

| Scope | Meaning |
| --- | --- |
| `video:owner` | Owner draft/publish/unpublish mutations |
| `video:read` | Read video metadata (owner or anonymous public/unlisted detail) |
| `video:discover` | Appear in anonymous discovery listing |
| `media:owner` | Owner media upload/download/delete |
| `media:read` | Stream/download media (owner or anonymous public/unlisted) |

Scopes are product vocabulary. They are **not** raw eVault ACL arrays.

---

## 3. Local policy (preserved behavior)

`evaluateLocalResourcePolicy` mirrors current route/store guarantees:

| Caller | Resource state | `video:owner` / `media:owner` | `video:read` / `media:read` | `video:discover` |
| --- | --- | --- | --- | --- |
| Owner | any | allow | allow | n/a (listing is anonymous) |
| Other user | any | deny (`not_owner`) | same as anonymous | n/a |
| Anonymous | `draft` | deny | deny | deny |
| Anonymous | `published` + `private` | deny | deny | deny |
| Anonymous | `published` + `unlisted` | deny | allow | deny |
| Anonymous | `published` + `public` | deny | allow | allow |

Publish/unpublish still do not change visibility. This phase only evaluates
policy; existing services continue to enforce access.

---

## 4. Providers and capabilities

| Provider id | Selected when | Role |
| --- | --- | --- |
| `local` | `AUTH_PROVIDER=dev` (default), or `W3DS_AUTHZ_PROVIDER=local` | Explicit development/local policy |
| `w3ds` | `AUTH_PROVIDER=w3ds` (default), or `W3DS_AUTHZ_PROVIDER=w3ds` | W3DS-oriented boundary |

Capability matrix (Phase 1):

| Capability | `local` | `w3ds` |
| --- | --- | --- |
| `localPolicyEvaluation` | yes | yes |
| `remoteGrantEvaluation` | no | no |
| `remoteGrantMutation` | no | no |
| `grantSynchronization` | no | no |

Rules:

1. Development never silently claims W3DS remote capabilities.
2. Constructing the W3DS provider without W3DS auth configuration fails closed
   (`configuration_error` / 503).
3. Requiring an unavailable capability fails closed
   (`capability_unavailable` / 503).
4. `authorize()` performs **local policy only** and does not call Registry,
   eVault, or any remote ACL API.

---

## 5. Server-only configuration

Authorization configuration is server-only. Do not expose these values through
`NEXT_PUBLIC_*`.

| Variable | Purpose |
| --- | --- |
| `AUTH_PROVIDER` | Selects auth mode; also defaults authz provider (`dev` → `local`, `w3ds` → `w3ds`) |
| `W3DS_AUTHZ_PROVIDER` | Optional override: `local` \| `w3ds` |
| `W3DS_REGISTRY_BASE_URL` | Part of “W3DS authorization configured” gate |
| `W3DS_AUTH_JWT_SECRET` | Part of configured gate (≥ 32 characters) |
| `DATABASE_URL` | Part of configured gate (durable identity/session store) |

“Configured” for the W3DS authorization provider means the same server secrets
already required for W3DS authentication. It does **not** enable remote grant
evaluation or mutation in this phase.

---

## 6. Implementation location

| Path | Role |
| --- | --- |
| `apps/web/src/server/resource-authorization.ts` | Model, policy, providers, config, opaque ids |
| `apps/web/src/server/resource-authorization-errors.ts` | Typed errors |
| `apps/web/src/server/resource-authorization.test.ts` | Unit tests |

Browser packages (`@w3ds/auth`, `@w3ds/api-client`) do not import this module.
Routes are not wired yet; `getResourceAuthorizationProvider()` exists for later
integration.

---

## 7. Explicit non-goals (this phase)

- W3DS / eVault network calls for ACL reads or writes
- Remote grant creation, revocation, or background synchronization
- Share-management routes or UI
- Changes to public/discovery/media route behavior
- Browser secrets or protocol URLs in the client bundle
- Channel/collection authorization (deferred)

---

## 8. Acceptance criteria

1. Subjects are W3DS identity fields only; email cannot authorize.
2. Local ownership and public/unlisted/private visibility decisions match today’s
   product rules.
3. Provider capabilities are explicit; unavailable capabilities fail closed.
4. Development remains on the local provider without silent W3DS remote grants.
5. Opaque resource ids are stable and resolvable server-side.
6. No route/UI behavior changes and no W3DS network mutations ship in this phase.
