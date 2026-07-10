#!/usr/bin/env bash
set -uo pipefail

# NOVA Self-Maintenance v6
# Daily cleanup, service health check, and short report.

PROJECT_DIR="${NOVA_PROJECT_DIR:-${HOME:-/home/${SUDO_USER:-ubuntu}}/NOVA}"
VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
LOG_FILE="$LOG_DIR/nova-maintenance.log"
TARGET_USER="${NOVA_TARGET_USER:-}"
if [[ -z "$TARGET_USER" && -d "$PROJECT_DIR" ]]; then
  TARGET_USER="$(stat -c '%U' "$PROJECT_DIR" 2>/dev/null || true)"
fi
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "UNKNOWN" ]]; then
  TARGET_USER="${SUDO_USER:-ubuntu}"
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6 2>/dev/null || true)"
TARGET_HOME="${TARGET_HOME:-${HOME:-/home/$TARGET_USER}}"
BACKUP_DIR="${NOVA_BACKUP_DIR:-$TARGET_HOME/backups}"
CHATS_FILE="${NOVA_CHATS_FILE:-$VAR_DIR/bot-chats.json}"
NOTIF_FILE="${NOVA_NOTIF_FILE:-$VAR_DIR/notif-prefs.json}"
if [[ ! -s "$CHATS_FILE" && -s "$PROJECT_DIR/.bot-chats.json" ]]; then
  CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
fi
if [[ ! -s "$NOTIF_FILE" && -s "$PROJECT_DIR/.notif-prefs.json" ]]; then
  NOTIF_FILE="$PROJECT_DIR/.notif-prefs.json"
fi
NOTIF_LAST="$VAR_DIR/.notif-last-maint.json"

mkdir -p "$VAR_DIR" "$LOG_DIR" "$BACKUP_DIR"
touch "$LOG_FILE"

LEASE_BIN="${NOVA_LEASE_BIN:-/usr/local/lib/nova/nova-lease.py}"
if [[ -x "$LEASE_BIN" ]]; then
  if "$LEASE_BIN" should-defer maintenance --reason "scheduled maintenance waits for active critical work" --command /usr/local/lib/nova/scripts/maintenance.sh >/tmp/nova-maintenance-lease.json 2>/dev/null; then
    :
  else
    rc=$?
    if [[ "$rc" == "75" ]]; then
      printf '[%s] maintenance deferred because a critical lease is active\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$LOG_FILE"
      exit 0
    fi
  fi
fi
chown "$TARGET_USER:$TARGET_USER" "$BACKUP_DIR" 2>/dev/null || true

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE"
}

send_report() {
  local message="$1"
  local now
  now="$(date +%s)"
  if [[ -z "${NOVA_BOT_TOKEN:-}" || ! -s "$CHATS_FILE" ]]; then
    return 0
  fi
  if [[ -s "$NOTIF_LAST" ]]; then
    if python3 - "$NOTIF_LAST" "$message" "$now" <<'PY' 2>/dev/null; then
import json
import sys
last = json.load(open(sys.argv[1], "r", encoding="utf-8"))
message = sys.argv[2]
now = int(sys.argv[3])
raise SystemExit(0 if last.get("text") == message and now - int(last.get("ts", 0)) < 3600 else 1)
PY
      log "report suppressed by cooldown"
      return 0
    fi
  fi

  local chat_ids
  chat_ids=$(python3 - "$CHATS_FILE" "$NOTIF_FILE" <<'PY' 2>/dev/null || true
import json
import os
import sys
try:
    chats = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    prefs = json.load(open(sys.argv[2], "r", encoding="utf-8")) if os.path.exists(sys.argv[2]) else {}
    keys = chats.keys() if isinstance(chats, dict) else chats
    result = []
    for cid in keys:
        if prefs.get(str(cid), {}).get("maintenance", True):
            result.append(str(cid))
    print(" ".join(result))
except Exception:
    pass
PY
)
  for cid in $chat_ids; do
    curl -fsS -X POST "https://api.telegram.org/bot${NOVA_BOT_TOKEN}/sendMessage" \
      -d "chat_id=$cid" \
      -d "text=NOVA maintenance: $message" \
      -d "disable_notification=true" >/dev/null 2>&1 || true
  done
  python3 - "$NOTIF_LAST" "$message" "$now" <<'PY' 2>/dev/null || true
import json
import sys
json.dump({"ts": int(sys.argv[3]), "text": sys.argv[2]}, open(sys.argv[1], "w", encoding="utf-8"))
PY
}

