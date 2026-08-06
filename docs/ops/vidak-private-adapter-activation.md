# Vidak-private adapter sync — production activation runbook

**Audience:** Vidak operator (`vidak` SSH user)  
**Scope:** enable Vidak-private Channel/Video adapter sync on production  
**Deployed code (required):** `f9b07b94216bd2e6dcbeced4f245c08650402da7`  
**Env file to edit:** `/srv/vidak/.env` only (Vidak-owned, writable, mode `600`)  
**Do not edit:** `/etc/vidak.env` (owner-managed; leave unchanged)  
**Service to restart:** `vidak.service` only via `sudo vidakctl restart`

## Status

Production activation succeeded by writing the verified private-adapter settings into
`/srv/vidak/.env` and restarting with `sudo vidakctl restart`. systemd loads
`EnvironmentFile=-/etc/vidak.env` then `EnvironmentFile=-/srv/vidak/.env`, so keys
present only in `/srv/vidak/.env` are applied at runtime.

## Warning — out of scope (must not be enabled)

This activation is **platform-local Vidak-private sync only**. Do **not**:

- set `W3DS_ONTOLOGY_MODE=metastate_official`
- point `W3DS_ONTOLOGY_BASE_URL` at MetaState Ontology (`https://ontology.w3ds.metastate.foundation` or any remote Ontology)
- enable platform eVault provisioning / MetaState eVault writes
- enable webhooks, Awareness, or ACL federation
- enable remote W3DS / `w3ds://file` upload calls
- run historical backfill or replay of existing Channel/Video rows
- enable Playlist or Comment product sync (not in this release)
- modify `DATABASE_URL` or unrelated keys
- modify `/etc/vidak.env`
- reverse or drop migration `0007` (`w3ds_private_adapter_projections` / `w3ds_private_adapter_outbox`) on rollback

Existing `ONTOLOGY_BASE_URL` in `/srv/vidak/.env` (MetaState) is a **different** key and must be left unchanged. Private sync uses **`W3DS_ONTOLOGY_BASE_URL` only** — not `W3DS_ONTOLOGY_BASE_URI` (unsupported typo/key).

## Exact non-secret settings (verified)

Idempotently add or update **only** these lines in `/srv/vidak/.env` (values are non-secret identifiers):

```bash
# Vidak-private adapter sync activation (platform-local only).
# Does not enable MetaState official catalogue, eVault, webhooks, ACL, or remote W3DS calls.
W3DS_ONTOLOGY_MODE=vidak_private
W3DS_ONTOLOGY_ADAPTER_ENABLED=true
W3DS_ONTOLOGY_BASE_URL=https://vidak.postplatforms.com/api/w3ds/ontology
W3DS_ONTOLOGY_SCHEMA_ID_PROFILE=schema-profile-local
W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL=vidak:private:ontology:v1:channel
W3DS_ONTOLOGY_SCHEMA_ID_VIDEO=vidak:private:ontology:v1:video
```

| Setting | Value | Notes |
| --- | --- | --- |
| `W3DS_ONTOLOGY_MODE` | `vidak_private` | Required mode for private sync |
| `W3DS_ONTOLOGY_ADAPTER_ENABLED` | `true` | Explicit enable gate |
| `W3DS_ONTOLOGY_BASE_URL` | `https://vidak.postplatforms.com/api/w3ds/ontology` | Local private catalogue (not MetaState). **Not** `W3DS_ONTOLOGY_BASE_URI` |
| `W3DS_ONTOLOGY_SCHEMA_ID_PROFILE` | `schema-profile-local` | Required by config loader; Profile is not in the private catalogue; Channel/Video sync does not use this ID |
| `W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL` | `vidak:private:ontology:v1:channel` | Private catalogue ID |
| `W3DS_ONTOLOGY_SCHEMA_ID_VIDEO` | `vidak:private:ontology:v1:video` | Private catalogue ID |

Omit `W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST` / `W3DS_ONTOLOGY_SCHEMA_ID_COMMENT` (code defaults to private IDs; no product sync hooks in this release).  
Do not set `W3DS_ADAPTER_MAPPING_VERSION` unless intentionally changing it (default `1`).

Verified runtime result: `ontologyMode=vidak_private`, `privateAdapterSyncEnabled=true`, domain schema IDs all `vidak:private:ontology:v1:*`, `remoteW3dsNetworkCalls=false`.

