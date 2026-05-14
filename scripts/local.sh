#!/usr/bin/env bash
# Wrapper around `sam local invoke`. Auto-loads env-vars.<stage>.json.
# Event path can be relative to events/ (e.g. "login/valid.json") or full.
#
# Usage:
#   ./scripts/local.sh <function-logical-id> <event-path> [stage]
#
# Examples:
#   ./scripts/local.sh Login login/valid.json
#   ./scripts/local.sh TicketTextract eventbridge/ticket-validated.json
#   ./scripts/local.sh TicketValidator eventbridge/ticket-uploaded.json prod

set -euo pipefail

FN="${1:?Usage: $0 <function-logical-id> <event-path> [stage]}"
EVENT="${2:?Usage: $0 <function-logical-id> <event-path> [stage]}"
STAGE="${3:-dev}"

cd "$(dirname "$0")/.."

# Allow shorthand event paths (no "events/" prefix needed)
[[ ! -f "$EVENT" && -f "events/$EVENT" ]] && EVENT="events/$EVENT"
[[ ! -f "$EVENT" ]] && { echo "✗ Event file not found: $EVENT" >&2; exit 1; }

ENV_FILE="env-vars.${STAGE}.json"
[[ ! -f "$ENV_FILE" ]] && { echo "✗ $ENV_FILE not found" >&2; exit 1; }

sam local invoke "$FN" --config-env "$STAGE" \
  --event "$EVENT" --env-vars "$ENV_FILE"
