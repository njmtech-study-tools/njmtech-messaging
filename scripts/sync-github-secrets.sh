#!/usr/bin/env bash
# Copies this app's prod secrets from Infisical (env-vault › /njmtech-messaging) to GitHub Actions.
# Infisical is the source of truth; GitHub holds a copy. Values are piped, never printed.
#   scripts/sync-github-secrets.sh          # sync every key below that exists in Infisical
#   scripts/sync-github-secrets.sh -n       # dry run: show which keys would be synced
set -euo pipefail
cd "$(dirname "$0")/.."

SECRETS=(
  CLOUDFLARE_API_TOKEN
  ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD
  GOOGLE_SERVICES_JSON
  RESEND_API_KEY FCM_SERVICE_ACCOUNT
  WIN_CSC_LINK WIN_CSC_KEY_PASSWORD
)
VARIABLES=(API_URL EMAIL_FROM)

DRY=0; [ "${1:-}" = "-n" ] && DRY=1
have=$(infisical secrets --env=prod --silent -o json | python3 -c 'import json,sys;print("\n".join(s["secretKey"] for s in json.load(sys.stdin)))')

sync() { # kind name
  if ! grep -qx "$2" <<<"$have"; then echo "skip    $2 (not in Infisical)"; return; fi
  if [ $DRY = 1 ]; then echo "would   $2 ($1)"; return; fi
  infisical secrets get "$2" --env=prod --plain --silent | gh "$1" set "$2"
  echo "synced  $2 ($1)"
}
for k in "${SECRETS[@]}"; do sync secret "$k"; done
for k in "${VARIABLES[@]}"; do sync variable "$k"; done
