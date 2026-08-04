# W3DS Alignment Review — Vidak

**Role:** Principal Architect  
**Date:** 2026-08-04  
**Scope:** Architecture audit of the Vidak (W3DS Video) repository against the W3DS protocol documentation under `docs/` (including the W3DS reference set on `develop`).  
**Constraints honored:** No source code changes, no refactors, no commits, no pushes.

---

## 1. Executive Summary

Vidak is a **production-quality video product frontend** with a clear monorepo architecture, typed domain model, mock API contracts, React Query, design system, and complete browse/create UX through the first ~13 milestones. As a **video platform**, it is in good shape.

As a **W3DS Post-Platform**, it is **not yet aligned**. The application behaves as a classical siloed product: local string IDs, password auth, in-memory mock storage, HTTP-shaped product APIs, and no path to eVault, Ontology, Registry, Web3 Adapter, Awareness, or `w3ds://file`.

That gap is expected at this stage and is **architecturally recoverable** — provided the next milestones introduce a real platform backend that keeps Vidak’s product domain as the local schema and maps it to W3DS underneath, without leaking protocol internals into the UI.

**Overall recommendation:** Continue product work only where it hardens the local domain and API contracts; make **W3DS platform integration the primary architectural track for Milestones 14+**. Do not rewrite the frontend product model into MetaEnvelope/GraphQL shapes.

---

## 2. Current Architecture

### 2.1 Repository shape

pnpm / Turborepo monorepo under the `@w3ds/*` scope:

| Layer | Packages / apps |
| --- | --- |
| Apps | `web` (product), `admin`, `landing`, `docs` (bootstrap) |
| Domain & data | `types`, `api-client`, `hooks`, `auth` |
| Feature pages | `watch-page`, `channel-page`, `user-profile-page`, `upload-page`, `settings-page` |
| UI foundation | `ui`, `design-tokens`, `icons`, `config`, `utils` |
| Reserved empty | `player`, `sdk` |

Dependency direction is healthy and acyclic:

```text
apps/web → feature pages → hooks → api-client → types
apps/web → ui → design-tokens
apps/web → auth
```

### 2.2 Runtime reality

- **No backend service.** No API routes, persistence, queues, object storage, or processing pipeline.
- **All data is mock.** `MockVideoApiClient` and `MockAuthApiClient` hold in-memory state with artificial latency.
- **Auth** is email/password with browser-readable access/refresh tokens in `localStorage` / `sessionStorage`.
- **Playback** is a placeholder; `@w3ds/player` and `@w3ds/sdk` export nothing.
- **Upload** simulates progress, invents duration, and creates a `Video` record — no blob storage.

### 2.3 Product surface (implemented)

| Route | Status |
| --- | --- |
| `/` Home feed | Complete |
| `/watch/[videoId]` | Complete (placeholder player) |
| `/channel/[channelId]` | Complete |
| `/user/[userId]` | Complete |
| `/search` | Complete (client-side mock filter) |
| `/upload` | Complete (auth-guarded, mock pipeline) |
| `/settings` | Complete (auth-guarded) |
| `/login`, `/register` | Complete (mock) |
| `/library` | Auth shell only |
| `/subscriptions` | Nav link only — **no route** |

### 2.4 Domain model (local product schema)

Core entities in `@w3ds/types`:

```text
AuthUser ──id──► UserProfile ──ownerId──► Channel ──channelId──► Video
                                      └──channelId──► Playlist ──items──► Video
Video ──videoId──► Comment (threaded)
Upload (ephemeral uploadId) ──createVideo──► Video
```

Notable fields:

- `Video`: status (`draft|processing|published|archived`), visibility (`public|unlisted|private`), media URLs as plain strings, engagement counters.
- `Channel`: owned by `UserProfile`, handle/name/avatar/banner, subscriber/video counts.
- `Playlist`: channel-owned ordered video list (product “collection” analogue).
- `UserProfile` vs `AuthUser`: separate types joined only by shared string IDs.
- Settings: preferences, privacy, connected accounts, sessions — all local product concepts.

**Not modeled:** W3ID/eName, MetaEnvelope IDs, ontology/schema IDs, ACL arrays, file URIs, global↔local ID maps, subscriptions as entities, watch history, notifications inbox, processing jobs, storage references.

