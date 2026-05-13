#!/usr/bin/env bash
# End-to-end local test of the auth slice:
#   1. Invoke Login to mint a fresh JWT
#   2. Splice the token into the authorize.json template
#   3. Invoke JwtAuthorizer with the resulting event
#
# Run from repo root: ./scripts/test-auth.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ Minting a token via Login..."
TOKEN=$(
  sam local invoke Login --event events/login.local.json 2>/dev/null \
    | tail -1 \
    | jq -r '.body | fromjson | .token'
)

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "✗ Failed to mint a token. Run 'sam local invoke Login --event events/login.local.json' on its own to see why."
  exit 1
fi

echo "→ Token minted, building authorize.local.json..."
sed "s|REPLACE_ME|$TOKEN|g" events/authorize.json > events/authorize.local.json

echo "→ Invoking JwtAuthorizer..."
sam local invoke JwtAuthorizer --event events/authorize.local.json 2>/dev/null \
  | tail -1 \
  | jq