## Activation sequence (vidak user)

Do not print `/srv/vidak/.env` or `/etc/vidak.env` contents to shared logs.

```bash
set -euo pipefail

# 1) Protected backup within /srv/vidak (preserve mode 600; do not cat / print the file)
cp -a /srv/vidak/.env /srv/vidak/.env.bak.pre-private-adapter-activation
chmod 600 /srv/vidak/.env.bak.pre-private-adapter-activation

# 2) Idempotently add/update only the verified private-adapter settings in /srv/vidak/.env
#    (exact keys above; use W3DS_ONTOLOGY_BASE_URL — never W3DS_ONTOLOGY_BASE_URI)
#    Leave DATABASE_URL and unrelated keys unchanged.
#    Do not modify /etc/vidak.env.

# 3) Restart only vidak.service with the permitted helper
sudo vidakctl restart
sleep 2
sudo vidakctl status
```

Passwordless sudo for `vidak` remains limited to `/usr/local/bin/vidakctl`
(`start|stop|restart|status|logs`). No root/admin SSH path and no `vidak-envctl`
helper are required for this activation.

## Post-activation verification

```bash
# Service
systemctl is-active vidak.service   # expect: active

# Local health / login / private catalogue
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3910/api/health/live
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3910/api/health/ready
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3910/login
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3910/api/w3ds/ontology/schemas
# expect: 200 for each

# Public equivalents (optional)
curl -sS -o /dev/null -w '%{http_code}\n' https://vidak.postplatforms.com/login
curl -sS -o /dev/null -w '%{http_code}\n' https://vidak.postplatforms.com/api/w3ds/ontology/schemas
```

Non-secret catalogue checks (safe to print):

```bash
curl -sS http://127.0.0.1:3910/api/w3ds/ontology/schemas \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ownership=", d.get("ownership")); print("visibility=", d.get("visibility")); print("schema_ids=", [s.get("id") for s in d.get("schemas",[])])'
# expect: ownership=vidak_private, visibility=private,
# schema_ids include vidak:private:ontology:v1:{video,channel,playlist,comment}
```

Non-secret effective config check (source env without dumping secrets):

```bash
set -a
. /etc/vidak.env
. /srv/vidak/.env
set +a
# Print only the activation identifiers (not DATABASE_URL / JWT / etc.)
printf '%s\n' \
  "W3DS_ONTOLOGY_MODE=${W3DS_ONTOLOGY_MODE-}" \
  "W3DS_ONTOLOGY_ADAPTER_ENABLED=${W3DS_ONTOLOGY_ADAPTER_ENABLED-}" \
  "W3DS_ONTOLOGY_BASE_URL=${W3DS_ONTOLOGY_BASE_URL-}" \
  "W3DS_ONTOLOGY_SCHEMA_ID_PROFILE=${W3DS_ONTOLOGY_SCHEMA_ID_PROFILE-}" \
  "W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL=${W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL-}" \
  "W3DS_ONTOLOGY_SCHEMA_ID_VIDEO=${W3DS_ONTOLOGY_SCHEMA_ID_VIDEO-}"
```

Confirm `/etc/vidak.env` still has no private-adapter keys (names only; do not print values).

Channel/Video projection smoke: only if a **designated non-public** test Channel + Video already exists; otherwise skip. Do not backfill historical data. Do not test Playlist/Comment.

## Rollback (disable adapter; keep migration `0007`)

As `vidak` — disable sync without reversing schema and without touching `/etc/vidak.env`:

```bash
set -euo pipefail

cp -a /srv/vidak/.env /srv/vidak/.env.bak.pre-private-adapter-rollback
chmod 600 /srv/vidak/.env.bak.pre-private-adapter-rollback

# Preferred: set the enable gate to false (leave other private IDs in place)
sed -i 's/^W3DS_ONTOLOGY_ADAPTER_ENABLED=.*/W3DS_ONTOLOGY_ADAPTER_ENABLED=false/' /srv/vidak/.env

# Or restore the pre-activation backup if that is safer for your ops policy:
# cp -a /srv/vidak/.env.bak.pre-private-adapter-activation /srv/vidak/.env
# chmod 600 /srv/vidak/.env

sudo vidakctl restart
```

**Do not** drop tables `w3ds_private_adapter_projections` / `w3ds_private_adapter_outbox` or reverse migration `0007`.
