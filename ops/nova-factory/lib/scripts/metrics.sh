#!/usr/bin/env bash
# NOVA metrics snapshot for an orchestrator-only server.
# Does not run local package managers, compilers, linters, tests, or builds.
set -euo pipefail

PROJECT_DIR="${1:-${NOVA_PROJECT_DIR:-$(pwd)}}"
METRICS_FILE="${NOVA_METRICS_FILE:-$PROJECT_DIR/.metrics.json}"
BRANCH="${NOVA_BRANCH:-${NOVA_DEVELOP_BRANCH:-develop}}"
GH_REPO="${NOVA_GH_REPO:-}"
cd "$PROJECT_DIR"

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mkdir -p "$(dirname "$METRICS_FILE")"
[[ -f "$METRICS_FILE" ]] || printf '{"snapshots":[]}
' > "$METRICS_FILE"

ts_files=$(find . -path ./.git -prune -o -path ./node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print 2>/dev/null | wc -l | tr -d ' ')
rs_files=$(find . -path ./.git -prune -o -path ./target -prune -o -type f -name '*.rs' -print 2>/dev/null | wc -l | tr -d ' ')
doc_files=$(find . -path ./.git -prune -o -type f \( -name '*.md' -o -name '*.mdx' \) -print 2>/dev/null | wc -l | tr -d ' ')
console_count=$(grep -RIn --include='*.ts' --include='*.tsx' 'console\.log' src 2>/dev/null | grep -vcE '(test|spec)' || true)
any_count=$(grep -RIn --include='*.ts' --include='*.tsx' 'as any' src 2>/dev/null | wc -l | tr -d ' ')
todo_count=$(grep -RIn --include='*.ts' --include='*.tsx' --include='*.rs' -E 'TODO|FIXME|HACK|XXX' src src-tauri 2>/dev/null | wc -l | tr -d ' ')
uncommitted=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
head_sha=$(git rev-parse --short HEAD 2>/dev/null || echo null)
head_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
ci_status="unknown"
ci_conclusion="unknown"
if command -v gh >/dev/null 2>&1 && [[ -n "$GH_REPO" ]]; then
  ci_json=$(gh run list --repo "$GH_REPO" --branch "$BRANCH" --limit 1 --json status,conclusion 2>/dev/null || true)
  if [[ -n "$ci_json" && "$ci_json" != "[]" ]]; then
    ci_status=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print((d[0].get("status") if d else "unknown") or "unknown")' <<<"$ci_json" 2>/dev/null || echo unknown)
    ci_conclusion=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print((d[0].get("conclusion") if d else "unknown") or "unknown")' <<<"$ci_json" 2>/dev/null || echo unknown)
  fi
fi

python3 - "$METRICS_FILE" <<PY
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
try:
    metrics = json.loads(path.read_text(encoding='utf-8'))
except Exception:
    metrics = {'snapshots': []}
metrics.setdefault('snapshots', []).append({
    'timestamp': '$NOW',
    'branch': '$head_branch',
    'head': '$head_sha',
    'ci_status': '$ci_status',
    'ci_conclusion': '$ci_conclusion',
    'typescript_files': int('$ts_files' or 0),
    'rust_files': int('$rs_files' or 0),
    'doc_files': int('$doc_files' or 0),
    'console_log_count': int('$console_count' or 0),
    'as_any_count': int('$any_count' or 0),
    'todo_count': int('$todo_count' or 0),
    'uncommitted_paths': int('$uncommitted' or 0),
})
path.write_text(json.dumps(metrics, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
PY

echo "Metrics snapshot recorded: $NOW"
echo "  Branch/head: $head_branch@$head_sha"
echo "  CI: $ci_status / $ci_conclusion"
echo "  TS files: $ts_files | Rust files: $rs_files | Docs: $doc_files"
echo "  console.log: $console_count | as any: $any_count | TODO/FIXME/HACK: $todo_count"
echo "  Uncommitted paths: $uncommitted"
