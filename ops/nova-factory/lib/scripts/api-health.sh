#!/usr/bin/env bash
set -uo pipefail
# NOVA API / progress health check.
# The supervisor and watchdog catch crashes and hangs. This catches the *logical*
# stall the user cares about: the controller is running but makes no forward progress
# (no new commit) for too long — typically exhausted model credits, an expired token,
# or an upstream API outage. It sends one throttled maintenance alert.

PROJECT_DIR="${NOVA_PROJECT_DIR:-${HOME:-/home/${SUDO_USER:-ubuntu}}/NOVA}"
VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
LOG_FILE="$LOG_DIR/nova-api-health.log"
CHATS_FILE="${NOVA_CHATS_FILE:-$VAR_DIR/bot-chats.json}"
if [[ ! -s "$CHATS_FILE" && -s "$PROJECT_DIR/.bot-chats.json" ]]; then
  CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
fi
LAST_ALERT="$VAR_DIR/.api-health-last-alert"
AGENT_SERVICE="nova-dev-agent.service"
STALL_SEC="${NOVA_APIHEALTH_STALL_SEC:-7200}"        # 2h with no new commit
COOLDOWN="${NOVA_APIHEALTH_COOLDOWN_SEC:-3600}"      # at most one alert per hour

mkdir -p "$VAR_DIR" "$LOG_DIR"; touch "$LOG_FILE"
now="$(date +%s)"
log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"; }

send_alert() {
  local message="$1"
  [[ -z "${NOVA_BOT_TOKEN:-}" || ! -s "$CHATS_FILE" ]] && return 0
  local chat_ids
  chat_ids=$(python3 - "$CHATS_FILE" <<'PY' 2>/dev/null || true
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    print(" ".join(str(k) for k in (data.keys() if isinstance(data, dict) else data)))
except Exception:
    pass
PY
)
  for cid in $chat_ids; do
    curl -fsS -X POST "https://api.telegram.org/bot${NOVA_BOT_TOKEN}/sendMessage" \
      -d "chat_id=$cid" -d "text=NOVA health: $message" -d "disable_notification=true" \
      >/dev/null 2>&1 || true
  done
}

# Only meaningful while the controller is up; crashes/hangs are handled elsewhere.
[[ "$(systemctl is-active "$AGENT_SERVICE" 2>/dev/null)" == "active" ]] || { log "controller inactive; skip"; exit 0; }

last_commit="$(git -C "$PROJECT_DIR" log -1 --format=%ct 2>/dev/null || echo 0)"
age=$(( now - last_commit ))

if (( last_commit > 0 && age > STALL_SEC )); then
  last="$(cat "$LAST_ALERT" 2>/dev/null || echo 0)"
  if (( now - last >= COOLDOWN )); then
    printf '%s' "$now" > "$LAST_ALERT"
    send_alert "no forward progress for $((age/60)) min while the controller is running — check model credits, the GitHub token, and network."
    log "ALERT stall ${age}s"
  else
    log "stall ${age}s (alert on cooldown)"
  fi
else
  log "ok last_commit_age=${age}s"
fi
exit 0