### 2.5 API & React Query

- `VideoApiClient` is a typed product contract (get/list/create/update/publish, comments, profiles, settings, upload).
- Hooks cover reads and some settings mutations; upload/create/publish and comment writes are often called from page data layers.
- Query keys are product-scoped (`video`, `settings`) — appropriate for a Post-Platform local cache layer later.

### 2.6 Documentation drift

Committed project docs (`architecture.md`, `backend.md`, `frontend.md`, `product-roadmap.md`) still describe an earlier bootstrap state and omit Channel/Upload/Settings as shipped. The W3DS HTML reference set lives on `origin/develop` under `docs/`. Product docs and protocol docs are not yet reconciled into one architecture story.

---

## 3. W3DS Concepts Used

| W3DS concept | Used in Vidak today? |
| --- | --- |
| Package naming `@w3ds/*` | Branding / scope only |
| eVault / MetaEnvelope / Envelope | **No** |
| Ontology service / schemaId | **No** |
| Registry / W3ID / eName | **No** |
| Web3 Adapter / mapping.json | **No** |
| Awareness Protocol / webhooks | **No** |
| `w3ds://auth` / eID Wallet | **No** (password mock instead) |
| `w3ds://sign` / signatures | **No** |
| `w3ds://file` / `uploadFile` | **No** |
| ACL on MetaEnvelopes | **No** (product `visibility` only) |
| Binding documents / eID / Web Triad | **No** |
| Platform eVault / PlatformProfile | **No** |
| Search Platform (W3DS sense) | **No** (local UI search only) |

**Verdict:** Vidak currently uses **zero operational W3DS protocol concepts**. The `@w3ds` scope signals intent, not integration.

---

## 4. Mapping between current implementation and W3DS

W3DS expects: **platforms keep local schemas and databases**, sync through the Web3 Adapter to owner eVaults, and present a normal product UX. Vidak’s product domain is therefore the right *kind* of local schema — it is simply not wired to the protocol yet.

| Vidak (local) | W3DS (global / protocol) | Mapping status |
| --- | --- | --- |
| `AuthUser` + password session | W3ID/eName + `w3ds://auth` + platform JWT after signature verify | Misaligned |
| `UserProfile` | Likely `User` ontology MetaEnvelope in owner eVault | Not mapped |
| `Channel` | Group/Entity eVault or owned MetaEnvelope (ownership TBD by ontology design) | Not mapped |
| `Video` | New video-domain ontology schema(s) + Media/File refs | Not mapped |
| `thumbnailUrl` / media URLs (https strings) | `w3ds://file` + `w3ds-file-v1` storage envelopes; optional higher-level File ontology | Misaligned |
| `visibility` / private flags | MetaEnvelope `acl` (`["*"]`, eName lists, etc.) | Partial conceptual analogue only |
| `status: processing` | Local workflow state (may stay platform-local / readOnly in adapter) | Compatible as local-only |
| `Playlist` | Collection-like ontology or local-only until schema exists | Not mapped |
| `Comment` | Comment/social ontology or local engagement layer | Not mapped |
| `MockVideoApiClient` | Platform API over local DB + adapter outbound/inbound | Mock stands in for platform API only |
| React Query cache | Platform cache/aggregator role in W3DS | Structurally compatible |
| Upload wizard | Local create → blob via `uploadFile` / `__file` → MetaEnvelope create | Pipeline exists product-side only |
| Search UI | Local index/cache search; W3DS “Search Platform” is a separate ecosystem role | Product search ≠ protocol search |
| Roles (`creator\|moderator\|admin`) | Platform authz; eVault ACLs + authorized agents for data access | Orthogonal / incomplete |
| `/api/webhook` | Required Awareness ingress | Missing entirely |
| `@w3ds/sdk` (empty) | Natural home for adapter client, ID map helpers, auth offer helpers | Reserved but unused |

### Intended end-state data flow (not implemented)

