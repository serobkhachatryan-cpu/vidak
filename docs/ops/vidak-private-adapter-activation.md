# Vidak-private adapter sync — production activation handoff

**Audience:** host root administrator  
**Scope:** enable Vidak-private Channel/Video adapter sync on production  
**Deployed code (required):** `f9b07b94216bd2e6dcbeced4f245c08650402da7`  
**Env file to edit:** `/etc/vidak.env` only  
**Service to restart:** `vidak.service` only (via `sudo vidakctl restart`)

## Warning — out of scope (must not be enabled)

This activation is **platform-local Vidak-private sync only**. Do **not**:

- set `W3DS_ONTOLOGY_MODE=metastate_official`
- point `W3DS_ONTOLOGY_BASE_URL` at MetaState Ontology (`https://ontology.w3ds.metastate.foundation` or any remote Ontology)
- enable platform eVault provisioning / MetaState eVault writes
- enable webhooks, Awareness, or ACL federation
- enable remote W3DS / `w3ds://file` upload calls
- run historical backfill or replay of existing Channel/Video rows
- enable Playlist or Comment product sync (not in this release)
- modify `DATABASE_URL` or unrelated keys in `/etc/vidak.env` or `/srv/vidak/.env`
- reverse or drop migration `0007` (`w3ds_private_adapter_projections` / `w3ds_private_adapter_outbox`) on rollback

Existing `ONTOLOGY_BASE_URL` in `/srv/vidak/.env` (MetaState) is a **different** key and must be left unchanged. Private sync uses `W3DS_ONTOLOGY_BASE_URL` only.

## Why Cursor cannot apply this change today

SSH user `vidak` can **read** `/etc/vidak.env` (`root:vidak` mode `640`) but **cannot write** it.  
Passwordless sudo for `vidak` is limited to `/usr/local/bin/vidakctl` (`start|stop|restart|status|logs`).  

Do **not** grant broad NOPASSWD for `cp`, `tee`, shell, or arbitrary file editing.

## Exact non-secret settings (already dry-load verified)

Append **only** these lines to `/etc/vidak.env` (values are non-secret identifiers):

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
| `W3DS_ONTOLOGY_BASE_URL` | `https://vidak.postplatforms.com/api/w3ds/ontology` | Local private catalogue (not MetaState) |
| `W3DS_ONTOLOGY_SCHEMA_ID_PROFILE` | `schema-profile-local` | Required by config loader; Profile is not in the private catalogue; Channel/Video sync does not use this ID |
| `W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL` | `vidak:private:ontology:v1:channel` | Private catalogue ID |
| `W3DS_ONTOLOGY_SCHEMA_ID_VIDEO` | `vidak:private:ontology:v1:video` | Private catalogue ID |

Omit `W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST` / `W3DS_ONTOLOGY_SCHEMA_ID_COMMENT` (code defaults to private IDs; no product sync hooks in this release).  
Do not set `W3DS_ADAPTER_MAPPING_VERSION` unless intentionally changing it (default `1`).

Dry-load result with the above: `ontologyMode=vidak_private`, `privateAdapterSyncEnabled=true`, domain schema IDs all `vidak:private:ontology:v1:*`.

## Root-admin-only activation sequence

Run as **root** on the production host (or via an interactive root shell). Do not print `/etc/vidak.env` contents to shared logs.

```bash
set -euo pipefail

# 1) Protected backup (do not cat / print the file)
cp -a /etc/vidak.env /etc/vidak.env.bak.pre-private-adapter-activation
chmod 640 /etc/vidak.env.bak.pre-private-adapter-activation
chown root:vidak /etc/vidak.env.bak.pre-private-adapter-activation

# 2) Refuse if already activated
if grep -q '^W3DS_ONTOLOGY_ADAPTER_ENABLED=' /etc/vidak.env; then
  echo 'STOP: W3DS_ONTOLOGY_ADAPTER_ENABLED already present in /etc/vidak.env' >&2
  exit 1
fi

# 3) Append only the verified private-adapter settings
cat >> /etc/vidak.env <<'EOF'

# Vidak-private adapter sync activation (platform-local only).
# Does not enable MetaState official catalogue, eVault, webhooks, ACL, or remote W3DS calls.
W3DS_ONTOLOGY_MODE=vidak_private
W3DS_ONTOLOGY_ADAPTER_ENABLED=true
W3DS_ONTOLOGY_BASE_URL=https://vidak.postplatforms.com/api/w3ds/ontology
W3DS_ONTOLOGY_SCHEMA_ID_PROFILE=schema-profile-local
W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL=vidak:private:ontology:v1:channel
W3DS_ONTOLOGY_SCHEMA_ID_VIDEO=vidak:private:ontology:v1:video
EOF

# 4) Restart only vidak.service
/usr/local/bin/vidakctl restart
sleep 2
/usr/local/bin/vidakctl status
```

## Post-activation verification

From the host (or any client that can reach the app):

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

Channel/Video projection smoke: only if a **documented non-public** test Channel + Video already exists; otherwise skip. Do not backfill historical data. Do not test Playlist/Comment.

## Rollback (disable adapter; keep migration `0007`)

As root — disable sync without reversing schema:

```bash
set -euo pipefail

cp -a /etc/vidak.env /etc/vidak.env.bak.pre-private-adapter-rollback

# Preferred: set the enable gate to false (leave other private IDs in place)
sed -i 's/^W3DS_ONTOLOGY_ADAPTER_ENABLED=.*/W3DS_ONTOLOGY_ADAPTER_ENABLED=false/' /etc/vidak.env

# Or restore the pre-activation backup if that is safer for your ops policy:
# cp -a /etc/vidak.env.bak.pre-private-adapter-activation /etc/vidak.env
# chown root:vidak /etc/vidak.env
# chmod 640 /etc/vidak.env

/usr/local/bin/vidakctl restart
```

**Do not** drop tables `w3ds_private_adapter_projections` / `w3ds_private_adapter_outbox` or reverse migration `0007`.

## Narrow capability for Cursor to perform activation later

If Cursor should apply this change in a future session, grant **only** one of the following — **not** broad NOPASSWD for `cp`/`tee`/shell/arbitrary edits:

1. **Preferred:** a dedicated root-owned helper, e.g. `/usr/local/bin/vidak-envctl`, with a fixed allowlist such as:
   - `backup` → copy `/etc/vidak.env` to a fixed backup path
   - `activate-private-adapter` → append **exactly** the verified block above (idempotent / refuse if already set)
   - `disable-private-adapter` → set `W3DS_ONTOLOGY_ADAPTER_ENABLED=false` only  
   and sudoers: `(root) NOPASSWD: /usr/local/bin/vidak-envctl` for user `vidak`
2. **Alternative:** one interactive root session / admin applies the sequence in this document, then Cursor continues with verification via existing `vidak` + `vidakctl` access

Do **not** grant `NOPASSWD` for unrestricted `/bin/cp`, `/usr/bin/tee`, `/bin/bash`, or write access to arbitrary paths under `/etc`.
