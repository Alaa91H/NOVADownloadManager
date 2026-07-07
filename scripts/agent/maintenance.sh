#!/usr/bin/env bash
# =============================================================
#  NOVA Self-Maintenance
#  Run via systemd timer or manually
#  Cleans, audits, backs up, reports — ONE notification only
# =============================================================
set -euo pipefail

PROJECT_DIR="/home/ubuntu/NOVA"
LOG_FILE="/var/log/nova-maintenance.log"
BACKUP_DIR="/home/ubuntu/backups"
CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
NOTIF_FILE="$PROJECT_DIR/.notif-prefs.json"
NOTIF_LAST="$PROJECT_DIR/.notif-last-maint.json"
BOT_TOKEN="${NOVA_BOT_TOKEN:-8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY}"

log() {
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] $*" | tee -a "$LOG_FILE"
}

send_report() {
  local message="$1"
  local now
  now=$(date +%s)

  if [ ! -f "$CHATS_FILE" ]; then return; fi

  # Cooldown: only send if last report was > 1hr ago OR content changed
  if [ -f "$NOTIF_LAST" ]; then
    local skip
    skip=$(python3 -c "
import json, sys
try:
    last = json.load(open('$NOTIF_LAST'))
    if last.get('text') == '''$message''' and $now - last.get('ts', 0) < 3600:
        sys.exit(0)
    sys.exit(1)
except: sys.exit(1)
" 2>/dev/null || echo "send") && { log "Report suppressed (dedup/cooldown)"; return; } || true
  fi

  local chat_ids
  chat_ids=$(python3 -c "
import json, sys
try:
    chats = json.load(open('$CHATS_FILE'))
    prefs = json.load(open('$NOTIF_FILE')) if __import__('os').path.exists('$NOTIF_FILE') else {}
    for cid in chats:
        if prefs.get(str(cid), {}).get('maintenance', True):
            print(cid, end=' ')
except: pass
" 2>/dev/null) || true

  for cid in $chat_ids; do
    curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
      -d "chat_id=$cid" -d "text=🛠️ NOVA Maintenance: $message" -d "disable_notification=true" > /dev/null 2>&1 || true
  done

  echo "{\"ts\":$now,\"text\":\"$message\"}" > "$NOTIF_LAST"
}

log "=== Maintenance ==="

# 1. Disk cleanup
if [ -d "$PROJECT_DIR/node_modules/.cache" ]; then
  rm -rf "$PROJECT_DIR/node_modules/.cache" 2>/dev/null && log "Cleared .cache"
fi
find "$PROJECT_DIR" -name "coverage" -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null && log "Cleaned old coverage"
if [ -d "$PROJECT_DIR/dist" ]; then
  rm -rf "$PROJECT_DIR/dist" 2>/dev/null && log "Removed dist"
fi
pnpm store prune 2>/dev/null && log "Pruned pnpm store"
DISK=$(df -h / | awk 'NR==2{print $5" used of "$2}')
log "Disk: $DISK"

# 2. Log rotation
for logfile in /var/log/nova-dev-agent.log /var/log/nova-bot.log; do
  if [ -f "$logfile" ]; then
    local size
    size=$(stat -c%s "$logfile" 2>/dev/null || echo 0)
    if [ "$size" -gt 10485760 ]; then
      gzip -c "$logfile" > "$logfile.$(date +%Y%m%d).gz"
      truncate -s 0 "$logfile"
      log "Rotated $logfile ($size bytes)"
    fi
  fi
done
find /var/log/ -name "nova-*.log.*.gz" -mtime +30 -delete 2>/dev/null

# 3. Services health
SVC_ISSUES=""
for svc in nova-dev-agent nova-bot; do
  status=$(systemctl is-active "$svc.service" 2>/dev/null || echo "inactive")
  if [ "$status" != "active" ]; then
    systemctl restart "$svc.service" 2>/dev/null
    SVC_ISSUES="$SVC_ISSUES $svc($status)"
  fi
done

MEM=$(free -m | awk 'NR==2{printf "%dMB/%dMB", $3,$2}')
MEM_PCT=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')

# 4. Git health
cd "$PROJECT_DIR"
git fsck --no-dangling 2>/dev/null | head -5 || true
UNCOMMITTED=""
if [ -n "$(git status --porcelain)" ]; then
  UNCOMMITTED=$(git status --porcelain | wc -l)
  log "WARNING: $UNCOMMITTED uncommitted files"
fi

# 5. Backup
mkdir -p "$BACKUP_DIR"
cp "$PROJECT_DIR/Plan.md" "$BACKUP_DIR/Plan.md.$(date +%Y%m%d)" 2>/dev/null
cp "$PROJECT_DIR/.agent-state.json" "$BACKUP_DIR/agent-state.$(date +%Y%m%d).json" 2>/dev/null || true
find "$BACKUP_DIR" -name "Plan.md.*" -mtime +7 -delete 2>/dev/null
find "$BACKUP_DIR" -name "agent-state.*" -mtime +7 -delete 2>/dev/null

log "=== Done ==="

# Build short report
REPORT="Disk: $DISK | Mem: $MEM"
[ -n "$SVC_ISSUES" ] && REPORT="$REPORT | Restarted:$SVC_ISSUES"
[ -n "$UNCOMMITTED" ] && REPORT="$REPORT | $UNCOMMITTED uncommitted"
send_report "$REPORT"
