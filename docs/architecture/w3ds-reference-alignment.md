# W3DS Reference Alignment Charter

**Status:** authoritative implementation baseline  
**Date:** 2026-08-05  
**Scope:** Vidak as a W3DS Post-Platform  
**Source of truth:** the 27 W3DS HTML documents tracked in `docs/`

## Purpose

Vidak is a video Post-Platform. It keeps a product-shaped local database and
API, but identity, ownership, interoperable metadata, media references, and
cross-platform synchronization must follow W3DS. The browser remains
product-oriented: it must not call Registry, eVault, Ontology, or Awareness
services directly and must not display protocol internals as product UI.

This charter supersedes older architecture text where it conflicts with the
local W3DS reference documents. It is a traceability document, not a substitute
for those protocol documents.

## Non-negotiable rules

1. Each user-facing protocol flow is backed by its matching local HTML source.
   Do not invent HTTP endpoints, GraphQL operations, credentials, schemas, or
   signature encodings.
2. W3DS integrations stay server-only. Browser code talks only to Vidak routes
   and typed product clients.
3. Local product IDs and global MetaEnvelope IDs are distinct and are linked by
   durable, idempotent mappings.
4. Every synchronized entity has an explicit owner eName. Ownership, ACL, and
   schema selection are backend concerns.
5. `w3ds://file` is the interoperable media reference. A local storage key,
   filesystem path, or unsigned HTTP URL is never treated as a global file ID.
6. Awareness is eventually consistent and may redeliver messages. Inbound
   processing must be authenticated, idempotent, and observable.
7. Any capability without a documented and configured SDK/service integration
   is unavailable and fails closed. Tests may use explicit fakes; production
   must not silently simulate a successful W3DS operation.

## Current baseline

The baseline already supplies:

- `w3ds://auth` offers, eID callback normalization, durable offer/session
  records, server-side Registry/eVault key verification, and HTTP-only platform
  session cookies.
- Durable local users, creator-video drafts, private media storage, public
  publishing routes, local authorization policy, operations checks, and
  server-only configuration.
- A fail-closed authorization synchronization boundary, intentionally inactive
  until the documented official ACL client is available.
- An opt-in server-only platform eVault bootstrap: Registry entropy,
  Provisioner registration, public PlatformProfile creation, and a durable
  local mapping. It is disabled until the operator supplies the documented
  Provisioner verification credentials and discovery profile.
- An opt-in Ontology + Web3 Adapter mapping foundation: durable PostgreSQL
  `(entity type, local id, global MetaEnvelope id, owner eName, schema id,
  mapping version)` rows with unique constraints. Mapping writes fail closed
  until `W3DS_ONTOLOGY_BASE_URL` and every entity schemaId are configured.
  Schema IDs are never guessed from documentation examples. The documented
  Ontology base URL is `https://ontology.w3ds.metastate.foundation`
  (`DOCUMENTED_W3DS_ONTOLOGY_BASE_URL`). A live `GET /schemas` catalog does
  **not** currently include canonical Video, Channel, Playlist, or Comment
  schemas, so the adapter stays disabled and schemaId env vars stay empty.
- A submission-ready Vidak ontology schema package at
  `docs/proposals/w3ds-ontology-vidak-v1/` (draft-07 Video, Channel, Playlist,
  Comment proposals, examples, and future `localToUniversalMap` contract).
  **Ready for MetaState maintainer submission.** It does **not** invent
  `schemaId` values and does **not** enable `W3DS_ONTOLOGY_ADAPTER_ENABLED`.

The following Post-Platform requirements are not yet implemented:

- a documented eVault client for MetaEnvelope and file operations;
- versioned Mapping Rules JSON (`ownerEnamePath`, field transforms) and
  outbound `handleChange` / inbound `fromGlobal` sync once schemaIds exist;
- `w3ds://file` references for interoperable media;
- Awareness webhook ingress and idempotent processing;
- a platform `w3ds://sign` request/verification surface.

### MetaState inputs still required (Phase B gate)

Before Vidak may enable the Ontology adapter, MetaState must provide:

1. **Assigned stable schema IDs (W3IDs)** for Video, Channel, Playlist, and
   Comment (plus any Profile ID still required by adapter config).
2. **Deployed catalogue availability** of those schemas on the configured
   Ontology base URL (`GET /schemas` listing and `GET /schemas/:id` full
   draft-07 documents including the assigned `schemaId`).

## Reference traceability

