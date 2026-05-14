#!/usr/bin/env bash
# End-to-end local test of the auth slice:
#   1. Invoke Login to mint a fresh JWT
#   2. Splice the token into the authorize/valid.json template (via temp file)
#   3. Invoke JwtAuthorizer with the resulting event
#
# Run from repo root: ./scripts/test-auth.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Minting a token via Login..."
TOKEN=$(
  sam local invoke Login --config-env dev --event events/login/valid.json 2>/dev/null \
    | tail -1 \
    | jq -r '.body | fromjson | .token'
)

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "✗ Failed to mint a token. Run 'sam local invoke Login --config-env dev --event events/login/valid.json' on its own to see why."
  exit 1
fi

echo "→ Token minted, building authorize event..."
TMP_EVENT=$(mktemp /tmp/authorize.XXXXXX.json)
trap 'rm -f "$TMP_EVENT"' EXIT
sed "s|REPLACE_ME|$TOKEN|g" events/authorize/valid.json > "$TMP_EVENT"

echo "→ Invoking JwtAuthorizer..."
sam local invoke JwtAuthorizer --config-env dev --event "$TMP_EVENT" 2>/dev/null \
  | tail -1 \
  | jq
