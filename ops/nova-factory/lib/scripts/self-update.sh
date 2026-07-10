#!/usr/bin/env bash
# NOVA Self-Update wrapper. The real implementation is nova-updater.py so all
# update paths share the same validation, backup, rollback, and logging policy.
set -euo pipefail

ACTION="${1:-apply}"
shift || true
UPDATER="${NOVA_UPDATER:-/usr/local/lib/nova/nova-updater.py}"
if [[ ! -x "$UPDATER" ]]; then
  echo "NOVA updater is not installed at $UPDATER" >&2
  exit 127
fi
exec "$UPDATER" "$ACTION" "$@"