```text
Creator UI → Vidak Platform API → Local DB
                ↓
         Web3 Adapter (toGlobal + ownerEnamePath)
                ↓
         Owner eVault GraphQL (MetaEnvelope + files)
                ↓
         Awareness webhooks → other platforms
                ↓
         Vidak webhook → fromGlobal → Local DB → React Query invalidation
```

UI stays product-shaped. Protocol stays under the adapter and platform services.

---

## 5. Areas already well aligned

These are strengths to **preserve**:

1. **Post-Platform-compatible product domain** — Video, Channel, Playlist, Comment, Profile are local application schemas, not leaked protocol types. This matches W3DS guidance that platforms keep their own schemas and map to ontology.

2. **Typed API boundary** — `VideoApiClient` / `AuthApi` give a seam where a real backend (and later adapter-backed persistence) can replace mocks without rewriting feature pages.

3. **React Query as cache/aggregator** — Matches the W3DS role of platforms as caches. Query keys and infinite lists are a viable local projection layer.

4. **Separation of feature packages** — Watch, channel, upload, settings as packages keep UX evolution independent of protocol integration.

5. **Visibility and lifecycle vocabulary** — `public|unlisted|private` and `draft|processing|published|archived` are good product semantics that can later map to ACL + local workflow without renaming UX.

6. **Upload as multi-step product flow** — Select → progress → details → thumbnail → visibility → publish is the right creator UX; W3DS file + MetaEnvelope writes should hang off the platform API behind this flow.

7. **Monorepo quality bar** — CI, Storybook, Vitest, Playwright smoke, Biome, Docker — suitable foundation for introducing backend and adapter packages without structural chaos.

8. **Empty `sdk` / `player` packages** — Correct reservation of boundaries for protocol SDK and playback without premature implementation.

---

## 6. Areas partially aligned

1. **Identity model** — There is a user concept (`AuthUser`, `UserProfile`, handles), but identifiers are opaque local strings, not W3IDs/eNames. Profiles are not MetaEnvelopes and have no Registry resolution.

2. **Permissions / visibility** — Product visibility approximates public vs restricted access, but is not ACL, not eName-addressable, and not enforced by eVault. Roles exist (`hasRole`) but are not capability tokens, ACL entries, or authorized-agent delegations.

3. **Asset lifecycle** — Status machine exists; real storage, transcoding, and durable media references do not. Upload IDs are ephemeral mock tokens, not `w3ds://file` URIs or File MetaEnvelopes.

4. **Metadata model** — Rich product metadata (title, tags, category, language) is good local payload material for a future Video ontology, but there is no `schemaId`, no JSON Schema registry usage, and no mapping.json.

5. **Channels / collections** — Channel-as-publisher and Playlist-as-collection fit a video product. W3DS may model channels as Group entities with their own eVaults or as owned MetaEnvelopes; that decision is unset. Playlists have no ontology mapping plan.

6. **Search** — Useful product UX over local lists; not a W3DS Search Platform, not ontology-filtered MetaEnvelope search, and mock sort for channels/playlists is incomplete.

7. **API contracts** — Clean for a siloed app; incomplete for a Post-Platform (no webhook contract, no global ID fields, no ename on users, no file URI types).

8. **Auth session shape** — Platform JWT *after* `w3ds://auth` is the W3DS pattern. Vidak already has session objects and route guards — reusable after replacing password login with signature offer/callback.

9. **Settings / connected accounts** — Fine as platform-local preferences. “Connected accounts” today are OAuth-flavored mocks, not eVault key delegation or binding documents.

10. **Documentation structure** — Folders for `docs/architecture`, `docs/product`, `docs/reference/w3ds` exist; protocol HTML is on `develop` but not yet organized as a durable local reference for implementers.

---

## 7. Areas misaligned

1. **No eVault integration** — No GraphQL client, no `X-ENAME`, no MetaEnvelope CRUD, no `/whois`, no platform token/certification flow.

2. **No Ontology usage** — No video/channel/comment schemas registered or referenced; no `schemaId` in domain types or API.

3. **No Web3 Adapter** — No mapping configs, no `(localId, globalId)` store, no `handleChange` / `fromGlobal`, no outbound sync.

4. **No Awareness / webhooks** — No `POST /api/webhook`, no idempotent ingest, no fanout story.

