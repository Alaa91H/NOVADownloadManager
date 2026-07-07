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
  # Python exit 0 → send, exit 1 → skip
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
    sys.exit(1)
if prev.get('text', '') == msg:
    sys.exit(1)
sys.exit(0)
" 2>/dev/null; then
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
    # Find first h3 header followed by IN_PROGRESS within the same section
    sections = re.split(r'\n### ', text)
    for s in sections:
        if 'IN_PROGRESS' in s and not s.startswith('Status'):
            lines = s.strip().split('\n')
            title = lines[0].strip().rstrip('#').strip()
            if title and not title.startswith('Status'):
                print(title[:80])
                break
    else:
        print('(no active task)')
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
send_telegram "🟢 **Agent online** — autonomous pipeline engaged" "" "system" || true

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

  # ── Memory: prevent OOM from Node/tsc ──
  export NODE_OPTIONS="--max-old-space-size=384"
  sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true

  # ── Self-update ──
  if [ -f "$SCRIPTS_DIR/self-update.sh" ]; then
    bash "$SCRIPTS_DIR/self-update.sh" 2>&1 | tee -a "$LOG_FILE" || true
  fi

  # ── Read task + last cycle context ──
  ACTIVE_TASK=$(get_active_task)
  log "INFO" "Active task: $ACTIVE_TASK"
  LAST_RESULT=""
  if [ -f "$STATE_FILE" ]; then
    LAST_RESULT=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(f\"Previous: {d.get('status','?')} / {d.get('duration_sec',0)//60}m / exit={d.get('exit_code',0)}\")" 2>/dev/null || echo "")
    log "INFO" "$LAST_RESULT"
  fi

  # ── Git Sync ──
  git fetch origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "fetch failed"
  git checkout Dev 2>&1 | tee -a "$LOG_FILE" || { log "ERROR" "Cannot checkout Dev"; sleep 5; continue; }
  git pull origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "pull failed"
  log "INFO" "Git sync complete"

  # ── CI failure context ──
  CI_FIX=""
  if [ -f "$PROJECT_DIR/.last-ci-failure" ]; then
    FAILED_RUN=$(cat "$PROJECT_DIR/.last-ci-failure")
    FAILURE_LOG=$(timeout 10 gh run view "$FAILED_RUN" --repo "$GH_REPO" --log --jq '.[].text' 2>/dev/null | tail -30 || echo "unable to fetch logs")
    CI_FIX="Previous CI run #$FAILED_RUN FAILED. Fix the issues. Logs: $FAILURE_LOG"
    rm -f "$PROJECT_DIR/.last-ci-failure"
  fi

  # ── Run opencode ──
  log "INFO" "Running opencode..."
  CYCLE_START=$(date +%s)

  set +e
  timeout 3600 \
  $OPENCODE run \
    --model "opencode/big-pickle" \
    --auto \
    "Read Plan.md and continue the IN_PROGRESS task.

RULES:
- NO pnpm build, tauri:build, E2E tests, quality gates, or coverage
- Write code only. Commit and push when done.
- If stuck or blocked, commit partial work and move on
- Use conventional commits
- You have 60 minutes — use them fully
$CI_FIX" 2>&1 | tee -a "$LOG_FILE"
  EXIT_CODE=$?
  set -e
  unset NODE_OPTIONS

  CYCLE_END=$(date +%s)
  DURATION=$((CYCLE_END - CYCLE_START))
  DURATION_MIN=$((DURATION / 60))

  # ── Error handling ──
  if [ $EXIT_CODE -ne 0 ]; then
    if [ $EXIT_CODE -eq 124 ]; then
      log "WARN" "opencode timed out (60m). Retrying..."
      send_telegram "⏰ **Cycle timed out** (60m)" "" "error"
      sleep 2
      continue
    fi
    LAST_LINES=$(tail -10 "$LOG_FILE")
    if echo "$LAST_LINES" | grep -qiE "rate.limit|quota|429|too many|token.limit|unauthorized|401|403|insufficient.quota|model.not.found|context.length"; then
      log "WARN" "Rate limit. Waiting 120s..."
      send_telegram "⚠️ **Rate limit** — 120s wait" "⚠️" "error"
      sleep 120
      continue
    fi
    log "WARN" "opencode exited with code $EXIT_CODE. Retrying..."
    send_telegram "⚠️ **Agent error** (exit $EXIT_CODE)" "❌" "error"
    sleep 10
    continue
  fi

  # ── Commit & Push ──
  HAS_CHANGES=false
  git add -A 2>&1 | tee -a "$LOG_FILE" || true
  if [ -n "$(git status --porcelain)" ]; then
    git commit -m "chore: dev $CYCLE_ID" 2>&1 | tee -a "$LOG_FILE" || true
    git push origin Dev 2>&1 | tee -a "$LOG_FILE" || log "WARN" "push failed"
    HAS_CHANGES=true
    log "OK" "Changes pushed"
    # Background: quality gates + CI monitor
    (NODE_OPTIONS="--max-old-space-size=384" timeout 120 bash -c "pnpm lint 2>&1 | tee -a '$LOG_FILE'" 2>/dev/null || true) &
    (timeout 120 bash -c "pnpm lint:eslint 2>&1 | tee -a '$LOG_FILE'" 2>/dev/null || true) &
    (monitor_workflow "Dev" 2>&1 | tee -a "$LOG_FILE") &
  else
    log "INFO" "No changes"
    # Background: quick lint for diagnostics
    (NODE_OPTIONS="--max-old-space-size=384" timeout 60 bash -c "pnpm lint 2>&1 | tail -5 >> '$LOG_FILE'" 2>/dev/null) &
  fi

  # ── Notification ──
  if [ "$HAS_CHANGES" = true ]; then
    send_telegram "📝 **${CYCLE_ID:8:6}** — pushed (${DURATION_MIN}m)" "" "cycle_done"
  fi

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

  log "OK" "Cycle $CYCLE_ID complete (${DURATION_MIN}m)"
done
