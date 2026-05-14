#!/usr/bin/env bash
set -euo pipefail

# Tears down the entire dev environment: CloudFormation stack + retained
# DynamoDB tables + retained S3 bucket (including all object versions).
# Safe to re-run; treats already-gone resources as success.

read -p "Nuke ccs-ticket-backend-dev and all its retained resources? [y/N] " -n 1 -r
echo
[[ ! $REPLY =~ ^[Yy]$ ]] && { echo "Aborted."; exit 1; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="dt-ticket-images-dev-${ACCOUNT_ID}"
REGION="us-east-1"

echo "→ Deleting CloudFormation stack ccs-ticket-backend-dev..."
sam delete --config-env dev --no-prompts || true

empty_versioned_bucket() {
  local bucket=$1
  local kind=$2  # "Versions" or "DeleteMarkers"
  local payload
  payload=$(aws s3api list-object-versions --bucket "$bucket" --region "$REGION" \
    --output json --query "{Objects: ${kind}[].{Key:Key,VersionId:VersionId}}" 2>/dev/null || echo '{"Objects":null}')
  if [[ $(echo "$payload" | jq '.Objects | length // 0') -gt 0 ]]; then
    aws s3api delete-objects --bucket "$bucket" --region "$REGION" --delete "$payload" >/dev/null
  fi
}

if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "→ Emptying s3://${BUCKET} (object versions + delete markers)..."
  empty_versioned_bucket "$BUCKET" "Versions"
  empty_versioned_bucket "$BUCKET" "DeleteMarkers"
  echo "→ Deleting bucket s3://${BUCKET}..."
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
else
  echo "→ Bucket s3://${BUCKET} already gone, skipping."
fi

for table in dt-tickets-dev dt-ticket-numbers-dev; do
  if aws dynamodb describe-table --table-name "$table" --region "$REGION" >/dev/null 2>&1; then
    echo "→ Deleting DynamoDB table ${table}..."
    aws dynamodb delete-table --table-name "$table" --region "$REGION" >/dev/null
  else
    echo "→ Table ${table} already gone, skipping."
  fi
done

echo "✓ Dev environment nuked."
