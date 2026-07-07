#!/usr/bin/env bash
# ============================================================
#  NOVA Continuous Development Agent (24/7)
#  opencode big-pickle: autonomous project maintenance
#  Sends Telegram notifications via nova-bot's chat registry
#  AGENTS.md reference at PROJECT_DIR/AGENTS.md
#  Plan.md task management at PROJECT_DIR/Plan.md
#  Logs: /var/log/nova-dev-agent.log
# ============================================================
set -euo pipefail

PROJECT_DIR="/home/ubuntu/NOVA"
LOG_FILE="/var/log/nova-dev-agent.log"
STATE_FILE="$PROJECT_DIR/.agent-state.json"
CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
OPENCODE="/home/ubuntu/.opencode/bin/opencode"
BOT_TOKEN="8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY"

log() {
  local level="$1"
  local msg="$2"
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] [$level] $msg" | tee -a "$LOG_FILE"
}

send_telegram() {
  local message="$1"
  local icon="${2:-🤖}"
  local notif_type="${3:-system}"
  local full_msg="$icon NOVA Agent [$(hostname)]: $message"

  if [ ! -f "$CHATS_FILE" ]; then
    return
  fi

  # Use Python to filter by notification preferences
  python3 -c "
import json, urllib.request, urllib.parse

BOT_TOKEN = '$BOT_TOKEN'
CHATS_FILE = '$CHATS_FILE'
NOTIF_FILE = '$PROJECT_DIR/.notif-prefs.json'
NOTIF_TYPE = '$notif_type'
MESSAGE = '''$full_msg'''

# Load chat list
try:
    chats = json.load(open(CHATS_FILE))
except:
    exit(0)

# Load notification preferences
prefs = {}
try:
    prefs = json.load(open(NOTIF_FILE))
except:
    pass

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
    }).encode()
    try:
        urllib.request.urlopen(url, data=data, timeout=5)
    except:
        pass
" 2>/dev/null || true
}

get_active_task() {
  python3 -c "
import re
try:
    text = open('$PROJECT_DIR/Plan.md').read()
    m = re.search(r'### (.+?)\n\n.*?Status:.*?IN_PROGRESS', text, re.DOTALL)
    if m:
        print(m.group(1).strip())
    else:
        print('(no active task)')
except:
    print('(error reading Plan.md)')
" 2>/dev/null || echo "(unknown)"
}

if [ ! -d "$PROJECT_DIR/.git" ]; then
  log "ERROR" "Not a git repository: $PROJECT_DIR"
  exit 1
fi

cd "$PROJECT_DIR"
export PATH="/home/ubuntu/.opencode/bin:$PATH"
export GH_REPO="Alaa91H/NOVADownloadManager"

send_telegram "🟢 **Agent started** — entering continuous loop" "🚀" "system"
LAST_NOTIFY=""

