#!/usr/bin/env bash
set -euo pipefail

# Next.js inlines NEXT_PUBLIC_* values into the browser bundle during build.
# Runtime-only systemd environment files are therefore not sufficient for the
# web app: build from the same stage environment that will run the server.
env_file="${VIDAK_ENV_FILE:-.env}"

if [[ ! -r "$env_file" ]]; then
  echo "Production web build requires a readable VIDAK_ENV_FILE (received: $env_file)." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

if [[ -z "${AUTH_PROVIDER:-}" ]]; then
  echo 'Production web build requires AUTH_PROVIDER to be explicit.' >&2
  exit 1
fi

case "$AUTH_PROVIDER" in
  dev | w3ds) ;;
  *)
    echo 'AUTH_PROVIDER must be either "dev" or "w3ds".' >&2
    exit 1
    ;;
esac

# Mirror the provider only when the deployment environment deliberately omits
# the browser-safe duplicate. This prevents an accidental dev client bundle.
export NEXT_PUBLIC_AUTH_PROVIDER="${NEXT_PUBLIC_AUTH_PROVIDER:-$AUTH_PROVIDER}"
if [[ "$NEXT_PUBLIC_AUTH_PROVIDER" != "$AUTH_PROVIDER" ]]; then
  echo 'AUTH_PROVIDER and NEXT_PUBLIC_AUTH_PROVIDER must match for a web build.' >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  exec pnpm --filter @w3ds/web build
fi

if command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm --filter @w3ds/web build
fi

echo 'Production web build requires pnpm or Corepack on PATH.' >&2
exit 1
