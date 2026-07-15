#!/usr/bin/env bash
set -Eeuo pipefail

# NOVA Daily Self-Maintenance
# Phase 1: Plan agent analyzes the platform (read-only, no changes)
# Phase 2: Build agent fixes issues found (full authority, no build commands)
# Phase 3: Verify and report via Telegram

PROJECT_DIR="${NOVA_PROJECT_DIR:-/home/ubuntu/NOVA}"
VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
LOG_FILE="$LOG_DIR/nova-daily-maintenance.log"
REPORT_FILE="$VAR_DIR/maintenance-report.md"
OPENCODE_BIN="${NOVA_OPENCODE:-/usr/local/bin/opencode}"
MODEL="${NOVA_AGENT_MODEL:-opencode/big-pickle}"
BOT_TOKEN="${NOVA_BOT_TOKEN:-}"
CHATS_FILE="${NOVA_CHATS_FILE:-$VAR_DIR/bot-chats.json}"
TIMEOUT="${NOVA_MAINTENANCE_TIMEOUT:-1800}"

export HOME="${HOME:-/home/ubuntu}"
export PATH="$HOME/.opencode/bin:/usr/local/lib/nova/blocked-bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$VAR_DIR" "$LOG_DIR"
touch "$LOG_FILE"

log() {
  local level="$1"; shift
  printf '[%s] [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$level" "$*" | tee -a "$LOG_FILE"
}

send_telegram() {
  local text="$1"
  [[ -z "$BOT_TOKEN" || ! -s "$CHATS_FILE" ]] && return 0
  local chat_ids
  chat_ids=$(python3 - "$CHATS_FILE" <<'PY' 2>/dev/null || true
import json, sys
try:
    data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    keys = data.keys() if isinstance(data, dict) else data
    print(" ".join(str(k) for k in keys))
except Exception:
    pass
PY
)
  for cid in $chat_ids; do
    curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -d "chat_id=$cid" \
      -d "text=$text" \
      -d "parse_mode=Markdown" \
      -d "disable_notification=false" >/dev/null 2>&1 || true
  done
}

# ============================================================================
# Phase 1: Analysis (Plan agent ??? read-only, no changes)
# ============================================================================
log "INFO" "Phase 1: Starting analysis with plan agent (read-only)"

ANALYSIS_PROMPT="Perform a comprehensive audit of the NOVA platform. Use the nova-self-maintenance skill.

Analyze these components in order:
1. nova-bot.py ??? streaming infrastructure, command handlers, error handling, sessions, git workflow
2. agent.sh ??? bot-only mode, queue processing, state management
3. System infrastructure ??? systemd services, timers, admin boundary
4. opencode configuration ??? agents, permissions, skills

For each component, identify:
- Critical bugs (P0): crashes, data loss, security issues
- High issues (P1): incorrect behavior, missing error handling
- Medium issues (P2): performance, code quality
- Low issues (P3): documentation, formatting

Produce a structured report in Arabic with:
- ???????? ????????????
- ?????????????? (grouped by severity)
- ????????????????
- ?????? ?????????????? (prioritized)

Be specific: cite file paths and line numbers. Be thorough: check every handler and edge case."

