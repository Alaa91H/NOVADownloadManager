#!/usr/bin/env bash
set -Eeuo pipefail

# NOVA offsite state backup.
# Mirrors durable server state (/var/lib/nova + repo .memory) to a private
# GitHub repository so a disk loss cannot erase operational history.
# Secrets are deliberately excluded: /etc/nova/nova.env never leaves the node.

VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
PROJECT_DIR="${NOVA_PROJECT_DIR:-/home/${SUDO_USER:-ubuntu}/NOVA}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
LOG_FILE="$LOG_DIR/nova-offsite-backup.log"
MIRROR="$VAR_DIR/offsite-mirror"
REPO="${NOVA_OFFSITE_REPO:-}"
ENABLED="${NOVA_OFFSITE_BACKUP_ENABLED:-1}"
CRED_FILE="${NOVA_OFFSITE_CRED_FILE:-/home/ubuntu/.git-credentials}"

mkdir -p "$LOG_DIR"
log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$LOG_FILE"; }

if [[ "$ENABLED" != "1" ]]; then
  log "disabled (NOVA_OFFSITE_BACKUP_ENABLED != 1)"
  exit 0
fi
if [[ -z "$REPO" ]]; then
  log "skipped: NOVA_OFFSITE_REPO is not set"
  exit 0
fi

GIT=(git -C "$MIRROR" -c "credential.helper=store --file $CRED_FILE" \
     -c user.name=nova-backup -c user.email=nova-backup@localhost \
     -c safe.directory="$MIRROR")

if [[ ! -d "$MIRROR/.git" ]]; then
  mkdir -p "$MIRROR"
  git init -q -b main "$MIRROR"
  log "initialized mirror at $MIRROR"
fi
"${GIT[@]}" remote remove origin >/dev/null 2>&1 || true
"${GIT[@]}" remote add origin "https://github.com/${REPO}.git"

# --- Collect state (small, text-first; heavy local backup tarballs excluded:
# the factory itself is recoverable from ops/nova-factory in the code repo) ---
mkdir -p "$MIRROR/var-lib-nova" "$MIRROR/repo-memory"
rsync -a --delete \
  --exclude 'offsite-mirror' \
  --exclude 'backups' \
  --exclude '*.lock' \
  --exclude 'restart-*' \
  "$VAR_DIR/" "$MIRROR/var-lib-nova/"
if [[ -d "$PROJECT_DIR/.memory" ]]; then
  rsync -a --delete "$PROJECT_DIR/.memory/" "$MIRROR/repo-memory/"
fi
printf '%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$MIRROR/LAST_SNAPSHOT"

"${GIT[@]}" add -A
if "${GIT[@]}" diff --cached --quiet; then
  log "no state changes since last snapshot"
  exit 0
fi
"${GIT[@]}" commit -q -m "state snapshot $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if "${GIT[@]}" push -q origin main; then
  log "snapshot pushed to $REPO"
else
  log "ERROR: push to $REPO failed"
  exit 1
fi
