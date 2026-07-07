#!/usr/bin/env bash
# =============================================================
#  NOVA Self-Update
#  Pulls latest agent scripts from repo and restarts if needed
# =============================================================
set -euo pipefail

PROJECT_DIR="/home/ubuntu/NOVA"
AGENT_SCRIPT="/usr/local/bin/nova-dev-agent.sh"
LOG_FILE="/var/log/nova-self-update.log"

log() {
  echo "[$(date +%Y-%m-%dT%H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

cd "$PROJECT_DIR"

# Check if repo has updates for agent scripts
CURRENT_HASH=$(git rev-parse HEAD 2>/dev/null || echo "none")
REMOTE_HASH=$(git ls-remote origin Dev 2>/dev/null | awk '{print $1}' || echo "none")

if [ "$CURRENT_HASH" = "$REMOTE_HASH" ]; then
  log "Already up to date ($CURRENT_HASH)"
  exit 0
fi

log "New commit detected: $REMOTE_HASH (current: $CURRENT_HASH)"

# Pull changes
git fetch origin Dev 2>&1 | tee -a "$LOG_FILE"
git reset --hard origin/Dev 2>&1 | tee -a "$LOG_FILE"

log "Repository updated"

# Check if agent script changed
if [ -f "$PROJECT_DIR/nova-dev-agent.sh" ]; then
  AGENT_DIFF=$(diff "$PROJECT_DIR/nova-dev-agent.sh" "$AGENT_SCRIPT" 2>/dev/null || echo "diff")
  if [ -n "$AGENT_DIFF" ]; then
    log "Agent script changed — updating and restarting..."
    cp "$PROJECT_DIR/nova-dev-agent.sh" "$AGENT_SCRIPT"
    chmod +x "$AGENT_SCRIPT"
    systemctl restart nova-dev-agent.service
    log "Agent restarted with new version"
  fi
fi

# Check if bot script changed
if [ -f "$PROJECT_DIR/nova-bot.py" ]; then
  BOT_DIFF=$(diff "$PROJECT_DIR/nova-bot.py" "/home/ubuntu/NOVA/nova-bot.py" 2>/dev/null || echo "diff")
  if [ -n "$BOT_DIFF" ]; then
    log "Bot script changed — restarting..."
    systemctl restart nova-bot.service
    log "Bot restarted with new version"
  fi
fi

log "Self-update complete"
