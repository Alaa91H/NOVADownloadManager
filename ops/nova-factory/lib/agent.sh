#!/usr/bin/env bash
set -Eeuo pipefail

# NOVA Continuous Development Controller v8
# Orchestrator-only mode: this server directs repository work and CI, it does
# not run local build, lint, test, coverage, release, or packaging commands.

PROJECT_DIR="${NOVA_PROJECT_DIR:-${HOME:-/home/${SUDO_USER:-ubuntu}}/NOVA}"
BRANCH="${NOVA_BRANCH:-${NOVA_DEVELOP_BRANCH:-develop}}"
GH_REPO="${NOVA_GH_REPO:-Alaa91H/NOVADownloadManager}"
MODEL="${NOVA_AGENT_MODEL:-opencode/big-pickle}"
VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
STATE_FILE="$VAR_DIR/.agent-state.json"
EVENTS_FILE="$VAR_DIR/events.jsonl"
LOCK_FILE="$VAR_DIR/agent.lock"
LOG_FILE="$LOG_DIR/nova-dev-agent.log"
CHATS_FILE="${NOVA_CHATS_FILE:-$VAR_DIR/bot-chats.json}"
if [[ ! -s "$CHATS_FILE" && -s "$PROJECT_DIR/.bot-chats.json" ]]; then
  CHATS_FILE="$PROJECT_DIR/.bot-chats.json"
fi
LAST_CI_FAILURE_LOG="$VAR_DIR/last-ci-failure.log"
OPENCODE_TIMEOUT="${NOVA_OPENCODE_TIMEOUT:-2400}"
CYCLE_SLEEP="${NOVA_CYCLE_SLEEP:-30}"
FAILURE_BACKOFF="${NOVA_FAILURE_BACKOFF:-180}"
AUDIT_INTERVAL="${NOVA_AUDIT_INTERVAL:-21600}"
AUDIT_MARKER="$VAR_DIR/.last-audit"
LEASE_BIN="${NOVA_LEASE_BIN:-/usr/local/lib/nova/nova-lease.py}"
BRANCH_POLICY_BIN="${NOVA_BRANCH_POLICY_BIN:-/usr/local/lib/nova/nova-branch-policy.py}"
CURRENT_LEASE_ID=""

export HOME="${HOME:-/home/${SUDO_USER:-ubuntu}}"
export PATH="$HOME/.opencode/bin:/usr/local/lib/nova/blocked-bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=384}"
export CI=1

CURRENT_CYCLE="boot"
CURRENT_TASK="startup"
CURRENT_STREAM=""
CYCLE_START_EPOCH=0
CONSECUTIVE_FAILURES=0
OPENCODE_BIN=""

mkdir -p "$VAR_DIR" "$LOG_DIR"
touch "$LOG_FILE"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '[%s] another nova controller instance is already running\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$LOG_FILE"
  exit 0
fi

escape_json() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/ }"
  value="${value//$'\r'/ }"
  printf '%s' "$value"
}

log() {
  local level="$1"
  local msg="$2"
  printf '[%s] [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$level" "$msg" | tee -a "$LOG_FILE"
}