ANALYSIS_OUTPUT=""
if [ -x "$OPENCODE_BIN" ]; then
  log "INFO" "Running plan agent analysis..."
  ANALYSIS_OUTPUT=$(timeout "$TIMEOUT" "$OPENCODE_BIN" run \
    --agent plan \
    --model "$MODEL" \
    --format json \
    --auto \
    "$ANALYSIS_PROMPT" 2>&1 | \
    python3 -c '
import sys, json
texts = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        ev = json.loads(line)
        if ev.get("type") == "text":
            part = ev.get("part", {})
            t = part.get("text", "")
            if t: texts.append(t)
    except: pass
print("".join(texts))
' 2>/dev/null || echo "Analysis failed or timed out")
  log "INFO" "Analysis complete: ${#ANALYSIS_OUTPUT} chars"
else
  ANALYSIS_OUTPUT="opencode binary not found at $OPENCODE_BIN"
  log "ERROR" "$ANALYSIS_OUTPUT"
fi

# Save analysis report
echo "$ANALYSIS_OUTPUT" > "$REPORT_FILE"

# ============================================================================
# Phase 2: Repair (Build agent — full authority, no build commands)
# ============================================================================
if [ ${#ANALYSIS_OUTPUT} -lt 100 ]; then
  log "ERROR" "Phase 2 skipped: analysis output too short (${#ANALYSIS_OUTPUT} chars), likely failed"
  exit 1
fi
log "INFO" "Phase 2: Starting repair with build agent (full authority)"

REPAIR_PROMPT="You are performing the daily NOVA platform maintenance. Use the nova-self-maintenance skill.

Here is the analysis report from the audit phase:

$ANALYSIS_OUTPUT

Based on this report, perform repairs in priority order:
1. Fix all P0 (critical) issues first
2. Fix P1 (high) issues
3. Fix P2 (medium) issues if time permits
4. Skip P3 (low) issues unless trivial

Rules:
- Fix one issue at a time. Verify each fix.
- After editing nova-bot.py, verify syntax: python3 -c 'import py_compile; py_compile.compile(\"nova-bot.py\", doraise=True)'
- After editing systemd services, reload: sudo systemctl daemon-reload
- After editing the bot, restart: sudo systemctl restart nova-bot.service
- After editing the agent, restart: sudo systemctl restart nova-dev-agent.service
- NEVER run pnpm, npm, npx, tsc, eslint, vitest, vite, tauri, cargo, or any build/test/lint command.
- NEVER run git commit/push ??? the platform handles version control.
- Never break a working service. If a fix is risky, skip it and document.
- Use neutral, professional language. Never identify as an AI.

After all repairs, produce a summary in Arabic:
- ??????????????????: what you fixed (file:line + description)
- ??????????????????: what you improved
- ?????????????? ????????????????: issues too risky to fix
- ???????? ??????????????: status of nova-bot and nova-dev-agent"

REPAIR_OUTPUT=""
if [ -x "$OPENCODE_BIN" ]; then
  log "INFO" "Running build agent repair..."
  REPAIR_OUTPUT=$(timeout "$TIMEOUT" "$OPENCODE_BIN" run \
    --agent build \
    --model "$MODEL" \
    --format json \
    --auto \
    "$REPAIR_PROMPT" 2>&1 | \
    python3 -c '
import sys, json
texts = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        ev = json.loads(line)
        if ev.get("type") == "text":
            part = ev.get("part", {})
            t = part.get("text", "")
            if t: texts.append(t)
    except: pass
print("".join(texts))
' 2>/dev/null || echo "Repair phase failed or timed out")
  log "INFO" "Repair complete: ${#REPAIR_OUTPUT} chars"
else
  REPAIR_OUTPUT="opencode binary not found"
  log "ERROR" "$REPAIR_OUTPUT"
fi

# Save repair report
echo "$REPAIR_OUTPUT" >> "$REPORT_FILE"

# ============================================================================
# Phase 3: Verify
# ============================================================================
log "INFO" "Phase 3: Verification"

BOT_STATUS=$(systemctl is-active nova-bot.service 2>/dev/null || echo "unknown")
AGENT_STATUS=$(systemctl is-active nova-dev-agent.service 2>/dev/null || echo "unknown")
BOT_SYNTAX="unknown"
if [ -f "$PROJECT_DIR/nova-bot.py" ]; then
  if python3 -c "import py_compile; py_compile.compile('$PROJECT_DIR/nova-bot.py', doraise=True)" 2>/dev/null; then
    BOT_SYNTAX="ok"
  else
    BOT_SYNTAX="error"
  fi
fi

log "INFO" "Bot: $BOT_STATUS | Agent: $AGENT_STATUS | Syntax: $BOT_SYNTAX"

# ============================================================================
# Phase 4: Report via Telegram
# ============================================================================
log "INFO" "Phase 4: Sending report via Telegram"

# Truncate repair output for Telegram (max ~3500 chars)
REPAIR_SHORT="${REPAIR_OUTPUT:0:3000}"
if [ ${#REPAIR_OUTPUT} -gt 3000 ]; then
  REPAIR_SHORT="${REPAIR_SHORT}...
(?????????????? ???????????? ???? $REPORT_FILE)"
fi

REPORT="*NOVA ??? ?????????? ?????????????? ??????????????*
$(date -u '+%Y-%m-%d %H:%M UTC')

*???????? ??????????????:*
??? nova-bot: \`${BOT_STATUS}\`
??? nova-dev-agent: \`${AGENT_STATUS}\`
??? ???????? nova-bot.py: \`${BOT_SYNTAX}\`

*?????????? ??????????????:*
${REPAIR_SHORT}"

send_telegram "$REPORT"
log "INFO" "Daily maintenance complete"
