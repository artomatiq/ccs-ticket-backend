#!/usr/bin/env bash
# End-to-end pipeline test using a real ticket fixture.
# Mints a ticket → uploads the fixture → polls for the chain to settle
# (presign → S3 → db-writer → validator → textract) → confirms the
# extracted ticket → waits for sheets-writer → generates invoice as admin
# → reports the final state.
#
# Usage:
#   ./scripts/test-pipeline.sh [api-url] [stage] [fixture-path] [passcode] [admin-passcode]
#
# Defaults: api-url=auto-fetched from CloudFormation, stage=dev, fixture=first .jpg/.jpeg in fixtures/, passcode=vv01, admin-passcode=admin
# Override passcodes via env (preferred for prod):
#   SMOKE_PASSCODE='realprodpass' ADMIN_PASSCODE='realadminpass' ./scripts/test-pipeline.sh https://prod.example.com prod

set -euo pipefail

STAGE="${2:-dev}"

if [[ -n "${1:-}" ]]; then
  API="$1"
else
  API=$(aws cloudformation describe-stacks --stack-name "dt-backend-${STAGE}" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
    --output text 2>/dev/null)
  [[ -z "$API" ]] && { echo "✗ Could not resolve API URL from CloudFormation stack dt-backend-${STAGE}" >&2; exit 1; }
  echo "→ Resolved API URL from CloudFormation: $API"
fi
FIXTURE="${3:-$(find fixtures -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.jpeg' \) 2>/dev/null | head -1)}"
PW="${4:-${SMOKE_PASSCODE:-vv01}}"
ADMIN_PW="${5:-${ADMIN_PASSCODE:-admin}}"

cd "$(dirname "$0")/.."

[[ -z "$FIXTURE" ]] && { echo "✗ No fixture provided and none found in fixtures/" >&2; exit 1; }
[[ ! -f "$FIXTURE" ]] && { echo "✗ Fixture not found: $FIXTURE" >&2; exit 1; }

ACCT=$(aws sts get-caller-identity --query Account --output text)
TABLE="dt-tickets-${STAGE}"
NUMBER_TABLE="dt-ticket-numbers-${STAGE}"
BUCKET="dt-ticket-images-${STAGE}-${ACCT}"
TICKET_NUMBER=""

cleanup() {
  echo "→ Cleaning up Dynamo + S3 artifacts for $TID..."
  aws dynamodb delete-item --table-name "$TABLE" \
    --key "{\"ticketId\":{\"S\":\"$TID\"}}" >/dev/null 2>&1 || true
  if [[ -n "$TICKET_NUMBER" ]]; then
    aws dynamodb delete-item --table-name "$NUMBER_TABLE" \
      --key "{\"ticketNumber\":{\"S\":\"$TICKET_NUMBER\"}}" >/dev/null 2>&1 || true
  fi
  aws s3 rm "s3://$BUCKET/raw/$TID.jpg" 2>/dev/null || true
  aws s3 rm "s3://$BUCKET/validated/$TID.jpg" 2>/dev/null || true
  aws s3 rm "s3://$BUCKET/rejected/$TID.jpg" 2>/dev/null || true
  echo "  cleaned: ticket row, number row, raw/validated/rejected S3 objects"
  echo "  ⚠ Sheet row and Drive PDF not cleaned — remove manually from Google Sheets and Drive"
}

echo "Pipeline test against $API (stage=$STAGE)"
echo "Fixture: $FIXTURE ($(wc -c < "$FIXTURE" | tr -d ' ') bytes)"
echo