write_state() {
  local status="${1:-running}"
  local phase="${2:-idle}"
  local task="${3:-$CURRENT_TASK}"
  local rc="${4:-0}"
  cat > "$STATE_FILE.tmp" <<JSON
{
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "epoch": $(date +%s),
  "pid": $$,
  "cycle": "$(escape_json "$CURRENT_CYCLE")",
  "status": "$(escape_json "$status")",
  "phase": "$(escape_json "$phase")",
  "task": "$(escape_json "$task")",
  "last_rc": $rc,
  "mode": "orchestrator-only",
  "branch": "$(escape_json "$BRANCH")",
  "repo": "$(escape_json "$GH_REPO")"
}
JSON
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Append a structured lifecycle event to the events journal. The Telegram
# interface tails this file and delivers professional notifications, honouring
# each subscriber's per-type preferences. Never fail the orchestration loop.
# Usage: emit_event <type> <title> [kind] [rc] [dur_seconds]
emit_event() {
  local ntype="$1"
  local title="${2:-}"
  local kind="${3:-}"
  local rc="${4:-0}"
  local dur="${5:-0}"
  local summary="${6:-}"
  [[ "$rc" =~ ^-?[0-9]+$ ]] || rc=0
  [[ "$dur" =~ ^[0-9]+$ ]] || dur=0
  mkdir -p "$VAR_DIR" 2>/dev/null || true
  printf '{"ts":%s,"iso":"%s","type":"%s","cycle":"%s","task":"%s","title":"%s","kind":"%s","stream":"%s","rc":%s,"dur":%s,"summary":"%s","branch":"%s"}\n' \
    "$(date +%s)" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$(escape_json "$ntype")" \
    "$(escape_json "$CURRENT_CYCLE")" \
    "$(escape_json "$CURRENT_TASK")" \
    "$(escape_json "$title")" \
    "$(escape_json "$kind")" \
    "$(escape_json "$CURRENT_STREAM")" \
    "$rc" "$dur" \
    "$(escape_json "$summary")" \
    "$(escape_json "$BRANCH")" \
    >> "$EVENTS_FILE" 2>/dev/null || true
  local lines
  lines="$(wc -l < "$EVENTS_FILE" 2>/dev/null || echo 0)"
  if [[ "$lines" =~ ^[0-9]+$ ]] && (( lines > 600 )); then
    tail -n 300 "$EVENTS_FILE" > "$EVENTS_FILE.tmp" 2>/dev/null && \
      mv "$EVENTS_FILE.tmp" "$EVENTS_FILE" 2>/dev/null || true
  fi
  return 0
}

# Classify the active task into a work kind (analysis/fix/develop/improve/release)
# from its Plan.md stream and title. Sets CURRENT_STREAM as a side effect.
task_kind() {
  local task="$1"
  local block stream low
  block="$(awk -v t="### ${task}" 'index($0,t){f=1} f{print} f&&/^### /&&$0!=t&&NR>1{if(seen)exit; seen=1}' "$PROJECT_DIR/Plan.md" 2>/dev/null | head -n 12 || true)"
  stream="$(printf '%s' "$block" | grep -m1 -oiE 'Stream:[[:space:]]*(FIX|DEVELOP|IMPROVE)' | grep -oiE 'FIX|DEVELOP|IMPROVE' | tr '[:lower:]' '[:upper:]' || true)"
  CURRENT_STREAM="$stream"
  low="$(printf '%s' "$task" | tr '[:upper:]' '[:lower:]')"
  if printf '%s' "$low" | grep -qE 'release|version|bump|semver|publish|tag v|إصدار|نشر'; then
    printf 'release'; return 0
  fi
  case "$stream" in
    FIX) printf 'fix' ;;
    DEVELOP) printf 'develop' ;;
    IMPROVE) printf 'improve' ;;
    *) printf 'build' ;;
  esac
}

# Extract a short plain-language "what it does" line for a task from its Plan.md
# block (prefers the Impact field, falls back to Plan).
task_impact() {
  local task="$1"
  local block line
  block="$(awk -v t="### ${task}" 'index($0,t){f=1;next} f&&/^### /{exit} f{print}' "$PROJECT_DIR/Plan.md" 2>/dev/null | head -n 14 || true)"
  line="$(printf '%s\n' "$block" | grep -m1 -iE '^[[:space:]]*[-*][[:space:]]*Impact:' | sed -E 's/^[[:space:]]*[-*][[:space:]]*Impact:[[:space:]]*//I')"
  [ -z "$line" ] && line="$(printf '%s\n' "$block" | grep -m1 -iE '^[[:space:]]*[-*][[:space:]]*Plan:' | sed -E 's/^[[:space:]]*[-*][[:space:]]*Plan:[[:space:]]*//I')"
  printf '%s' "${line:0:180}"
}

# Human summary of what actually changed in the repo between two commits.
summarize_cycle_changes() {
  local before="$1"
  local after
  after="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo '')"
  if [[ -z "$before" || -z "$after" || "$before" == "$after" ]]; then
    printf 'لا تغييرات في المستودع هذه الدورة'
    return 0
  fi
  local nfiles files subjects
  nfiles="$(git -C "$PROJECT_DIR" diff --name-only "$before..$after" 2>/dev/null | wc -l | tr -d ' ')"
  files="$(git -C "$PROJECT_DIR" diff --name-only "$before..$after" 2>/dev/null | sed 's#.*/##' | head -n 4 | sed ':a;N;$!ba;s/\n/، /g')"
  subjects="$(git -C "$PROJECT_DIR" log --no-merges --pretty='%s' "$before..$after" 2>/dev/null | head -n 3 | sed ':a;N;$!ba;s/\n/ · /g')"
  printf '%s — %s ملف: %s' "$subjects" "$nfiles" "$files"
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
      -d "text=NOVA controller: $message" \
      -d "disable_notification=true" >/dev/null 2>&1 || true
  done
}

