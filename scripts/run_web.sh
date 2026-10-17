#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env ]]; then set -a; source .env; set +a; fi
mkdir -p web/dist/media media-library
exec .venv/bin/python app.py
