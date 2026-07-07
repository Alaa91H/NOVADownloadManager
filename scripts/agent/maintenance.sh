#!/usr/bin/env bash
# =============================================================
#  NOVA Self-Maintenance
#  Run via systemd timer or manually
#  Cleans, audits, backs up, reports
# =============================================================
set -euo pipefail

PROJECT_DIR="/home/ubuntu/NOVA"
LOG_FILE="/var/log/nova-maintenance.log"
BACKUP_DIR="/home/ubuntu/backups"
CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
BOT_TOKEN="${NOVA_BOT_TOKEN:-8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY}"

log() {
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] $*" | tee -a "$LOG_FILE"
}

send_telegram() {
  local msg="$1"
  if [ ! -f "$CHATS_FILE" ]; then return; fi
  local chat_ids
  chat_ids=$(python3 -c "
import json
try:
    chats = json.load(open('$CHATS_FILE'))
    print(' '.join(str(c) for c in chats))
except: pass
" 2>/dev/null) || true
  for cid in $chat_ids; do
    curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
      -d "chat_id=$cid" -d "text=🛠️ NOVA Maintenance: $msg" > /dev/null 2>&1 || true
  done
}

log "=== Starting maintenance ==="

# 1. Disk cleanup
log "Cleaning disk..."
# Remove node_modules/.cache
if [ -d "$PROJECT_DIR/node_modules/.cache" ]; then
  rm -rf "$PROJECT_DIR/node_modules/.cache" 2>/dev/null && log "  Cleared .cache"
fi
# Remove old coverage reports
find "$PROJECT_DIR" -name "coverage" -type d -mtime +7 -exec rm -rf {} \; 2>/dev/null && log "  Cleaned old coverage"
# Remove dist
if [ -d "$PROJECT_DIR/dist" ]; then
  rm -rf "$PROJECT_DIR/dist" 2>/dev/null && log "  Removed dist"
fi
# Clean pnpm store
pnpm store prune 2>/dev/null && log "  Pruned pnpm store"
# Disk usage
DISK=$(df -h / | awk 'NR==2{print $5" used of "$2}')
log "  Disk: $DISK"

# 2. Log rotation
log "Rotating logs..."
if [ -f "/var/log/nova-dev-agent.log" ]; then
  local size
  size=$(stat -c%s "/var/log/nova-dev-agent.log" 2>/dev/null || echo 0)
  if [ "$size" -gt 10485760 ]; then  # 10MB
    gzip -c "/var/log/nova-dev-agent.log" > "/var/log/nova-dev-agent.log.$(date +%Y%m%d).gz"
    truncate -s 0 "/var/log/nova-dev-agent.log"
    log "  Rotated agent log ($size bytes)"
  fi
fi
if [ -f "/var/log/nova-bot.log" ]; then
  local size
  size=$(stat -c%s "/var/log/nova-bot.log" 2>/dev/null || echo 0)
  if [ "$size" -gt 10485760 ]; then
    gzip -c "/var/log/nova-bot.log" > "/var/log/nova-bot.log.$(date +%Y%m%d).gz"
    truncate -s 0 "/var/log/nova-bot.log"
    log "  Rotated bot log ($size bytes)"
  fi
fi
# Remove logs older than 30 days
find /var/log/ -name "nova-*.log.*.gz" -mtime +30 -delete 2>/dev/null && log "  Cleaned old archived logs"

# 3. Health check
log "Health check..."
# Services
for svc in nova-dev-agent nova-bot; do
  status=$(systemctl is-active "$svc.service" 2>/dev/null || echo "inactive")
  log "  $svc: $status"
  if [ "$status" != "active" ]; then
    send_telegram "⚠️ Service $svc is $status — attempting restart..."
    systemctl restart "$svc.service" 2>/dev/null && log "  Restarted $svc"
  fi
done
# Memory
MEM=$(free -m | awk 'NR==2{printf "%dMB/%dMB (%.0f%%)", $3,$2,$3*100/$2}')
log "  Memory: $MEM"
# Swap
SWAP=$(free -m | awk 'NR==3{printf "%dMB/%dMB", $3,$2}')
log "  Swap: $SWAP"

# 4. Git health
log "Git health..."
cd "$PROJECT_DIR"
git fsck --no-dangling 2>/dev/null | head -5 || true
# Count uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
  log "  WARNING: Uncommitted changes found"
  git status --porcelain | head -10
fi

# 5. Backup Plan.md + state
log "Backup..."
mkdir -p "$BACKUP_DIR"
cp "$PROJECT_DIR/Plan.md" "$BACKUP_DIR/Plan.md.$(date +%Y%m%d)" 2>/dev/null && log "  Backed up Plan.md"
cp "$PROJECT_DIR/.agent-state.json" "$BACKUP_DIR/agent-state.$(date +%Y%m%d).json" 2>/dev/null || true
# Keep last 7 backups
find "$BACKUP_DIR" -name "Plan.md.*" -mtime +7 -delete 2>/dev/null
find "$BACKUP_DIR" -name "agent-state.*" -mtime +7 -delete 2>/dev/null

log "=== Maintenance complete ==="
send_telegram "✅ Maintenance complete — Disk: $DISK, Memory: $MEM"
