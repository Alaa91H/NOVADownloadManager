#!/usr/bin/env bash
# =============================================================
#  NOVA Watchdog — Emergency monitoring & recovery
#  Run every 5 minutes via systemd timer
#  Detects stuck agent, high memory, disk full
#  Sends alerts only when something changes (no spam)
# =============================================================
set -euo pipefail

PROJECT_DIR="/home/ubuntu/NOVA"
LOG_FILE="/var/log/nova-watchdog.log"
CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
NOTIF_FILE="$PROJECT_DIR/.notif-prefs.json"
NOTIF_LAST="$PROJECT_DIR/.notif-last-watchdog.json"
BOT_TOKEN="${NOVA_BOT_TOKEN:-8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY}"

log() {
  echo "[$(date +%Y-%m-%dT%H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

send_alert() {
  local message="$1"
  local now
  now=$(date +%s)

  if [ ! -f "$CHATS_FILE" ]; then return; fi

  # Dedup + cooldown (300s): don't repeat identical alerts
  if [ -f "$NOTIF_LAST" ]; then
    local skip
    skip=$(python3 -c "
import json, sys
try:
    last = json.load(open('$NOTIF_LAST'))
    if last.get('text') == '''$message''' and $now - last.get('ts', 0) < 300:
        sys.exit(0)
    sys.exit(1)
except: sys.exit(1)
" 2>/dev/null || echo "send") && { log "Alert suppressed (dedup/cooldown)"; return; } || true
  fi

  local chat_ids
  chat_ids=$(python3 -c "
import json, sys
try:
    chats = json.load(open('$CHATS_FILE'))
    prefs = json.load(open('$NOTIF_FILE')) if __import__('os').path.exists('$NOTIF_FILE') else {}
    for cid in chats:
        if prefs.get(str(cid), {}).get('watchdog', True):
            print(cid, end=' ')
except: pass
" 2>/dev/null) || true

  for cid in $chat_ids; do
    curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
      -d "chat_id=$cid" -d "text=🔍 NOVA Watchdog: $message" -d "disable_notification=true" > /dev/null 2>&1 || true
  done

  echo "{\"ts\":$now,\"text\":\"$message\"}" > "$NOTIF_LAST"
}

ALERTS=""

# 1. Agent service
AGENT_STATUS=$(systemctl is-active nova-dev-agent.service 2>/dev/null || echo "inactive")
if [ "$AGENT_STATUS" != "active" ]; then
  systemctl restart nova-dev-agent.service 2>/dev/null
  ALERTS="$ALERTS Agent $AGENT_STATUS"
fi

# 2. Bot service
BOT_STATUS=$(systemctl is-active nova-bot.service 2>/dev/null || echo "inactive")
if [ "$BOT_STATUS" != "active" ]; then
  systemctl restart nova-bot.service 2>/dev/null
  ALERTS="$ALERTS Bot $BOT_STATUS"
fi

# 3. Agent stuck (state file not updated in 30 min)
if [ -f "$PROJECT_DIR/.agent-state.json" ]; then
  LAST_CYCLE=$(python3 -c "import json; print(json.load(open('$PROJECT_DIR/.agent-state.json')).get('timestamp', ''))" 2>/dev/null || echo "")
  if [ -n "$LAST_CYCLE" ]; then
    LAST_EPOCH=$(date -d "$LAST_CYCLE" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DIFF=$(( (NOW_EPOCH - LAST_EPOCH) / 60 ))
    if [ "$DIFF" -gt 30 ]; then
      systemctl restart nova-dev-agent.service 2>/dev/null
      ALERTS="$ALERTS Agent stuck ${DIFF}min"
    fi
  fi
fi

# 4. Memory
MEM_PCT=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
if [ "$MEM_PCT" -gt 90 ]; then
  ALERTS="$ALERTS Mem ${MEM_PCT}%"
  sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
fi

# 5. Disk
DISK_PCT=$(df / | awk 'NR==2{print+$5}')
if [ "$DISK_PCT" -gt 90 ]; then
  ALERTS="$ALERTS Disk ${DISK_PCT}%"
fi

# Send ONE alert if anything changed
if [ -n "$ALERTS" ]; then
  send_alert "⚠️${ALERTS}"
  log "Alert:${ALERTS}"
else
  log "OK — agent=$AGENT_STATUS bot=$BOT_STATUS mem=${MEM_PCT}% disk=${DISK_PCT}%"
fi
