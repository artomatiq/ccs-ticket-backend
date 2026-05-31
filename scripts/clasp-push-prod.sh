#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps-script"
cp .clasp.prod.json .clasp.json
clasp push
cp .clasp.dev.json .clasp.json