log "maintenance started"

if [[ -d "$PROJECT_DIR/node_modules/.cache" ]]; then
  rm -rf "$PROJECT_DIR/node_modules/.cache" 2>/dev/null && log "cleared node_modules cache"
fi
find "$PROJECT_DIR" -path "$PROJECT_DIR/.git" -prune -o -type d -name coverage -mtime +7 -exec rm -rf {} + 2>/dev/null || true
if [[ -d "$PROJECT_DIR/dist" ]]; then
  rm -rf "$PROJECT_DIR/dist" 2>/dev/null && log "removed stale dist"
fi
if [[ "${NOVA_ENABLE_LOCAL_BUILDTOOLS:-0}" == "1" ]] && command -v pnpm >/dev/null 2>&1; then
  sudo -u "$TARGET_USER" env HOME="$TARGET_HOME" PATH="$TARGET_HOME/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin" pnpm store prune >> "$LOG_FILE" 2>&1 || true
else
  log "skipped pnpm store prune (orchestrator-only default)"
fi

find "$LOG_DIR" -type f -name 'nova-*.log' -size +50M -exec sh -c 'tail -n 5000 "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \; 2>/dev/null || true
find "$LOG_DIR" -type f -name 'nova-*.log.*.gz' -mtime +30 -delete 2>/dev/null || true
journalctl --vacuum-time=7d >/dev/null 2>&1 || true

service_issues=""
for service in nova-dev-agent.service nova-monitor.service nova-bot.service nova-watchdog.timer; do
  status="$(systemctl is-active "$service" 2>/dev/null || echo inactive)"
  if [[ "$status" != "active" ]]; then
    systemctl restart "$service" >> "$LOG_FILE" 2>&1 || systemctl start "$service" >> "$LOG_FILE" 2>&1 || true
    service_issues="$service_issues $service:$status"
  fi
done

cd "$PROJECT_DIR" || exit 0
git fsck --no-dangling >> "$LOG_FILE" 2>&1 || true
uncommitted=""
if [[ -n "$(git status --porcelain)" ]]; then
  uncommitted="$(git status --porcelain | wc -l | tr -d ' ')"
  log "repository has $uncommitted uncommitted paths"
fi

install -o "$TARGET_USER" -g "$TARGET_USER" -m 0640 "$PROJECT_DIR/Plan.md" "$BACKUP_DIR/Plan.md.$(date -u '+%Y%m%d')" 2>/dev/null || true
if [[ -f "$VAR_DIR/.agent-state.json" ]]; then
  install -o "$TARGET_USER" -g "$TARGET_USER" -m 0640 "$VAR_DIR/.agent-state.json" "$BACKUP_DIR/controller-state.$(date -u '+%Y%m%d').json" 2>/dev/null || true
fi
find "$BACKUP_DIR" -name 'Plan.md.*' -mtime +14 -delete 2>/dev/null || true
find "$BACKUP_DIR" -name 'controller-state.*.json' -mtime +14 -delete 2>/dev/null || true

disk="$(df -h / | awk 'NR==2{print $5 " of " $2}')"
mem="$(free -m | awk 'NR==2{printf "%dMB/%dMB", $3, $2}')"
report="disk=$disk mem=$mem"
[[ -n "$service_issues" ]] && report="$report restarted=$service_issues"
[[ -n "$uncommitted" ]] && report="$report uncommitted=$uncommitted"

log "maintenance finished: $report"
send_report "$report"
exit 0