detect_opencode() {
  local candidates=()
  [[ -n "${NOVA_OPENCODE:-}" ]] && candidates+=("$NOVA_OPENCODE")
  candidates+=("$HOME/.opencode/bin/opencode" "/usr/local/bin/opencode")
  if command -v opencode >/dev/null 2>&1; then
    candidates+=("$(command -v opencode)")
  fi
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      OPENCODE_BIN="$candidate"
      return 0
    fi
  done
  log "ERROR" "opencode executable was not found"
  return 1
}

run_logged() {
  local label="$1"
  local limit="$2"
  shift 2

  log "INFO" "starting $label"
  write_state "running" "$label" "$CURRENT_TASK" 0

  set +e
  timeout --foreground "$limit" "$@" >> "$LOG_FILE" 2>&1 &
  local child=$!
  while kill -0 "$child" >/dev/null 2>&1; do
    sleep 30
    write_state "running" "$label" "$CURRENT_TASK" 0
  done
  wait "$child"
  local rc=$?
  set -e

  log "INFO" "$label finished rc=$rc"
  write_state "finished" "$label" "$CURRENT_TASK" "$rc"
  return "$rc"
}

acquire_task_lease() {
  local purpose="${1:-task}"
  CURRENT_LEASE_ID=""
  if [[ ! -x "$LEASE_BIN" ]]; then
    return 0
  fi
  local lease_json
  lease_json="$($LEASE_BIN acquire agent --owner "agent:$$" --ttl "$((OPENCODE_TIMEOUT + 900))" --reason "opencode:$purpose" 2>/dev/null || true)"
  CURRENT_LEASE_ID="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); print(d.get("id","") if d.get("ok") else "")' "$lease_json" 2>/dev/null || true)"
  if [[ -z "$CURRENT_LEASE_ID" ]]; then
    log "WARN" "could not acquire agent lease; proceeding cautiously"
  else
    log "INFO" "acquired agent lease $CURRENT_LEASE_ID"
  fi
}

release_task_lease() {
  if [[ -n "${CURRENT_LEASE_ID:-}" && -x "$LEASE_BIN" ]]; then
    "$LEASE_BIN" release "$CURRENT_LEASE_ID" >/dev/null 2>&1 || true
    log "INFO" "released agent lease $CURRENT_LEASE_ID"
  fi
  CURRENT_LEASE_ID=""
}

run_opencode() {
  local purpose="$1"
  local prompt="$2"
  local prompt_file="$VAR_DIR/prompt-${CURRENT_CYCLE}-${purpose}.txt"
  printf '%s
' "$prompt" > "$prompt_file"
  acquire_task_lease "$purpose"
  set +e
  run_logged "opencode:$purpose" "$OPENCODE_TIMEOUT" "$OPENCODE_BIN" run --model "$MODEL" --auto "$(cat "$prompt_file")"
  local rc=$?
  set -e
  release_task_lease
  return "$rc"
}

get_active_task() {
  python3 - "$PROJECT_DIR/Plan.md" <<'PY' 2>/dev/null || true
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.exists():
    print("")
    raise SystemExit

text = path.read_text(encoding="utf-8", errors="replace")
sections = re.split(r"\n(?=###\s+)", text)

def pick(status_text: str) -> str:
    for section in sections:
        lines = section.strip().splitlines()
        if not lines or not lines[0].startswith("### "):
            continue
        if re.search(r"^\s*-\s*Status:\s*`" + re.escape(status_text) + r"`", section, re.MULTILINE):
            return lines[0].replace("###", "", 1).strip()
    return ""

print(pick("[/] IN_PROGRESS") or pick("[ ] PLANNED"))
PY
}

has_open_tasks() {
  grep -Eq 'Status:\s*`\[/\] IN_PROGRESS`|Status:\s*`\[ \] PLANNED`' "$PROJECT_DIR/Plan.md"
}

server_busy() {
  local available_mb load cores load_int
  available_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  load=$(cut -d' ' -f1 /proc/loadavg)
  cores=$(nproc)
  load_int="${load%.*}"
  [[ "$available_mb" -lt 140 || "$load_int" -gt $((cores * 4)) ]]
}

