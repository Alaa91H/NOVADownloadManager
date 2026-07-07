#!/usr/bin/env bash
# =============================================================
#  NOVA Watchdog — Emergency monitoring & recovery
#  Run every 5 minutes via systemd timer
#  Detects stuck agent, high memory, disk full
# =============================================================
set -euo pipefail

PROJECT_DIR="/home/ubuntu/NOVA"
LOG_FILE="/var/log/nova-watchdog.log"
CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
BOT_TOKEN="${NOVA_BOT_TOKEN:-8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY}"

log() {
  echo "[$(date +%Y-%m-%dT%H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

send_telegram() {
  local msg="$1"
  if [ ! -f "$CHATS_FILE" ]; then return; fi
  chat_ids=$(python3 -c "import json; chats=json.load(open('$CHATS_FILE')); print(' '.join(str(c) for c in chats))" 2>/dev/null) || true
  for cid in $chat_ids; do
    curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
      -d "chat_id=$cid" -d "text=🔍 NOVA Watchdog: $msg" > /dev/null 2>&1 || true
  done
}

ALERT=""

# 1. Check agent service
AGENT_STATUS=$(systemctl is-active nova-dev-agent.service 2>/dev/null || echo "inactive")
if [ "$AGENT_STATUS" != "active" ]; then
  log "Agent is $AGENT_STATUS — restarting..."
  systemctl restart nova-dev-agent.service 2>/dev/null
  ALERT="Agent was $AGENT_STATUS → restarted"
fi

# 2. Check bot service
BOT_STATUS=$(systemctl is-active nova-bot.service 2>/dev/null || echo "inactive")
if [ "$BOT_STATUS" != "active" ]; then
  log "Bot is $BOT_STATUS — restarting..."
  systemctl restart nova-bot.service 2>/dev/null
  ALERT="$ALERT | Bot was $BOT_STATUS → restarted"
fi

# 3. Check if agent is stuck (state file not updated in 30 min)
if [ -f "$PROJECT_DIR/.agent-state.json" ]; then
  LAST_CYCLE=$(python3 -c "import json; print(json.load(open('$PROJECT_DIR/.agent-state.json')).get('timestamp', ''))" 2>/dev/null || echo "")
  if [ -n "$LAST_CYCLE" ]; then
    LAST_EPOCH=$(date -d "$LAST_CYCLE" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DIFF=$(( (NOW_EPOCH - LAST_EPOCH) / 60 ))
    if [ "$DIFF" -gt 30 ]; then
      log "Agent stuck — no update for ${DIFF}min. Restarting..."
      systemctl restart nova-dev-agent.service 2>/dev/null
      ALERT="$ALERT | Agent stuck (${DIFF}min) → restarted"
    fi
  fi
fi

# 4. Memory check
MEM_PCT=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
if [ "$MEM_PCT" -gt 90 ]; then
  log "Critical memory: ${MEM_PCT}%"
  ALERT="$ALERT | Critical memory: ${MEM_PCT}%"
  # Try to free some memory
  sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
fi

# 5. Disk check
DISK_PCT=$(df / | awk 'NR==2{print+$5}')
if [ "$DISK_PCT" -gt 90 ]; then
  log "Critical disk: ${DISK_PCT}%"
  ALERT="$ALERT | Critical disk: ${DISK_PCT}%"
fi

# 6. Send alert if needed
if [ -n "$ALERT" ]; then
  send_telegram "⚠️ $ALERT"
  log "Alert sent: $ALERT"
else
  log "All healthy — agent=$AGENT_STATUS, bot=$BOT_STATUS, mem=${MEM_PCT}%, disk=${DISK_PCT}%"
fi
