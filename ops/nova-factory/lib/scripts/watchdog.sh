#!/usr/bin/env bash
set -uo pipefail

# NOVA Watchdog v6
# Emergency timer. It must never fail the systemd unit for ordinary alerts.

PROJECT_DIR="${NOVA_PROJECT_DIR:-${HOME:-/home/${SUDO_USER:-ubuntu}}/NOVA}"
VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
LOG_FILE="$LOG_DIR/nova-watchdog.log"
CHATS_FILE="${NOVA_CHATS_FILE:-$VAR_DIR/bot-chats.json}"
if [[ ! -s "$CHATS_FILE" && -s "$PROJECT_DIR/.bot-chats.json" ]]; then
  CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
fi
AGENT_STATE="$VAR_DIR/.agent-state.json"
MONITOR_HEARTBEAT="$VAR_DIR/.monitor-heartbeat"
AGENT_SERVICE="nova-dev-agent.service"
MONITOR_SERVICE="nova-monitor.service"
BOT_SERVICE="nova-bot.service"
WATCHDOG_TIMER="nova-watchdog.timer"
SELF_UPDATE_TIMER="nova-self-update.timer"
AGENT_STALE_SEC="${NOVA_WATCHDOG_AGENT_STALE_SEC:-2400}"
MONITOR_STALE_SEC="${NOVA_WATCHDOG_MONITOR_STALE_SEC:-180}"

mkdir -p "$VAR_DIR" "$LOG_DIR"
touch "$LOG_FILE"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG_FILE"
}

send_alert() {
  local message="$1"
  if [[ -z "${NOVA_BOT_TOKEN:-}" || ! -s "$CHATS_FILE" ]]; then
    return 0
  fi
  local chat_ids
  chat_ids=$(python3 - "$CHATS_FILE" <<'PY' 2>/dev/null || true
import json
import sys
try:
    data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    keys = data.keys() if isinstance(data, dict) else data
    print(" ".join(str(item) for item in keys))
except Exception:
    pass
PY
)
  for cid in $chat_ids; do
    curl -fsS -X POST "https://api.telegram.org/bot${NOVA_BOT_TOKEN}/sendMessage" \
      -d "chat_id=$cid" \
      -d "text=NOVA watchdog: $message" \
      -d "disable_notification=true" >/dev/null 2>&1 || true
  done
}

service_status() {
  local status
  status="$(systemctl is-active "$1" 2>/dev/null | head -n 1 || true)"
  [[ -n "$status" ]] || status="inactive"
  printf '%s\n' "$status"
}

json_epoch() {
  local file="$1"
  python3 - "$file" <<'PY' 2>/dev/null || echo 0
import json
import sys
try:
    print(int(json.load(open(sys.argv[1], "r", encoding="utf-8")).get("epoch", 0)))
except Exception:
    print(0)
PY
}

alerts=()

for service in "$AGENT_SERVICE" "$MONITOR_SERVICE" "$BOT_SERVICE"; do
  status="$(service_status "$service")"
  if [[ "$status" != "active" ]]; then
    systemctl restart "$service" >> "$LOG_FILE" 2>&1 || true
    alerts+=("$service:$status")
  fi
done

timer_status="$(service_status "$WATCHDOG_TIMER")"
if [[ "$timer_status" != "active" ]]; then
  systemctl start "$WATCHDOG_TIMER" >> "$LOG_FILE" 2>&1 || true
  alerts+=("$WATCHDOG_TIMER:$timer_status")
fi

self_timer_status="$(service_status "$SELF_UPDATE_TIMER")"
if [[ "${NOVA_SELF_UPDATE_ENABLED:-1}" == "1" && "$self_timer_status" != "active" ]]; then
  systemctl start "$SELF_UPDATE_TIMER" >> "$LOG_FILE" 2>&1 || true
  alerts+=("$SELF_UPDATE_TIMER:$self_timer_status")
fi

now="$(date +%s)"
agent_epoch="$(json_epoch "$AGENT_STATE")"
if [[ "$agent_epoch" -gt 0 && $((now - agent_epoch)) -gt "$AGENT_STALE_SEC" ]]; then
  systemctl restart "$AGENT_SERVICE" >> "$LOG_FILE" 2>&1 || true
  alerts+=("controller-stale:$((now - agent_epoch))s")
fi

monitor_epoch="$(cat "$MONITOR_HEARTBEAT" 2>/dev/null || echo 0)"
if [[ "$monitor_epoch" =~ ^[0-9]+$ && "$monitor_epoch" -gt 0 && $((now - monitor_epoch)) -gt "$MONITOR_STALE_SEC" ]]; then
  systemctl restart "$MONITOR_SERVICE" >> "$LOG_FILE" 2>&1 || true
  alerts+=("monitor-stale:$((now - monitor_epoch))s")
fi

mem_pct=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
disk_pct=$(df / | awk 'NR==2{print+$5}')
if [[ "$disk_pct" -gt 90 ]]; then
  find "$LOG_DIR" -type f -name 'nova-*.log' -mtime +7 -delete 2>/dev/null || true
  journalctl --vacuum-time=7d >/dev/null 2>&1 || true
  alerts+=("disk:${disk_pct}%")
fi

if [[ "${#alerts[@]}" -gt 0 ]]; then
  message="${alerts[*]}"
  log "alerts: $message mem=${mem_pct}% disk=${disk_pct}%"
  send_alert "$message"
else
  log "ok controller=$(service_status "$AGENT_SERVICE") monitor=$(service_status "$MONITOR_SERVICE") telegram=$(service_status "$BOT_SERVICE") mem=${mem_pct}% disk=${disk_pct}%"
fi

exit 0
