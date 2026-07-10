#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(pwd)}"
OUT="${2:-$ROOT/dist}"
VERSION="${3:-}"
cmd=("$ROOT/lib/nova-release.py" package --path "$ROOT" --output-dir "$OUT")
if [[ -n "$VERSION" ]]; then
  cmd+=(--version "$VERSION")
fi
exec "${cmd[@]}"
