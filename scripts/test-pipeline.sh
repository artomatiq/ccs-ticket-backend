#!/usr/bin/env bash
# End-to-end pipeline test using a real ticket fixture.
# Mints a ticket → uploads the fixture → polls for the chain to settle
# (presign → S3 → db-writer → validator → textract) → confirms the
# extracted ticket → reports the final state.
#
# Usage:
#   ./scripts/test-pipeline.sh <api-url> [stage] [fixture-path] [passcode]
#
# Defaults: stage=dev, fixture=first .jpg/.jpeg in fixtures/, passcode=vv01
# Override passcode via env (preferred for prod):
#   SMOKE_PASSCODE='realprodpass' ./scripts/test-pipeline.sh https://prod.example.com prod

set -euo pipefail

API="${1:?Usage: $0 <api-url> [stage] [fixture-path] [passcode]}"
STAGE="${2:-dev}"
FIXTURE="${3:-$(find fixtures -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.jpeg' \) 2>/dev/null | head -1)}"
PW="${4:-${SMOKE_PASSCODE:-vv01}}"

cd "$(dirname "$0")/.."

[[ -z "$FIXTURE" ]] && { echo "✗ No fixture provided and none found in fixtures/" >&2; exit 1; }
[[ ! -f "$FIXTURE" ]] && { echo "✗ Fixture not found: $FIXTURE" >&2; exit 1; }

ACCT=$(aws sts get-caller-identity --query Account --output text)
TABLE="dt-tickets-${STAGE}"
BUCKET="dt-ticket-images-${STAGE}-${ACCT}"

echo "Pipeline test against $API (stage=$STAGE)"
echo "Fixture: $FIXTURE ($(wc -c < "$FIXTURE" | tr -d ' ') bytes)"
echo

echo "→ Login..."
TOKEN=$(curl -s -X POST "$API/login" \
  -H 'content-type: application/json' \
  -d "$(jq -cn --arg pw "$PW" '{passcode: $pw}')" | jq -r '.token // empty')
[[ -z "$TOKEN" ]] && { echo "✗ Login failed" >&2; exit 1; }

echo "→ Mint ticket + get presigned URL..."
RESP=$(curl -s -X POST "$API/tickets" -H "Authorization: Bearer $TOKEN")
TID=$(echo "$RESP" | jq -r '.ticketId // empty')
URL=$(echo "$RESP" | jq -r '.uploadUrl // empty')
[[ -z "$TID" || -z "$URL" ]] && { echo "✗ Could not mint ticket: $RESP" >&2; exit 1; }
echo "  ticketId: $TID"

echo "→ PUT fixture to presigned URL..."
curl -s -X PUT --data-binary "@$FIXTURE" -H 'content-type: image/jpeg' "$URL" -o /dev/null

echo "→ Wait for pipeline to reach a terminal state (up to 60s)..."
STATUS=""
for i in $(seq 1 60); do
  STATUS=$(aws dynamodb get-item --table-name "$TABLE" \
    --key "{\"ticketId\":{\"S\":\"$TID\"}}" \
    --query 'Item.status.S' --output text 2>/dev/null || echo "")
  case "$STATUS" in
    extracted|rejected|failed) break ;;
  esac
  sleep 1
done

print_record() {
  aws dynamodb get-item --table-name "$TABLE" \
    --key "{\"ticketId\":{\"S\":\"$TID\"}}" --output json 2>/dev/null \
    | jq '.Item | {
        status: .status.S,
        ticketNumber: .ticketNumber.S,
        validatedKey: .validatedKey.S,
        statusMessage: .statusMessage.S,
        extractedData: (.extractedData.M // {} | with_entries(.value = (.value.S // .value.N // .value))),
        confirmedData: (.confirmedData.M // null),
        ticketDate: .ticketDate.S,
        timestamps: (.timestamps.M // {} | with_entries(.value = .value.N))
      }'
}

echo
echo "Dynamo record after pipeline:"
print_record

echo
case "$STATUS" in
  extracted)
    echo "→ Verifying validated/$TID.jpg in S3..."
    aws s3 ls "s3://$BUCKET/validated/$TID.jpg" \
      || { echo "✗ Status is extracted but S3 object missing" >&2; exit 1; }

    TICKET_NUMBER=$(aws dynamodb get-item --table-name "$TABLE" \
      --key "{\"ticketId\":{\"S\":\"$TID\"}}" \
      --query 'Item.ticketNumber.S' --output text 2>/dev/null || echo "")
    [[ -z "$TICKET_NUMBER" ]] && { echo "✗ No ticketNumber on record" >&2; exit 1; }

    echo "→ POST /tickets/$TID/confirm (ticketNumber=$TICKET_NUMBER)..."
    BODY=$(jq -cn --arg tn "$TICKET_NUMBER" '{ticketNumber: $tn, date: "2026-01-01", customerName: "Test Customer", jobName: "Test Job"}')
    CONFIRM_CODE=$(curl -s -o /tmp/pipeline-confirm.json -w '%{http_code}' \
      -X POST "$API/tickets/$TID/confirm" \
      -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "$BODY")
    if [[ "$CONFIRM_CODE" != "200" ]]; then
      echo "✗ Confirm failed: HTTP $CONFIRM_CODE" >&2
      cat /tmp/pipeline-confirm.json >&2
      rm -f /tmp/pipeline-confirm.json
      exit 1
    fi
    rm -f /tmp/pipeline-confirm.json

    FINAL=$(aws dynamodb get-item --table-name "$TABLE" \
      --key "{\"ticketId\":{\"S\":\"$TID\"}}" \
      --query 'Item.status.S' --output text 2>/dev/null || echo "")
    echo
    echo "Dynamo record after confirm:"
    print_record
    echo
    if [[ "$FINAL" == "confirmed" ]]; then
      echo "✓ Pipeline succeeded end-to-end (uploaded → validated → extracted → confirmed)"
    else
      echo "✗ Expected status 'confirmed', got '$FINAL'" >&2
      exit 1
    fi
    ;;
  rejected)
    echo "→ Verifying rejected/$TID.jpg in S3..."
    aws s3 ls "s3://$BUCKET/rejected/$TID.jpg" || true
    echo "⚠ Pipeline rejected the ticket (this may be expected for some fixtures)"
    ;;
  failed)
    echo "✗ Pipeline failed during extraction" >&2
    exit 1
    ;;
  *)
    echo "✗ Pipeline did not reach terminal state. Last status: '${STATUS:-<none>}'" >&2
    exit 1
    ;;
esac
