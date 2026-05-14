#!/usr/bin/env bash
# Smoke test the deployed API end-to-end via real HTTP requests.
# Verifies routing, authorizer wiring, IAM, and handler behavior.
#
# Usage:
#   ./scripts/smoke.sh <api-url> [passcode]
#
# Pass passcode via env var (preferred for prod, keeps it out of shell history):
#   SMOKE_PASSCODE='realprodpass' ./scripts/smoke.sh https://prod.example.com

set -euo pipefail

API="${1:?Usage: $0 <api-url> [passcode]}"
PW="${2:-${SMOKE_PASSCODE:-vv01}}"
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
check() {
  local label=$1 want=$2 got=$3
  if [[ "$got" == "$want" ]]; then
    echo "  ✓ $label → $got"; PASS=$((PASS+1))
  else
    echo "  ✗ $label → got $got, want $want"; FAIL=$((FAIL+1))
  fi
}

echo "Smoke testing $API"
echo

echo "→ POST /login (valid passcode)"
BODY=$(jq -cn --arg pw "$PW" '{passcode: $pw}')
CODE=$(curl -s -o /tmp/smoke.json -w '%{http_code}' -X POST "$API/login" \
  -H 'content-type: application/json' -d "$BODY")
check "/login valid" "200" "$CODE"
TOKEN=$(jq -r '.token // empty' /tmp/smoke.json)

echo "→ POST /login (invalid passcode)"
BODY=$(jq -r .body events/login/invalid-passcode.json)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/login" \
  -H 'content-type: application/json' -d "$BODY")
check "/login invalid" "401" "$CODE"

echo "→ POST /login (missing body)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/login" \
  -H 'content-type: application/json')
check "/login no-body" "400" "$CODE"

echo "→ POST /tickets (no auth)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/tickets")
check "/tickets no-auth" "401" "$CODE"

echo "→ POST /tickets (malformed token)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/tickets" \
  -H 'authorization: Bearer not.a.real.token')
check "/tickets malformed-token" "403" "$CODE"

echo "→ POST /tickets (invalid signature token)"
BAD_TOKEN='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoidnYwMSIsImlhdCI6MTQwMDAwMDAwMCwiZXhwIjoxNDAwMDAwMzYwfQ.invalidsignaturejusttomarkthistokenshapecorrectly'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/tickets" \
  -H "authorization: Bearer $BAD_TOKEN")
check "/tickets bad-token" "403" "$CODE"

if [[ -n "$TOKEN" ]]; then
  echo "→ POST /tickets (with auth)"
  CODE=$(curl -s -o /tmp/smoke.json -w '%{http_code}' -X POST "$API/tickets" \
    -H "authorization: Bearer $TOKEN")
  check "/tickets auth" "200" "$CODE"
  TID=$(jq -r '.ticketId // empty' /tmp/smoke.json)
  [[ -n "$TID" ]] && echo "  → ticketId: $TID"
fi

rm -f /tmp/smoke.json
echo
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
