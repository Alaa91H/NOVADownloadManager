#!/usr/bin/env bash
set -Eeuo pipefail

# NOVA Service Monitor v6
# Root-level supervisor for systemd services and stale heartbeat recovery.

PROJECT_DIR="${NOVA_PROJECT_DIR:-${HOME:-/home/${SUDO_USER:-ubuntu}}/NOVA}"
VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
LOG_FILE="$LOG_DIR/nova-monitor.log"
STATE_FILE="$VAR_DIR/.monitor-state.json"
AGENT_STATE="$VAR_DIR/.agent-state.json"
MONITOR_HEARTBEAT="$VAR_DIR/.monitor-heartbeat"
LOCK_FILE="$VAR_DIR/monitor.lock"
CHATS_FILE="${NOVA_CHATS_FILE:-$VAR_DIR/bot-chats.json}"
if [[ ! -s "$CHATS_FILE" && -s "$PROJECT_DIR/.bot-chats.json" ]]; then
  CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
fi
AGENT_SERVICE="nova-dev-agent.service"
BOT_SERVICE="nova-bot.service"
WATCHDOG_TIMER="nova-watchdog.timer"
SELF_UPDATE_TIMER="nova-self-update.timer"
CHECK_INTERVAL="${NOVA_MONITOR_INTERVAL:-15}"
AGENT_STALE_SEC="${NOVA_AGENT_STALE_SEC:-1800}"
AGENT_START_GRACE_SEC="${NOVA_AGENT_START_GRACE_SEC:-600}"
RESTART_COOLDOWN_SEC="${NOVA_RESTART_COOLDOWN_SEC:-90}"
ALERT_COOLDOWN_SEC="${NOVA_ALERT_COOLDOWN_SEC:-300}"
HEALTH_BIN="${NOVA_HEALTH_BIN:-/usr/local/lib/nova/nova-health.py}"
HEALTH_EVERY_SEC="${NOVA_HEALTH_EVERY_SEC:-60}"

mkdir -p "$VAR_DIR" "$LOG_DIR"
touch "$LOG_FILE"

exec 8>"$LOCK_FILE"
if ! flock -n 8; then
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] monitor already running" >> "$LOG_FILE"
  exit 0
fi

log() {
  local level="$1"
  local msg="$2"
  printf '[%s] [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$level" "$msg" | tee -a "$LOG_FILE"
}

send_alert() {
  local message="$1"
  local now last_file last
  now="$(date +%s)"
  last_file="$VAR_DIR/.monitor-last-alert"
  last="$(cat "$last_file" 2>/dev/null || echo 0)"
  if [[ $((now - last)) -lt "$ALERT_COOLDOWN_SEC" ]]; then
    return 0
  fi
  printf '%s' "$now" > "$last_file"

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
      -d "text=NOVA monitor: $message" \
      -d "disable_notification=true" >/dev/null 2>&1 || true
  done
}

service_status() {
  local status
  status="$(systemctl is-active "$1" 2>/dev/null | head -n 1 || true)"
  [[ -n "$status" ]] || status="inactive"
  printf '%s\n' "$status"
}

service_active_epoch() {
  local stamp
  stamp="$(systemctl show "$1" -p ActiveEnterTimestamp --value 2>/dev/null || true)"
  date -d "$stamp" +%s 2>/dev/null || echo 0
}

