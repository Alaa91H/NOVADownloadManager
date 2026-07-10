#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(pwd)}"
cd "$ROOT"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests
