#!/usr/bin/env bash
# ============================================================
#  NOVA Continuous Development Agent (24/7)
#  opencode big-pickle: autonomous project maintenance
#  AGENTS.md reference at PROJECT_DIR/AGENTS.md
#  Plan.md task management at PROJECT_DIR/Plan.md
#  Logs: /var/log/nova-dev-agent.log
# ============================================================
set -euo pipefail

PROJECT_DIR="/home/ubuntu/NOVA"
LOG_FILE="/var/log/nova-dev-agent.log"
STATE_FILE="$PROJECT_DIR/.agent-state.json"
CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
NOTIF_FILE="$PROJECT_DIR/.notif-prefs.json"
NOTIF_LAST="$PROJECT_DIR/.notif-last.json"
OPENCODE="/home/ubuntu/.opencode/bin/opencode"
BOT_TOKEN="8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY"
SCRIPTS_DIR="$PROJECT_DIR/scripts/agent"

log() {
  local level="$1"
  local msg="$2"
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] [$level] $msg" | tee -a "$LOG_FILE"
}

# ── Smart Telegram notification ──
# Rules:
#   1. Respect .notif-prefs.json per-chat per-type
#   2. Cooldown: don't send same type more than once per 120s
#   3. Dedup: don't send if content identical to last sent
#   4. Rate limit: max 1 message per type per 120s
send_telegram() {
  local message="$1"
  local icon="${2:-}"
  local notif_type="${3:-system}"
  local full_msg="$icon NOVA Agent: $message"
  local now
  now=$(date +%s)
  local cooldown=120
  local tmp
  tmp=$(mktemp 2>/dev/null || echo "/tmp/nova-notif-$$")

  if [ ! -f "$CHATS_FILE" ]; then return; fi

  # Write message to temp file to avoid quoting hell
  printf '%s' "$full_msg" > "$tmp"

  # Check cooldown & dedup
  if [ -f "$NOTIF_LAST" ]; then
    if python3 -c "
import json, sys
last = json.load(open('$NOTIF_LAST'))
nt = '$notif_type'
now = $now
cooldown = $cooldown
msg = open('$tmp', 'r').read()
prev = last.get(nt, {})
elapsed = now - prev.get('ts', 0)
if elapsed < cooldown:
    sys.exit(0)
if prev.get('text', '') == msg:
    sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
      :  # should send
    else
      log "DEBUG" "Notif $notif_type skipped"
      rm -f "$tmp"
      return
    fi
  fi

  python3 -c "
import json, urllib.request, urllib.parse, sys, os

BOT_TOKEN = '$BOT_TOKEN'
CHATS_FILE = '$CHATS_FILE'
NOTIF_FILE = '$NOTIF_FILE'
NOTIF_LAST = '$NOTIF_LAST'
NOTIF_TYPE = '$notif_type'
NOW = $now

MESSAGE = open('$tmp', 'r').read()

try:
    chats = json.load(open(CHATS_FILE))
except:
    sys.exit(0)

prefs = {}
try:
    prefs = json.load(open(NOTIF_FILE))
except:
    pass

sent_any = False
for chat_id in chats:
    cid = str(chat_id)
    chat_prefs = prefs.get(cid, {})
    if not chat_prefs.get(NOTIF_TYPE, True):
        continue
    url = f'https://api.telegram.org/bot{BOT_TOKEN}/sendMessage'
    data = urllib.parse.urlencode({
        'chat_id': chat_id,
        'text': MESSAGE,
        'parse_mode': 'Markdown',
        'disable_notification': 'true',
    }).encode()
    try:
        urllib.request.urlopen(url, data=data, timeout=5)
        sent_any = True
    except:
        pass

if sent_any:
    try:
        last = json.load(open(NOTIF_LAST)) if os.path.exists(NOTIF_LAST) else {}
        last[NOTIF_TYPE] = {'ts': NOW, 'text': MESSAGE}
        json.dump(last, open(NOTIF_LAST, 'w'))
    except:
        pass
" 2>/dev/null || true
  rm -f "$tmp"
}

get_active_task() {
  python3 -c "
import re
try:
    text = open('$PROJECT_DIR/Plan.md').read()
    m = re.search(r'### (.+?)\n\n.*?Status:.*?IN_PROGRESS', text, re.DOTALL)
    if m: print(m.group(1).strip())
    else: print('(no active task)')
except: print('(error reading Plan.md)')
" 2>/dev/null || echo "(unknown)"
}

if [ ! -d "$PROJECT_DIR/.git" ]; then
  log "ERROR" "Not a git repository: $PROJECT_DIR"
  exit 1
fi

cd "$PROJECT_DIR"
export PATH="/home/ubuntu/.opencode/bin:$PATH"
export GH_REPO="Alaa91H/NOVADownloadManager"

# Initial startup notification (only once, not per cycle)
send_telegram "🟢 **Agent online** — autonomous pipeline engaged" "" "system"

monitor_workflow() {
  local branch="${1:-Dev}"
  local timeout=300
  local interval=30
  local elapsed=0

  if ! command -v gh &>/dev/null; then return; fi

  log "INFO" "Monitoring workflow on $branch..."
  local run_id
  run_id=$(gh run list --repo "$GH_REPO" --branch "$branch" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null) || return
  if [ -z "$run_id" ]; then log "INFO" "No workflow run found"; return; fi

  while [ $elapsed -lt $timeout ]; do
    local status conclusion
    status=$(gh run view "$run_id" --repo "$GH_REPO" --json status --jq '.status' 2>/dev/null) || break
    conclusion=$(gh run view "$run_id" --repo "$GH_REPO" --json conclusion --jq '.conclusion' 2>/dev/null) || break

    if [ "$status" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        log "OK" "CI workflow #$run_id: ✅"
        send_telegram "✅ **CI passed** #$run_id" "" "ci_result"
      else
        log "WARN" "CI workflow #$run_id: ❌ $conclusion"
        send_telegram "❌ **CI failed** #$run_id ($conclusion)" "" "ci_fail"
        echo "$run_id" > "$PROJECT_DIR/.last-ci-failure"
      fi
      return
    fi
    sleep $interval
    elapsed=$((elapsed + interval))
  done
  log "WARN" "Workflow #$run_id timed out"
}

while true; do
  CYCLE_ID=$(date "+%Y%m%d-%H%M%S")
  CYCLE_TIME=$(date "+%Y-%m-%d %H:%M:%S")
  log "INFO" "=== Starting cycle $CYCLE_ID ==="

  # ── Self-update ──
  if [ -f "$SCRIPTS_DIR/self-update.sh" ]; then
    bash "$SCRIPTS_DIR/self-update.sh" 2>&1 | tee -a "$LOG_FILE" || true
  fi

  # ── Read task ──
  ACTIVE_TASK=$(get_active_task)
  log "INFO" "Active task: $ACTIVE_TASK"

  # ── Git Sync (no notification — too frequent) ──
  git fetch origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "fetch failed"
  git checkout Dev 2>&1 | tee -a "$LOG_FILE" || { log "ERROR" "Cannot checkout Dev"; sleep 60; continue; }
  git pull origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "pull failed"
  log "INFO" "Git sync complete"

  # ── Check for CI failures from last cycle ──
  CI_FIX=""
  if [ -f "$PROJECT_DIR/.last-ci-failure" ]; then
    FAILED_RUN=$(cat "$PROJECT_DIR/.last-ci-failure")
    FAILURE_LOG=$(gh run view "$FAILED_RUN" --repo "$GH_REPO" --log --jq '.[].text' 2>/dev/null | tail -100 || echo "unable to fetch logs")
    CI_FIX="⚠️ Previous CI run #$FAILED_RUN FAILED. Fix the issues.
CI Logs (tail):
$FAILURE_LOG"
    rm -f "$PROJECT_DIR/.last-ci-failure"
  fi

  # ── Send ONE notification at cycle start ──
  SEND_TASK="${ACTIVE_TASK:0:60}"
  send_telegram "🔄 **${CYCLE_ID:8:6}** — ${SEND_TASK}" "" "cycle_start"

  # ── Run opencode ──
  log "INFO" "Running opencode..."
  CYCLE_START=$(date +%s)

  set +e
  $OPENCODE run \
    --model "opencode/big-pickle" \
    --auto \
    "Read Plan.md — especially the **NOVA Development Constitution** section. Follow it strictly.
     The Constitution says:
     - NO building on server (no pnpm build, no tauri:build, no E2E tests locally)
     - Research deeply before implementing anything
     - Quality first: strict types, error states, tests for all cases
     - Coverage targets: 10% -> 25% -> 50% -> 75% -> 100%
     - Plan before executing large tasks

     Resume IN_PROGRESS task or start highest priority PLANNED task from the top.
     Read AGENTS.md for quality gates and code standards reference.
     Work on the project: write code, fix issues, refactor, improve quality, update docs.
     After changes, update Plan.md status accordingly (mark tasks IN_PROGRESS/COMPLETED, add new tasks as needed).
     Run allowed quality gates after making changes: lint, typecheck, unit test.
     Commit changes with conventional commits (feat/fix/chore/test/refactor/docs/ci).
     Never mention AI in commits or files.
     Quality gates allowed on server:
     1. pnpm lint (tsc --noEmit)
     2. pnpm lint:eslint
     3. pnpm format:check
     4. pnpm test (unit tests only — NO E2E)
     5. pnpm audit:final
     $CI_FIX" 2>&1 | tee -a "$LOG_FILE"
  EXIT_CODE=$?
  set -e

  CYCLE_END=$(date +%s)
  DURATION=$((CYCLE_END - CYCLE_START))
  DURATION_MIN=$((DURATION / 60))
  DURATION_SEC=$((DURATION % 60))

  # ── Error handling (send only on actual failure) ──
  if [ $EXIT_CODE -ne 0 ]; then
    LAST_LINES=$(tail -20 "$LOG_FILE")
    if echo "$LAST_LINES" | grep -qiE "rate.limit|quota|429|too many|token.limit|unauthorized|401|403|insufficient.quota|model.not.found|context.length"; then
      WAIT=120
      log "WARN" "Rate limit exceeded. Waiting ${WAIT}s..."
      send_telegram "⚠️ **Rate limit** — retry in ${WAIT}s (⏱️ ${DURATION_MIN}m)" "⚠️" "error"
      sleep $WAIT
      continue
    else
      log "WARN" "opencode exited with code $EXIT_CODE. Retrying..."
      send_telegram "⚠️ **Agent error** (exit $EXIT_CODE) — retrying" "❌" "error"
      sleep 30
      continue
    fi
  fi

  # ── Commit & Push ──
  HAS_CHANGES=false
  git add -A 2>&1 | tee -a "$LOG_FILE" || true
  if [ -n "$(git status --porcelain)" ]; then
    git commit -m "chore: dev cycle $CYCLE_ID" 2>&1 | tee -a "$LOG_FILE" || true
    git push origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "push failed"
    HAS_CHANGES=true
    log "OK" "Changes pushed"
    # Monitor CI in background
    monitor_workflow "Dev" &
  else
    log "INFO" "No changes"
  fi

  # ── Send ONE notification at cycle end ──
  CHANGES_ICON="📝" && CHANGES_TEXT="changes pushed"
  if [ "$HAS_CHANGES" = false ]; then CHANGES_ICON="📭" && CHANGES_TEXT="no changes"; fi
  send_telegram "${CHANGES_ICON} **Cycle** ${CYCLE_ID:8:6} — ${CHANGES_TEXT} (${DURATION_MIN}m ${DURATION_SEC}s)" "" "cycle_done"

  # ── Save State ──
  cat > "$STATE_FILE" << STATE_EOF
{
  "last_cycle": "$CYCLE_ID",
  "timestamp": "$CYCLE_TIME",
  "duration_sec": $DURATION,
  "exit_code": $EXIT_CODE,
  "active_task": "$ACTIVE_TASK",
  "has_changes": $HAS_CHANGES,
  "status": "completed"
}
STATE_EOF

  log "OK" "Cycle $CYCLE_ID complete (${DURATION_MIN}m). Sleeping 60s..."
  sleep 60
done