sync_repo() {
  cd "$PROJECT_DIR"
  git config pull.rebase true >/dev/null 2>&1 || true
  git fetch origin "$BRANCH" >> "$LOG_FILE" 2>&1 || {
    log "WARN" "git fetch failed"
    return 0
  }
  git checkout "$BRANCH" >> "$LOG_FILE" 2>&1 || {
    log "WARN" "git checkout $BRANCH failed"
    return 0
  }
  if [[ -z "$(git status --porcelain)" ]]; then
    git pull --ff-only origin "$BRANCH" >> "$LOG_FILE" 2>&1 || log "WARN" "git pull failed"
  else
    log "WARN" "worktree has local changes; skipping pull until changes are committed or cleaned"
  fi
}

orchestrator_rules() {
  cat <<'RULES'
Operating law (governed by CONSTITUTION.md and AGENTS.md in the repository; the charter wins on any conflict):
- Voice: neutral, professional, project-maintenance language in every commit, PR, issue, comment, branch name, release note, doc, code comment, log, and generated file. Never identify as an AI, agent, bot, assistant, or model; no tool names; no AI attribution or co-author trailers. Never impersonate a real person.
- Green Gate: while develop CI is red, the ONLY permitted work is restoring it to green. Start no new feature, test, or refactor while develop is red.
- Validation before push: use lightweight static inspection only, then commit and push. The authoritative typecheck/lint/test/build gates run in GitHub Actions. Never claim validation is green until CI proves it.
- Resource limits: NEVER run on this node: `pnpm`, `npm`, `npx`, `yarn`, `tsc`, `eslint`, `vitest`, `vite build`, `pnpm build`, the full test suite, coverage, bundle/package, Tauri or cargo build/check, Playwright/E2E, native-curl build, installers, or dependency installs. Those run only in GitHub Actions.
- Never block on CI: do not run `sleep` and do not poll `gh run watch`/`view`/`list` in a wait loop. Make your change, run preflight, commit, push, and END the session immediately. The previous push's CI result is inspected at the start of the next cycle and repaired then. A single non-blocking `gh run list`/`gh run view` for context is allowed.
- Lightweight repo commands (git, gh, rg, sed, awk, node for tiny parsing) and file edits are always allowed. Full system permissions exist for service self-maintenance, but never consume this node with heavy builds or the full test suite.
- Never force-push or rewrite history on main/develop/Dev. Never weaken safety guards, timeouts, memory caps, or CI gates. Secrets stay in the environment file and are never printed or committed.

Priority ladder (work strictly top-down; never start a lower tier while a higher one is unmet):
1. develop build/CI RED -> the ONLY work is restoring green based on CI evidence: typecheck, tests, lint, translations, build. No features, no refactors.
2. develop GREEN but unstable (flaky or failing tests, type/lint errors, broken core user flow) -> stabilize before anything new.
3. develop STABLE green -> highest-value FIX first, then DEVELOP (features), then IMPROVE (quality/perf/a11y/docs).
Development is forbidden while the build fails or the branch is unstable. Stability precedes new work, always.

Release policy (build is not publish):
- Dev: every push runs the full CI build + tests but PUBLISHES NOTHING. This is how errors are discovered and fixed. Never publish from develop.
- Experimental/beta: when develop is green at a milestone, a pre-release tag vX.Y.Z-beta.N produces a validation-only build (GitHub pre-release; never overwrites a stable release).
- Stable: promote to main only when develop has passed the full gate suite with no open P0/P1 defects and no regression in any shipped platform; tag vX.Y.Z (SemVer: patch=fix, minor=feature, major=breaking) to build and publish. Anything beyond a patch must prove itself on the beta channel first. Never overwrite a published release; never build installers on this node.

Dependency updates: Dependabot proposes them; validate each in CI and merge only green ones, one ecosystem at a time. NEVER hand-regenerate the pnpm lockfile and never run install/build here - the lockfile is authoritative and fragile; a bad regeneration breaks the extension build. Let CI resolve and prove dependency changes.

Operate continuously and autonomously: take the highest unmet tier, make one scoped change, validate, commit, push, end the cycle. Do not wait for CI.
RULES
}

planning_doctrine() {
  cat <<'DOC'
Analyze the whole project from real evidence (code, tests, CI logs, open issues) across three streams and record findings as tasks in the project Plan.md file:
  1. FIX     — real defects: failing tests/CI, type or lint errors, broken behavior, regressions, security issues, i18n gaps.
  2. DEVELOP — missing or incomplete features and platform coverage that add genuine user value.
  3. IMPROVE — quality: refactors, performance, accessibility, error/loading/empty states, documentation, and coverage of untested real code paths.

Record each task in EXACTLY this shape so the controller can parse and execute it:

### <imperative task title>
- Status: `[ ] PLANNED`
- Stream: FIX | DEVELOP | IMPROVE
- Priority: P0 | P1 | P2 | P3
- Impact: <who or what benefits, one line>
- Plan: <concise implementation approach>
- Acceptance: <objective, testable done-criteria>
- Validation: <which gate or CI job proves it>

Prioritize: P0 = anything keeping Dev red or users broken; P1 = high-value fixes and features; P2/P3 = improvements.
Keep each task concrete and small enough to finish in one focused cycle. Never invent work — every task must trace to real evidence.
DOC
}

generate_new_plan() {
  run_opencode "plan-generation" "The roadmap has no open tasks. Produce the next wave of professional objectives.

$(orchestrator_rules)

$(planning_doctrine)

Then mark exactly ONE highest-impact task as \`[/] IN_PROGRESS\` (respect the Green Gate: if develop is red that task must be a FIX). Commit Plan.md."
}

audit_and_extend_plan() {
  run_opencode "audit" "Periodic deep analysis pass. Refresh the roadmap with newly discovered work.

$(orchestrator_rules)

$(planning_doctrine)

Rules for this pass:
- APPEND newly discovered tasks; do NOT change or remove the task currently marked \`[/] IN_PROGRESS\`.
- De-duplicate against tasks already present in Plan.md.
- If develop CI is red, add only FIX tasks. Commit Plan.md."
}

audit_due() {
  local last now
  last="$(cat "$AUDIT_MARKER" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  (( now - last >= AUDIT_INTERVAL ))
}

mark_audited() { date +%s > "$AUDIT_MARKER" 2>/dev/null || true; }

execute_task() {
  local task="$1"
  run_opencode "task" "Continue NOVA Download Manager development using the adopted branch policy.

Active task:
$task

$(orchestrator_rules)

Execution rules:
- Follow Plan.md from top to bottom.
- If no task is truly in progress, promote the highest-priority planned task and document why.
- For medium or large changes, write the professional plan in Plan.md before editing.
- Keep changes scoped, typed, i18n-aware, and ready for CI validation.
- Commit-worthy work should be pushed so GitHub Actions can build and test it.
- End this session immediately after your commit is pushed. Do not wait for, watch, or poll CI in this session; the next cycle inspects and repairs CI automatically.
- If a previous GitHub Actions run failed, its logs are provided to you at cycle start for repair; fix the root cause, push, and end.
- Update Plan.md with status, CI validation links/results, and notes."
}

repair_ci_failure() {
  local run_id="$1"
  emit_event ci_fail "فشل فحوصات CI (تشغيل #$run_id) — جارٍ معالجة السبب الجذري" fix 1
  local ci_tail
  ci_tail="$(tail -260 "$LAST_CI_FAILURE_LOG" 2>/dev/null || true)"
  run_opencode "ci-repair-$run_id" "GitHub Actions failed for NOVA on $BRANCH.

$(orchestrator_rules)

Fix the root cause from this CI log excerpt, update Plan.md validation notes, commit, and push.

CI log excerpt:
$ci_tail"
}

diff_sanity_check() {
  cd "$PROJECT_DIR"
  git diff --check >> "$LOG_FILE" 2>&1
}

prepare_policy_branch_if_needed() {
  cd "$PROJECT_DIR"
  if [[ ! -x "$BRANCH_POLICY_BIN" ]]; then
    return 0
  fi
  local current_branch guard_json allowed reason kind work_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$BRANCH")"
  guard_json="$($BRANCH_POLICY_BIN guard-push "$current_branch" --purpose "agent-cycle" 2>/dev/null || true)"
  allowed="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); print("1" if d.get("allowed") else "0")' "$guard_json" 2>/dev/null || echo 0)"
  if [[ "$allowed" == "1" ]]; then
    return 0
  fi
  reason="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); print(d.get("reason", "branch policy denied direct push"))' "$guard_json" 2>/dev/null || echo 'branch policy denied direct push')"
  kind="$(task_kind "$CURRENT_TASK")"
  work_branch="$($BRANCH_POLICY_BIN branch-name --job-id "$CURRENT_CYCLE" --kind "$kind" --title "$CURRENT_TASK" 2>/dev/null || true)"
  if [[ -z "$work_branch" ]]; then
    log "ERROR" "branch policy denied direct push to $current_branch and no safe work branch could be generated: $reason"
    return 1
  fi
  log "INFO" "branch policy: $reason; switching to $work_branch for PR-based work"
  git checkout -B "$work_branch" >> "$LOG_FILE" 2>&1 || return 1
  return 0
}

open_policy_pr_if_needed() {
  local push_branch="$1"
  if [[ "$push_branch" == "$BRANCH" ]]; then
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1; then
    log "WARN" "gh unavailable; pushed $push_branch but could not open PR to $BRANCH"
    return 0
  fi
  local title body
  title="$(git log -1 --pretty=%s 2>/dev/null || echo "chore: nova branch policy work")"
  body="Automated scoped branch prepared by NOVA branch policy. Base: $BRANCH. Task: $CURRENT_TASK. CI must prove the change before merge."
  gh pr create -R "$GH_REPO" --base "$BRANCH" --head "$push_branch" --title "$title" --body "$body" >> "$LOG_FILE" 2>&1 || \
    log "INFO" "PR creation skipped or already exists for $push_branch"
}

commit_and_push() {
  cd "$PROJECT_DIR"
  if [[ -z "$(git status --porcelain)" ]]; then
    log "INFO" "no repository changes to commit"
    return 0
  fi

  if ! diff_sanity_check; then
    log "ERROR" "git diff --check failed; leaving changes for next repair cycle"
    return 1
  fi

  prepare_policy_branch_if_needed || return 1
  local push_branch
  push_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$BRANCH")"

  git add -A
  # Safeguard: server-only runtime state and local tooling must never reach the
  # repository, even if a stray copy appears. Unstage any such path defensively.
  git reset -q -- \
    '.agent-state.json' '.bot-chats.json' '.notif-last.json' '.notif-prefs.json' \
    '.notif-cursor.json' 'events.jsonl' '.last-ci-failure' \
    'nova-bot.py' 'nova-bot.py.bak-*' 'nova-bot-update.py' 'nova-dev-agent.sh' \
    'nova-watchdog.py' 'nova-*.service' 'nova-*.timer' \
    'AGENTS.md' 'CONSTITUTION.md' 'agent.log' 'nova-agent.log' 'watchdog.log' \
    >/dev/null 2>&1 || true
  if git diff --cached --quiet; then
    log "INFO" "no staged changes after git add"
    return 0
  fi

  local message="chore: dev cycle ${CURRENT_CYCLE}"
  git commit -m "$message" >> "$LOG_FILE" 2>&1 || {
    log "ERROR" "git commit failed"
    return 1
  }

  git push -u origin "$push_branch" >> "$LOG_FILE" 2>&1 || {
    log "WARN" "initial push failed; trying rebase then push"
    git pull --rebase origin "$BRANCH" >> "$LOG_FILE" 2>&1 || return 1
    git push -u origin "$push_branch" >> "$LOG_FILE" 2>&1 || return 1
  }
  open_policy_pr_if_needed "$push_branch"
  log "INFO" "changes pushed to $push_branch"
}

monitor_ci_failures() {
  if ! command -v gh >/dev/null 2>&1; then
    log "WARN" "gh is unavailable; cannot monitor CI"
    return 0
  fi

  local runs_file="$VAR_DIR/gh-runs.json"
  gh run list -R "$GH_REPO" --branch "$BRANCH" --limit 8 --json databaseId,status,conclusion,name,headSha,createdAt > "$runs_file" 2>> "$LOG_FILE" || {
    log "WARN" "gh run list failed"
    return 0
  }

  local failed_run
  failed_run=$(python3 - "$runs_file" "$VAR_DIR/last-ci-run-id" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path

runs = json.load(open(sys.argv[1], "r", encoding="utf-8"))
seen_path = Path(sys.argv[2])
seen = seen_path.read_text().strip() if seen_path.exists() else ""
for run in runs:
    if run.get("status") == "completed" and run.get("conclusion") in {"failure", "cancelled", "timed_out"}:
        rid = str(run.get("databaseId"))
        if rid and rid != seen:
            print(rid)
            raise SystemExit
print("")
PY
)
  [[ -z "$failed_run" ]] && return 0

  printf '%s' "$failed_run" > "$VAR_DIR/last-ci-run-id"
  log "WARN" "detected failed CI run $failed_run"
  gh run view "$failed_run" -R "$GH_REPO" --log-failed > "$LAST_CI_FAILURE_LOG" 2>> "$LOG_FILE" || true
  repair_ci_failure "$failed_run" || true
  commit_and_push || true
}

cleanup_housekeeping() {
  find "$VAR_DIR" -maxdepth 1 -name 'prompt-*.txt' -mtime +3 -delete 2>/dev/null || true
  find "$LOG_DIR" -maxdepth 1 -name 'nova-*.log' -size +50M -exec sh -c 'tail -n 5000 "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \; 2>/dev/null || true
}

main_loop() {
  detect_opencode || {
    write_state "error" "missing-opencode" "$CURRENT_TASK" 127
    emit_event error "تعذّر العثور على محرّك التنفيذ على الخادم" system 127
    sleep "$FAILURE_BACKOFF"
    return 1
  }

  while true; do
    CURRENT_CYCLE="$(date -u '+%Y%m%d-%H%M%S')"
    CURRENT_TASK="cycle-start"
    write_state "running" "cycle-start" "$CURRENT_TASK" 0
    log "INFO" "=== orchestrator cycle $CURRENT_CYCLE started ==="

    if server_busy; then
      log "WARN" "server under resource pressure; cooling down before orchestration"
      sleep 60
    fi

    sync_repo

    if ! has_open_tasks; then
      CURRENT_TASK="deep-plan-generation"
      CURRENT_STREAM=""
      emit_event analysis "تحليل شامل للمشروع وتوليد خطة عمل جديدة" analysis
      generate_new_plan || true
      mark_audited
    elif audit_due; then
      CURRENT_TASK="periodic-audit"
      CURRENT_STREAM=""
      emit_event analysis "مراجعة تحليلية دورية وتحديث خطة العمل" analysis
      audit_and_extend_plan || true
      mark_audited
    fi

    CURRENT_TASK="$(get_active_task)"
    [[ -z "$CURRENT_TASK" ]] && CURRENT_TASK="مراجعة المستودع واختيار المهمة التالية"

    log "INFO" "target task: $CURRENT_TASK"
    local task_kind_label task_desc head_before task_rc cycle_summary
    task_kind_label="$(task_kind "$CURRENT_TASK")"
    task_desc="$(task_impact "$CURRENT_TASK")"
    head_before="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo '')"
    CYCLE_START_EPOCH="$(date +%s)"
    emit_event cycle_start "$CURRENT_TASK" "$task_kind_label" 0 0 "$task_desc"
    if execute_task "$CURRENT_TASK"; then
      CONSECUTIVE_FAILURES=0
      task_rc=0
    else
      CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
      task_rc=1
      log "WARN" "opencode returned non-zero; consecutive failures=$CONSECUTIVE_FAILURES"
    fi

    commit_and_push || true

    cycle_summary="$(summarize_cycle_changes "$head_before")"
    emit_event cycle_done "$CURRENT_TASK" "$task_kind_label" "$task_rc" \
      "$(( $(date +%s) - CYCLE_START_EPOCH ))" "$cycle_summary"
    if (( CONSECUTIVE_FAILURES >= 3 )); then
      emit_event error "تعذّر إكمال المهمة $CONSECUTIVE_FAILURES مرات متتالية — تحتاج مراجعة" "$task_kind_label" 1
    fi
    monitor_ci_failures || true
    cleanup_housekeeping

    write_state "sleeping" "cycle-complete" "$CURRENT_TASK" 0
    local sleep_for="$CYCLE_SLEEP"
    if [[ "$CONSECUTIVE_FAILURES" -gt 0 ]]; then
      sleep_for="$FAILURE_BACKOFF"
    fi
    log "INFO" "cycle $CURRENT_CYCLE complete; sleeping ${sleep_for}s"
    sleep "$sleep_for"
  done
}

trap 'log "INFO" "received stop signal"; release_task_lease; write_state "stopping" "signal" "$CURRENT_TASK" 0; exit 0' SIGTERM SIGINT

main_loop