5. **Authentication protocol** — Password registration/login contradicts `w3ds://auth` (session offer → eID Wallet / Dev Sandbox signature → verify via Registry/eVault public keys → platform JWT).

6. **File model** — HTTPS Unsplash/mock URLs and simulated uploads contradict `uploadFile` + `w3ds://file` + distinction between `w3ds-file-v1` and platform File ontology.

7. **Ownership model** — Data is implicitly owned by the platform mock store. W3DS requires per-entity owner eVault writes (`ownerEnamePath`). Upload currently hardcodes `channelId = 'channel-studio'`.

8. **Capabilities** — No capability-based access, no ACL propagation, no authorized-agent model; only coarse roles and “is logged in” guards.

9. **Federation roadmap conflict** — Product docs still list ActivityPub as v0.4. W3DS interoperability is eVault + Awareness + shared ontology, not ActivityPub. Pursuing ActivityPub as the primary federation path would misalign with the authoritative W3DS docs.

10. **`@w3ds/sdk` emptiness with no integration plan in code** — Reserved name without a defined responsibility relative to adapter, Registry client, and auth helpers invites ad-hoc coupling later.

11. **Admin / landing / docs apps** — Unrelated bootstrap surfaces; fine, but they must not become alternate sources of truth for domain or protocol.

---

## 8. Architectural risks

| Risk | Why it matters | Severity |
| --- | --- | --- |
| **Silo lock-in of the domain** | If Video IDs, media URLs, and auth users ship to production without global ID / eName / file URI seams, migration to eVault becomes a rewrite | High |
| **Password auth cementing** | Building creator features on password sessions delays `w3ds://auth` and teaches the wrong identity model | High |
| **Mock API becoming “the” contract** | Feature packages calling mock semantics (e.g. invent duration, publish in `createVideo`) may encode non-portable behavior | High |
| **Ontology gap for video** | No Video/Channel/Comment schemas means adapter work cannot start; ad-hoc schemas will break interoperability | High |
| **Channel ownership ambiguity** | Channel vs user eVault ownership is undecided; wrong choice affects ACLs, uploads, and cross-platform sync | High |
| **Large media vs `uploadFile` 50MB limit** | Protocol file upload is base64 ≤ 50MB; real video needs chunked/direct-to-storage design compatible with W3DS file addressing | High |
| **ActivityPub distraction** | Parallel federation model splits engineering and contradicts W3DS docs | Medium |
| **N+1 / feed contract debt** | Per-card channel fetches and missing channel summaries will hurt when the platform API becomes real | Medium |
| **Docs drift** | Stale architecture/roadmap docs will cause wrong milestone sequencing | Medium |
| **Exposing protocol in UI** | Temptation to show ontology IDs, eVault URLs, or MetaEnvelope JSON to users — harms UX and couples UI to protocol | Medium |
| **Player/sdk vacuum** | Playback and SDK boundaries empty while watch UX advances — risk of page-local player forks | Low–Medium |
| **Eventual consistency surprise** | When Awareness arrives, React Query assumptions of immediate global truth will break without explicit sync/invalidation design | Medium (future) |

---

## 9. Recommended changes

Ordered for architectural leverage. Still **design/implementation guidance only** — not performed in this audit.

### 9.1 Immediate (architecture decisions)

1. **Declare Vidak a W3DS Post-Platform** in architecture docs: local DB + product API + Web3 Adapter + webhook ingress; UI never talks to eVault directly.
2. **Freeze a dual-ID policy:** every syncable entity will eventually carry `localId` (product) and optional `globalId` / owner `ename` (protocol). Add fields to types/API when backend starts — do not wait until after public launch.
3. **Commission Video-domain ontology schemas** (Video, Channel or Group binding, Comment, Playlist/Collection as needed) as JSON Schema draft-07 with stable `schemaId`s — even before full eVault wiring.
4. **Replace ActivityPub-as-primary federation** in the product roadmap with W3DS Awareness/ontology interoperability; keep ActivityPub only as an explicit non-goal or later bridge if ever required.
5. **Map `visibility` → ACL** as a documented rule (`public` → `["*"]`, `private` → owner eName, `unlisted` → deliberate ACL/discovery policy).
6. **Decide channel ownership:** channel content lives in creator eVault vs channel Group eVault; document `ownerEnamePath` implications for upload.