| Reference document | Vidak responsibility | Alignment phase |
| --- | --- | --- |
| `Getting Started with W3DS` | Preserve user-owned eVault data and platform-local projections. | Foundation |
| `W3DS Basics` | Local DB → eVault → Awareness → local projection model. | Adapter |
| `Glossary` | Use W3DS terminology consistently in code and operations docs. | Foundation |
| `W3ID` and `eName` | Store validated eName/eVault identity separately from local IDs. | Identity |
| `eID Wallet` | Accept wallet transport only through authenticated server callbacks. | Identity |
| `Authentication` | One-time 128-bit offers, P-256/SHA-256 verification, replay protection. | Identity |
| `Signature Formats` | Support only documented raw/DER and documented multibase encodings. | Identity |
| `Signing` | Add a server-mediated `w3ds://sign` flow; no client-side verification. | Signing |
| `wallet-sdk` | Use an explicit server adapter around documented SDK capabilities. | Identity / Signing |
| `eVault` | Use the documented GraphQL and HTTP contracts through a server client. | eVault |
| `Registering a Platform eVault` | Provision, persist, and resolve Vidak's platform eVault. | eVault |
| `eVault Key Delegation` | Keep delegation and key-binding material server-only. | eVault |
| `Binding Documents` | Treat binding information as identity evidence; never replace it with email. | Identity |
| `Registry` | Resolve eNames, discover keys/certificates, and obtain entropy only via the documented client. | eVault |
| `Ontology` | Resolve schema IDs from configured ontology metadata, never guessed UUIDs. | Adapter |
| `Web3 Adapter` | Map local entities, own global IDs, and handle inbound/outbound changes. | Adapter |
| `Mapping Rules` | Versioned mappings use `ownerEnamePath`, field transforms, and `__file`. | Adapter |
| `Webhook Controller Guide` | Provide `POST /api/webhook` with validation, mapping, idempotency, and observability. | Awareness |
| `Awareness Protocol` | Process documented packets and tolerate ordering/redelivery limitations. | Awareness |
| `Awareness as a Service` | Configure and monitor the supported fanout service; do not implement a competing fanout. | Awareness |
| `File URIs` | Persist and resolve `w3ds://file` for synchronized media. | Media |
| `Getting Started with Platform Development` | Use the documented platform configuration and lifecycle. | Foundation |
| `Local Dev Quick Start` | Document compatible local dependencies, environment, and sandbox checks. | Operations |
| `Using the Dev Sandbox` | Exercise auth and signing through documented sandbox fixtures. | Verification |
| `AI Agent Skill` | Package protocol guidance so future changes do not guess mappings or schema IDs. | Tooling |
| `eCurrency: Accounts and Ledger MetaEnvelopes` | Reference only: no currency/ledger feature is in Vidak's product scope. | Out of scope |

## Delivery sequence

### Phase A — protocol foundation and capability gates

1. Centralize Registry, eVault, Ontology, platform-certification, and
   wallet-signing contracts behind server-only interfaces.
2. Add a durable platform-eVault record and explicit configuration diagnostics.
3. Add a checked-in W3DS engineering skill/reference index sourced from the
   local HTML documents.
4. Build contract fixtures from the documents. Unknown upstream responses must
   fail closed rather than be accepted permissively.

### Phase B — ontology and adapter

**Phase B remains disabled** pending MetaState-assigned schema IDs and deployed
catalogue availability. The Vidak schema proposal package is ready for
maintainer submission (`docs/proposals/w3ds-ontology-vidak-v1/`); do not enable
`W3DS_ONTOLOGY_ADAPTER_ENABLED` until the inputs listed under “MetaState inputs
still required” are in place.

1. Define versioned mappings for profile, channel, video, playlist, and
   comment entities only after their ontology schema IDs are configured.
   **Done (proposal only):** draft-07 schemas + mapping-contract placeholders
   without invented IDs. Runtime Mapping Rules JSON still waits on published
   `schemaId`s.
2. Persist `(entity type, local id, global MetaEnvelope id, owner eName,
   schema id)` mappings with unique constraints and idempotency keys.
   **Done (foundation):** durable `w3ds_adapter_mappings` + fail-closed
   Ontology config wired to the documented Ontology base URL. Mapping Rules
   JSON, remote sync, and Video/Channel/Playlist/Comment schemaIds remain
   pending until Ontology publishes those schemas.
3. Sync local mutations through the adapter outbox; retries must not duplicate
   envelopes or overwrite remote ownership.
   **Partial (Vidak-private only):** durable `w3ds_private_adapter_outbox` +
   `w3ds_private_adapter_projections` sync Channel/Video against the private
   catalogue when `W3DS_ONTOLOGY_MODE=vidak_private` and
   `W3DS_ONTOLOGY_ADAPTER_ENABLED=true`. This path does **not** call MetaState
   Ontology/eVault/Awareness and must not be treated as interoperable public
   W3DS sync. MetaState remote outbox remains future work.

### Phase C — interoperable media

1. Upload supported media through the documented eVault/file adapter.
2. Store a `w3ds://file` URI in the synchronized projection while retaining
   private local storage details only as implementation state.
3. Separate small metadata/thumbnail flows from the large-video strategy and
   document any documented size boundary.

### Phase D — awareness and projections

1. Add authenticated `POST /api/webhook` ingress.
2. Resolve the packet schema to a mapping, upsert the local projection by
   global ID, record an idempotency receipt, and invalidate relevant queries.
3. Expose readiness/metrics for failed, retried, and ignored packets without
   logging credentials or private envelope data.

### Phase E — signing and verification

1. Add product-scoped signing requests through `w3ds://sign` where Vidak has
   a genuine user-consent need.
2. Verify signatures server-side with the documented formats and key bindings.
3. Cover auth, signing, Registry/eVault fixtures, mapping, media, and webhook
   flows in the Dev Sandbox and integration harness.

## Completion criteria

Vidak is aligned when a verified eName can authenticate; a creator-owned video
can be represented by an ontology-backed MetaEnvelope with a documented file
reference; another platform's Awareness packet can update the local projection
exactly once; and all unavailable upstream capabilities fail closed with
actionable operator diagnostics.
