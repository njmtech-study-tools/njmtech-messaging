#!/usr/bin/env bash
# Creates an Android release keystore and prints the values to store as GitHub secrets.
# Keep the .jks file and passwords somewhere safe: every update must be signed with the SAME key.
set -euo pipefail
OUT="${1:-ephemeral-release.jks}"
ALIAS="${ANDROID_KEY_ALIAS:-ephemeral}"
[ -e "$OUT" ] && { echo "$OUT already exists — refusing to overwrite" >&2; exit 1; }
read -rsp "Keystore password (min 6 chars): " PASS; echo
keytool -genkeypair -v -keystore "$OUT" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=Ephemeral, O=NJM Tech, C=ZA"
echo
echo "Add these repository secrets (Settings › Secrets and variables › Actions):"
echo "  ANDROID_KEYSTORE_BASE64   = output of: base64 -w0 $OUT"
echo "  ANDROID_KEYSTORE_PASSWORD = <the password you typed>"
echo "  ANDROID_KEY_ALIAS         = $ALIAS"
echo "  ANDROID_KEY_PASSWORD      = <the password you typed>"