echo "→ Login (driver)..."
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
        invoiceId: .invoiceId.S,
        invoicePdfUrl: .invoicePdfUrl.S,
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

    EXTRACTED=$(aws dynamodb get-item --table-name "$TABLE" \
      --key "{\"ticketId\":{\"S\":\"$TID\"}}" --output json 2>/dev/null \
      | jq '.Item.extractedData.M // {} | with_entries(.value = .value.S)')
    TICKET_NUMBER=$(echo "$EXTRACTED" | jq -r '.ticketNumber // empty')
    [[ -z "$TICKET_NUMBER" ]] && { echo "✗ No ticketNumber on record" >&2; exit 1; }

    echo "→ POST /tickets/$TID/confirm (ticketNumber=$TICKET_NUMBER)..."
    TODAY_DATE="$(date +'%m/%d/%Y')"
    TODAY_DAY="$(date +'%A')"
    BODY=$(echo "$EXTRACTED" | jq -c \
      --arg date "$TODAY_DATE" --arg day "$TODAY_DAY" '
      . + {
        date:         $date,
        day:          $day,
        customerName: (.customerName // "" | if . == "" then "Placeholder Customer" else . end),
        jobName:      (.jobName      // "" | if . == "" then "Placeholder Job"      else . end),
        start:        (.start        // "" | if . == "" then "08:00"                else . end),
        stop:         (.stop         // "" | if . == "" then "21:00"                else . end),
        truckNo:      "VV01"
      }')
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

    echo "→ Wait for sheets-writer to populate (up to 30s)..."
    FINAL=""
    for i in $(seq 1 30); do
      FINAL=$(aws dynamodb get-item --table-name "$TABLE" \
        --key "{\"ticketId\":{\"S\":\"$TID\"}}" \
        --query 'Item.status.S' --output text 2>/dev/null || echo "")
      case "$FINAL" in
        populated|failed) break ;;
      esac
      sleep 1
    done

    echo
    echo "Dynamo record after confirm + populate:"
    print_record
    echo
    case "$FINAL" in
      populated)
        echo "✓ Pipeline reached populated"
        echo

        echo "→ Login (admin)..."
        ADMIN_TOKEN=$(curl -s -X POST "$API/login" \
          -H 'content-type: application/json' \
          -d "$(jq -cn --arg pw "$ADMIN_PW" '{passcode: $pw}')" | jq -r '.token // empty')
        [[ -z "$ADMIN_TOKEN" ]] && { echo "✗ Admin login failed" >&2; exit 1; }

        ISO_DATE="$(date +'%Y-%m-%d')"
        echo "→ POST /invoices (ticketId=$TID, date=$ISO_DATE)..."
        INVOICE_CODE=$(curl -s -o /tmp/pipeline-invoice.json -w '%{http_code}' \
          -X POST "$API/invoices" \
          -H "Authorization: Bearer $ADMIN_TOKEN" \
          -H 'content-type: application/json' \
          -d "$(jq -cn --arg date "$ISO_DATE" --argjson ids "[\"$TID\"]" '{date: $date, ticketIds: $ids}')")
        if [[ "$INVOICE_CODE" != "200" ]]; then
          echo "✗ Invoice generation failed: HTTP $INVOICE_CODE" >&2
          cat /tmp/pipeline-invoice.json >&2
          rm -f /tmp/pipeline-invoice.json
          exit 1
        fi
        INVOICE_ID=$(jq -r '.invoiceId // empty' /tmp/pipeline-invoice.json)
        PDF_URL=$(jq -r '.pdfUrl // empty' /tmp/pipeline-invoice.json)
        MESSAGES=$(jq -r '.messages // [] | join(", ")' /tmp/pipeline-invoice.json)
        rm -f /tmp/pipeline-invoice.json

        [[ -z "$INVOICE_ID" || -z "$PDF_URL" ]] && { echo "✗ Invoice response missing invoiceId or pdfUrl" >&2; exit 1; }

        INVOICE_STATUS=$(aws dynamodb get-item --table-name "$TABLE" \
          --key "{\"ticketId\":{\"S\":\"$TID\"}}" \
          --query 'Item.status.S' --output text 2>/dev/null || echo "")
        [[ "$INVOICE_STATUS" != "invoiced" ]] && { echo "✗ DynamoDB status not invoiced after invoice generation: $INVOICE_STATUS" >&2; exit 1; }

        echo
        echo "Dynamo record after invoice:"
        print_record
        echo
        echo "✓ Pipeline succeeded end-to-end (uploaded → validated → extracted → confirmed → populated → invoiced)"
        echo "  invoiceId: $INVOICE_ID"
        echo "  pdfUrl:    $PDF_URL"
        [[ -n "$MESSAGES" ]] && echo "  messages:  $MESSAGES"
        echo
        echo "  ⚠ Sheet row and Drive PDF not cleaned — remove manually from Google Sheets and Drive"
        echo
        cleanup
        ;;
      failed)
        echo "✗ Sheets-writer marked the ticket as 'failed'" >&2
        exit 1
        ;;
      confirmed)
        echo "✗ Status stuck at 'confirmed' — sheets-writer likely didn't fire (check SQS pipe + Lambda logs)" >&2
        exit 1
        ;;
      *)
        echo "✗ Unexpected status after confirm: '${FINAL:-<none>}'" >&2
        exit 1
        ;;
    esac
    ;;
  rejected)
    echo "→ Verifying rejected/$TID.jpg in S3..."
    aws s3 ls "s3://$BUCKET/rejected/$TID.jpg" || true
    echo "⚠ Pipeline rejected the ticket (this may be expected for some fixtures)"
    echo
    cleanup
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