### 9.2 Backend foundation (first integration slice)

7. Introduce a real **platform API** (replace mocks behind `VideoApiClient`) with Postgres (or equivalent) local store.
8. Add **`POST /api/webhook`** and ID mapping table early — even if initially no-op tested against Dev Sandbox fixtures.
9. Integrate **Web3 Adapter** with mapping JSON for User Profile first (smallest ontology), then Video metadata, then files.
10. Implement **`w3ds://auth`** offer + callback; keep platform JWT for session; retire password auth from the happy path (Dev Sandbox for local).
11. Route avatar/thumbnail/small assets through **`uploadFile` / `__file`**; design **large video** upload as direct-to-object-storage with a File MetaEnvelope / `w3ds://file` reference recorded in the Video payload.

### 9.3 Product hardening that helps W3DS

12. Stop hardcoding `channel-studio`; bind upload to the authenticated user’s owned channel(s).
13. Keep processing/transcoding **platform-local** (adapter `readOnly` or non-synced fields) until a shared media ontology exists.
14. Extend React Query invalidation strategy for webhook-driven updates (per globalId / entity type).
15. Fill `@w3ds/sdk` with **platform-facing** helpers only (auth offer client, file URI parse, ID map types) — not raw GraphQL sprawl in feature packages.
16. Implement `@w3ds/player` against product media URLs resolved from file URIs server-side.

### 9.4 Documentation

17. Refresh `architecture.md` / `backend.md` / `product-roadmap.md` to match shipped milestones and the Post-Platform target.
18. Place canonical W3DS reference under `docs/reference/w3ds/` and link mapping decisions from `docs/architecture/`.

---

## 10. Changes that should NOT be made

1. **Do not expose protocol internals in the UI** — no MetaEnvelope JSON, ontology UUIDs, Registry URLs, or ACL arrays as primary creator/viewer UX.
2. **Do not rewrite `@w3ds/types` into Envelope/GraphQL shapes** — keep the product domain; map underneath.
3. **Do not have React components call eVault GraphQL** — that bypasses the platform cache/adapter model and breaks Awareness loops.
4. **Do not discard the mock `VideoApiClient` seam** — replace the implementation; keep the interface evolution disciplined.
5. **Do not refactor the design system / package graph “for W3DS”** — it is already healthy; protocol work belongs in backend/sdk/adapter layers.
6. **Do not prioritize ActivityPub, crypto-wallet theater, or on-chain media** as substitutes for eVault sync.
7. **Do not map every local field to ontology on day one** — preferences, sessions, processing jobs, and recommendation scores can stay platform-local / `readOnly`.
8. **Do not force large videos through base64 `uploadFile`** — respect the 50MB prototype limit; design a W3DS-compatible large-object path.
9. **Do not collapse UserProfile and Channel prematurely** — they are distinct product concepts; ontology may mirror that with clear ownership.
10. **Do not block all product UX milestones on full multi-platform sync** — but do not ship identity/media contracts that cannot gain `ename` / `globalId` / file URI later.
11. **Do not replace React Query** with an ad-hoc protocol cache — extend invalidation for webhooks instead.
12. **Do not treat `@w3ds` package naming as compliance** — branding ≠ alignment.

---

## 11. Revised roadmap for Milestones 14+

Assume milestones 1–13 delivered: foundation, design system, domain types, mock API, React Query, auth UI, home, watch, search, channel, upload, settings, and related quality work.

### Milestone 14 — Post-Platform architecture freeze
- Publish target architecture: local API + DB + adapter + webhook + eVault.
- Dual-ID and visibility↔ACL decision records.
- Ontology draft list for Video domain.
- Roadmap correction: W3DS over ActivityPub as interoperability backbone.
- Refresh stale product/architecture docs.

### Milestone 15 — Platform backend spine
- Persist Video/Channel/Profile/Comment behind `VideoApiClient`.
- Auth session issuance from platform API (still may bridge from mock users temporarily).
- Remove upload hardcoding of channel ownership.
- Contract tests for the mock→HTTP client swap.

