#!/usr/bin/env bash
# NOVA controller self-update guard.
# Runs as ExecStartPre for nova-dev-agent. Prevents a bad self-edit from bricking
# the controller: if agent.sh is not syntactically valid, roll back to the last
# known-good snapshot; if it is valid, refresh the snapshot.
set -u

LIB=/usr/local/lib/nova
AGENT="$LIB/agent.sh"
GOOD="$LIB/agent.sh.lastgood"
LOG=/var/log/nova/nova-guard.log

mkdir -p /var/log/nova 2>/dev/null || true
ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

if [[ ! -f "$AGENT" ]]; then
  if [[ -f "$GOOD" ]]; then
    cp -f "$GOOD" "$AGENT"
    echo "[$(ts)] controller missing; restored from lastgood" >> "$LOG"
  fi
  exit 0
fi

if bash -n "$AGENT" 2>/dev/null; then
  # Current controller parses cleanly — snapshot it as the known-good version.
  cp -f "$AGENT" "$GOOD"
  echo "[$(ts)] controller ok; snapshot refreshed" >> "$LOG"
else
  # Broken self-edit — roll back so the service still starts.
  if [[ -f "$GOOD" ]]; then
    cp -f "$GOOD" "$AGENT"
    echo "[$(ts)] controller FAILED syntax check; rolled back to lastgood" >> "$LOG"
  else
    echo "[$(ts)] controller FAILED syntax check and no lastgood snapshot exists" >> "$LOG"
  fi
fi

exit 0
