#!/usr/bin/env bash
# NOVA Watchdog — Emergency monitoring & recovery
# Run every 5 minutes via systemd timer
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

  # Dedup + cooldown via temp file
  local tmp
  tmp=$(mktemp 2>/dev/null || echo "/tmp/nova-wd-$$")
  printf '%s' "$message" > "$tmp"

  if [ -f "$NOTIF_LAST" ]; then
    if python3 -c "
import json, sys
last = json.load(open('$NOTIF_LAST'))
msg = open('$tmp', 'r').read()
if last.get('text') == msg and $now - last.get('ts', 0) < 300:
    sys.exit(1)
sys.exit(0)
" 2>/dev/null; then
      :  # send
    else
      log "Alert suppressed (dedup/cooldown)"
      rm -f "$tmp"
      return
    fi
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
      -d "chat_id=$cid" -d "text=🔍 NOVA Watchdog: $(cat "$tmp")" -d "disable_notification=true" > /dev/null 2>&1 || true
  done

  python3 -c "
import json
msg = open('$tmp', 'r').read()
json.dump({'ts': $now, 'text': msg}, open('$NOTIF_LAST', 'w'))
" 2>/dev/null || true
  rm -f "$tmp"
}

ALERTS=""

# 1. Agent service — restart if not active
AGENT_STATUS=$(systemctl is-active nova-dev-agent.service 2>/dev/null || echo "inactive")
if [ "$AGENT_STATUS" != "active" ]; then
  systemctl restart nova-dev-agent.service 2>/dev/null
  ALERTS="$ALERTS Agent $AGENT_STATUS"
fi

# 2. Bot service — restart if not active
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

# 4. High restart rate — if agent restarted >10 times in 5 min
RESTART_COUNT=$(systemctl show nova-dev-agent.service -p NRestarts --value 2>/dev/null || echo 0)
if [ "$RESTART_COUNT" -gt 10 ]; then
  ALERTS="$ALERTS Agent ${RESTART_COUNT}restarts"
fi

# 5. Memory
MEM_PCT=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
if [ "$MEM_PCT" -gt 90 ]; then
  ALERTS="$ALERTS Mem ${MEM_PCT}%"
  sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
fi

# 6. Disk — auto-cleanup if full
DISK_PCT=$(df / | awk 'NR==2{print+$5}')
if [ "$DISK_PCT" -gt 90 ]; then
  ALERTS="$ALERTS Disk ${DISK_PCT}%"
  # Auto-cleanup: remove old logs and tmp
  find /var/log -name "nova-*.log" -mtime +7 -delete 2>/dev/null || true
  find /tmp -name "nova-*" -mtime +1 -delete 2>/dev/null || true
  journalctl --vacuum-time=3d 2>/dev/null || true
  docker system prune -f 2>/dev/null || true
elif [ "$DISK_PCT" -gt 80 ]; then
  log "WARN Disk ${DISK_PCT}%"
fi

# 7. Load average
LOAD=$(uptime | sed 's/.*load average: //' | cut -d, -f1 | tr -d ' ')
CPU_CORES=$(nproc)
LOAD_INT=${LOAD%.*}
if [ "$LOAD_INT" -gt $((CPU_CORES * 2)) ]; then
  ALERTS="$ALERTS Load ${LOAD}"
fi

# Send ONE alert if anything changed
if [ -n "$ALERTS" ]; then
  send_alert "⚠️${ALERTS}"
  log "Alert:${ALERTS}"
else
  log "OK agent=$AGENT_STATUS bot=$BOT_STATUS mem=${MEM_PCT}% disk=${DISK_PCT}% restarts=${RESTART_COUNT}"
fi