monitor_workflow() {
  local branch="${1:-Dev}"
  local timeout=300
  local interval=30
  local elapsed=0

  if ! command -v gh &>/dev/null; then
    log "WARN" "gh CLI not installed — skipping CI monitoring"
    return
  fi

  log "INFO" "Monitoring latest workflow run on $branch..."
  local run_id
  run_id=$(gh run list --repo "$GH_REPO" --branch "$branch" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null) || return

  if [ -z "$run_id" ]; then
    log "INFO" "No workflow run found for $branch"
    return
  fi

  log "INFO" "Workflow #$run_id — waiting for completion..."

  while [ $elapsed -lt $timeout ]; do
    local status conclusion
    status=$(gh run view "$run_id" --repo "$GH_REPO" --json status --jq '.status' 2>/dev/null) || break
    conclusion=$(gh run view "$run_id" --repo "$GH_REPO" --json conclusion --jq '.conclusion' 2>/dev/null) || break

    if [ "$status" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        log "OK" "CI workflow #$run_id: ✅ SUCCESS"
        send_telegram "✅ **CI workflow passed** #$run_id" "" "ci_result"
      else
        log "WARN" "CI workflow #$run_id: ❌ $conclusion"
        send_telegram "❌ **CI workflow failed** #$run_id\nconclusion: $conclusion\nBranch: $branch\n\nالوكيل سيصلح الأخطاء في الدورة القادمة." "" "ci_fail"
        # Save failure to state for next opencode cycle
        echo "$run_id" > "$PROJECT_DIR/.last-ci-failure"
      fi
      return
    fi

    sleep $interval
    elapsed=$((elapsed + interval))
  done

  log "WARN" "Workflow #$run_id did not complete within ${timeout}s timeout"
}

while true; do
  CYCLE_ID=$(date "+%Y%m%d-%H%M%S")
  CYCLE_TIME=$(date "+%Y-%m-%d %H:%M:%S")
  log "INFO" "=== Starting cycle $CYCLE_ID ==="

  # ---------- Read current task from Plan.md ----------
  ACTIVE_TASK=$(get_active_task)
  log "INFO" "Active task: $ACTIVE_TASK"
  send_telegram "🔄 **Cycle $CYCLE_ID**\n📋 Task: $ACTIVE_TASK" "" "cycle_start"

  # ---------- Git Sync ----------
  log "INFO" "Syncing with origin Dev..."
  send_telegram "📡 Syncing git..." "" "system"
  git fetch origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "fetch failed"
  git checkout Dev 2>&1 | tee -a "$LOG_FILE" || { log "ERROR" "Cannot checkout Dev"; sleep 60; continue; }
  git pull origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "pull failed"
  log "INFO" "Git sync complete"

  # ---------- Run opencode ----------
  log "INFO" "Running opencode big-pickle agent"
  send_telegram "🧠 Running opencode on task: **$ACTIVE_TASK**" "" "cycle_start"

  CYCLE_START=$(date +%s)

  # Check if previous CI run failed — add to prompt
  local CI_FIX=""
  if [ -f "$PROJECT_DIR/.last-ci-failure" ]; then
    local FAILED_RUN
    FAILED_RUN=$(cat "$PROJECT_DIR/.last-ci-failure")
    local FAILURE_LOG
    FAILURE_LOG=$(gh run view "$FAILED_RUN" --repo "$GH_REPO" --log --jq '.[].text' 2>/dev/null | tail -100 || echo "unable to fetch logs")
    CI_FIX="⚠️ **Previous CI run #$FAILED_RUN FAILED** — logs below.
    Please analyze the failure and fix the underlying issues in the code.
    CI Logs:
    $FAILURE_LOG"
    rm -f "$PROJECT_DIR/.last-ci-failure"
  fi

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

  # ---------- Handle rate limit / quota errors ----------
  if [ $EXIT_CODE -ne 0 ]; then
    LAST_LINES=$(tail -30 "$LOG_FILE")
    if echo "$LAST_LINES" | grep -qiE "rate.limit|quota|429|too many|token.limit|unauthorized|401|403|insufficient.quota|model.not.found|context.length"; then
      WAIT=120
      log "WARN" "Rate limit or quota exceeded. Waiting ${WAIT}s before retry..."
      send_telegram "⏳ **Rate limit / Quota exceeded!**\nWaiting ${WAIT}s before retry...\n⏱️ Duration: ${DURATION_MIN}m ${DURATION_SEC}s" "⚠️" "error"
      sleep $WAIT
      continue
    else
      log "WARN" "opencode exited with code $EXIT_CODE. Retrying in 30s..."
      send_telegram "⚠️ opencode exited with code \`$EXIT_CODE\`\nRetrying in 30s...\n⏱️ Duration: ${DURATION_MIN}m ${DURATION_SEC}s" "❌" "error"
      sleep 30
      continue
    fi
  fi

  # ---------- Commit & Push ----------
  log "INFO" "Staging and pushing changes"
  git add -A 2>&1 | tee -a "$LOG_FILE" || true
  if [ -n "$(git status --porcelain)" ]; then
    git commit -m "chore: continuous dev cycle $CYCLE_ID" 2>&1 | tee -a "$LOG_FILE" || true
    git push origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "push failed"
    log "OK" "Changes pushed to Dev"
    send_telegram "✅ **Cycle complete** — changes pushed to \`Dev\`\n⏱️ Duration: ${DURATION_MIN}m ${DURATION_SEC}s\n📋 Task: $ACTIVE_TASK" "" "cycle_done"
    # Monitor CI after push
    monitor_workflow "Dev" &
  else
    log "INFO" "No changes to commit"
    send_telegram "✅ **Cycle complete** — no changes\n⏱️ Duration: ${DURATION_MIN}m ${DURATION_SEC}s\n📋 Task: $ACTIVE_TASK" "" "cycle_done"
  fi

  # ---------- Save State ----------
  cat > "$STATE_FILE" << STATE_EOF
{
  "last_cycle": "$CYCLE_ID",
  "timestamp": "$CYCLE_TIME",
  "duration_sec": $DURATION,
  "exit_code": $EXIT_CODE,
  "active_task": "$ACTIVE_TASK",
  "status": "completed"
}
STATE_EOF

  log "OK" "Cycle $CYCLE_ID complete (${DURATION_MIN}m ${DURATION_SEC}s). Sleeping 60s before next cycle..."
  sleep 60
done