### Milestone 16 — Identity: `w3ds://auth`
- Auth offer + callback + signature verification (Dev Sandbox).
- Map eName → local user; issue platform JWT.
- Deprecate password registration for W3DS mode.
- Bind settings/profile to authenticated eName-backed user.

### Milestone 17 — Ontology + Web3 Adapter (profiles first)
- Register/fetch User (and PlatformProfile) schemas.
- Mapping JSON + ID map store.
- Outbound sync on profile update; inbound webhook apply.
- Prove round-trip with a second consumer or fixture harness.

### Milestone 18 — Files and media references
- Avatars/thumbnails via `w3ds://file`.
- Large video upload architecture (direct storage + File MetaEnvelope reference on Video).
- Server-side dereference for player URLs.
- Clarify `w3ds-file-v1` vs future platform File ontology usage.

### Milestone 19 — Video MetaEnvelopes
- Video ontology + mappings (`ownerEnamePath`, ACL from visibility).
- Create/update/publish paths sync metadata to owner eVault.
- Keep processing status local until media pipeline is stable.
- Webhook ingest updates local video rows + React Query invalidation.

### Milestone 20 — Channels & collections
- Finalize Channel/Group ownership model.
- Playlist/collection ontology or explicit local-only stance.
- Channel page and upload authorization based on ownership, not hardcoded IDs.

### Milestone 21 — Comments & engagement sync policy
- Decide which engagement data is global vs platform-local.
- If global: Comment ontology + ACL; if local: document non-sync.
- Like/subscribe/save: prefer local until ontology exists — avoid fake protocol claims.

### Milestone 22 — Player & watch completion
- Implement `@w3ds/player` against resolved media URLs.
- Watch page replaces placeholder; accessibility and mobile parity.
- No protocol UI leakage.

### Milestone 23 — Search & discovery as platform cache
- Real indexed search over local projections (not eVault fanout queries from the browser).
- Optional later: integrate ecosystem Search Platform patterns.
- Fix channel/playlist sort contracts.

### Milestone 24 — Library, subscriptions, creator studio
- Product features on top of stable ownership and sync.
- Subscriptions as local graph first; sync only with ontology + ACL plan.
- Creator management views over platform API.

### Milestone 25 — Hardening & multi-platform readiness
- Idempotent webhooks, outbox/CDC for adapter `handleChange`, retries.
- Conflict policy (document last-write-wins; plan versions).
- Observability, platform eVault registration, Dev Sandbox CI path.
- Security review of auth, ACL mapping, and file access.

---

## 12. Overall recommendation

**Vidak should proceed as a W3DS Post-Platform video product — not as a protocol demo, and not as a classical siloed host that “adds W3DS later.”**

- The **frontend product architecture is an asset**: keep it, harden API contracts, and continue UX only where it does not cement anti-protocol identity or media models.
- The **critical missing layer is the platform backend + ontology + adapter + auth protocol**. That is the center of Milestones 14–19.
- Success looks like: creators and viewers experience an excellent video site; underneath, metadata and entitlements live in user eVaults, files are addressable with `w3ds://file`, identity is eName-based, and other platforms can receive Awareness updates — **without the UI speaking GraphQL or ontology IDs**.

**Go / no-go for more pure-UI milestones:**  
Acceptable for player, library shells, and polish.  
**Not acceptable** to expand password-centric identity, mock-only media permanence, or ActivityPub federation before the W3DS spine exists.

**Alignment score (directional):**

| Dimension | Score |
| --- | --- |
| Product UX architecture | Strong |
| Local domain fitness for mapping | Good |
| API seam for backend swap | Good |
| eVault / Ontology / Adapter / Awareness | Absent |
| Identity (`w3ds://auth`) | Misaligned |
| Files (`w3ds://file`) | Misaligned |
| Permissions / ACL / capabilities | Weak analogue only |
| Future protocol compatibility (if M14+ followed) | Recoverable |

**Final verdict:** Architecturally healthy video application; **W3DS-aligned only in naming and in the accidental correctness of keeping a local product schema**. Treat Milestones 14+ as the start of real protocol alignment, with the explicit goal of the best possible video platform that uses W3DS correctly underneath.
