#!/usr/bin/env bash
# Push secrets/<stage>.env into SSM as SecureStrings. Idempotent — existing
# parameters are overwritten.
#
# Usage:
#   ./scripts/load-secrets.sh [stage]     (default: dev)
#
# File format (secrets/<stage>.env):
#   /ssm/path=value     one per line, '=' splits on first occurrence
#   # comments and blank lines ignored

set -euo pipefail

STAGE="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"

cd "$(dirname "$0")/.."

FILE="secrets/${STAGE}.env"
[[ ! -f "$FILE" ]] && { echo "✗ $FILE not found" >&2; exit 1; }

count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && continue

  if [[ "$line" != *=* ]]; then
    echo "✗ malformed line (no '='): $line" >&2
    continue
  fi

  name="${line%%=*}"
  value="${line#*=}"

  aws ssm put-parameter \
    --name "$name" --value "$value" \
    --type SecureString --overwrite \
    --region "$REGION" >/dev/null
  echo "✓ $name"
  count=$((count + 1))
done < "$FILE"

echo "Loaded $count parameter(s) into SSM ($REGION)."