restart_with_cooldown() {
  local service="$1"
  local reason="$2"
  local now last_file last
  now="$(date +%s)"
  last_file="$VAR_DIR/restart-${service}"
  last="$(cat "$last_file" 2>/dev/null || echo 0)"
  if [[ $((now - last)) -lt "$RESTART_COOLDOWN_SEC" ]]; then
    log "WARN" "restart suppressed for $service ($reason); cooldown active"
    return 0
  fi
  printf '%s' "$now" > "$last_file"
  log "WARN" "restarting $service: $reason"
  systemctl restart "$service" >> "$LOG_FILE" 2>&1 || {
    log "ERROR" "failed to restart $service"
    send_alert "$service failed to restart ($reason)"
    return 1
  }
  send_alert "$service restarted ($reason)"
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

check_controller() {
  local status now state_epoch active_epoch age active_age
  status="$(service_status "$AGENT_SERVICE")"
  now="$(date +%s)"
  if [[ "$status" != "active" ]]; then
    restart_with_cooldown "$AGENT_SERVICE" "status=$status"
    return
  fi

  state_epoch="$(json_epoch "$AGENT_STATE")"
  active_epoch="$(service_active_epoch "$AGENT_SERVICE")"
  age=$((now - state_epoch))
  active_age=$((now - active_epoch))

  if [[ "$state_epoch" -eq 0 && "$active_age" -gt "$AGENT_START_GRACE_SEC" ]]; then
    restart_with_cooldown "$AGENT_SERVICE" "missing heartbeat after ${active_age}s"
    return
  fi
  if [[ "$state_epoch" -gt 0 && "$age" -gt "$AGENT_STALE_SEC" ]]; then
    restart_with_cooldown "$AGENT_SERVICE" "stale heartbeat ${age}s"
  fi
}

check_telegram_interface() {
  local status
  status="$(service_status "$BOT_SERVICE")"
  if [[ "$status" != "active" ]]; then
    restart_with_cooldown "$BOT_SERVICE" "status=$status"
  fi
}

check_watchdog() {
  local status
  status="$(service_status "$WATCHDOG_TIMER")"
  if [[ "$status" != "active" ]]; then
    log "WARN" "starting $WATCHDOG_TIMER"
    systemctl start "$WATCHDOG_TIMER" >> "$LOG_FILE" 2>&1 || true
  fi
  status="$(service_status "$SELF_UPDATE_TIMER")"
  if [[ "${NOVA_SELF_UPDATE_ENABLED:-1}" == "1" && "$status" != "active" ]]; then
    log "WARN" "starting $SELF_UPDATE_TIMER"
    systemctl start "$SELF_UPDATE_TIMER" >> "$LOG_FILE" 2>&1 || true
  fi
}

resource_guard() {
  local mem_pct load cores load_int
  mem_pct=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
  load=$(cut -d' ' -f1 /proc/loadavg)
  cores=$(nproc)
  load_int="${load%.*}"
  if [[ "$mem_pct" -ge 97 ]]; then
    log "WARN" "memory pressure ${mem_pct}%"
    restart_with_cooldown "$AGENT_SERVICE" "memory pressure ${mem_pct}%"
  elif [[ "$load_int" -gt $((cores * 6)) ]]; then
    log "WARN" "load pressure $load"
  fi
}

write_health_snapshot() {
  local now last_file last
  now="$(date +%s)"
  last_file="$VAR_DIR/.monitor-last-health"
  last="$(cat "$last_file" 2>/dev/null || echo 0)"
  if [[ $((now - last)) -lt "$HEALTH_EVERY_SEC" ]]; then
    return 0
  fi
  printf '%s' "$now" > "$last_file"
  if [[ -x "$HEALTH_BIN" ]]; then
    "$HEALTH_BIN" --write >/dev/null 2>>"$LOG_FILE" || true
  fi
}

write_state() {
  local now
  now="$(date +%s)"
  cat > "$STATE_FILE.tmp" <<JSON
{
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "epoch": $now,
  "pid": $$,
  "controller": "$(service_status "$AGENT_SERVICE")",
  "telegram": "$(service_status "$BOT_SERVICE")",
  "watchdog_timer": "$(service_status "$WATCHDOG_TIMER")",
  "self_update_timer": "$(service_status "$SELF_UPDATE_TIMER")",
  "interval": $CHECK_INTERVAL
}
JSON
  mv "$STATE_FILE.tmp" "$STATE_FILE"
  printf '%s\n' "$now" > "$MONITOR_HEARTBEAT"
}

trap 'log "INFO" "monitor stopping"; write_state; exit 0' SIGTERM SIGINT

log "INFO" "monitor started"
while true; do
  check_watchdog
  check_controller
  check_telegram_interface
  resource_guard
  write_state
  write_health_snapshot
  sleep "$CHECK_INTERVAL"
done
