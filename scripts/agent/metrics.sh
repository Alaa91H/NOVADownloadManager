#!/usr/bin/env bash
# =============================================================
#  NOVA Metrics Tracker
#  Tracks coverage, build times, errors over time
#  Appends to .metrics.json
# =============================================================
set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
METRICS_FILE="$PROJECT_DIR/.metrics.json"
cd "$PROJECT_DIR"

# Initialize if not exists
if [ ! -f "$METRICS_FILE" ]; then
  echo '{"snapshots":[]}' > "$METRICS_FILE"
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# 1. Coverage
COVERAGE_PCT="null"
if [ -f "coverage/coverage-final.json" ]; then
  COVERAGE_PCT=$(python3 -c "
import json
d = json.load(open('coverage/coverage-final.json'))
total_lines = sum(v.get('s', {}).get(0, 0) for v in d.values())
covered_lines = sum(1 for v in d.values() for k, c in v.get('s', {}).items() if c)
print(f'{covered_lines/total_lines*100:.1f}' if total_lines else 'null')
" 2>/dev/null || echo "null")
fi

# 2. TypeScript errors
TS_ERRORS=$(tsc --noEmit 2>&1 | grep -c "error TS" || echo 0)

# 3. ESLint warnings
ESLINT_COUNT=$(pnpm lint:eslint 2>&1 | grep -cE "(warning|error)\s+" || echo 0)

# 4. Test results
TEST_RESULT=$(pnpm test 2>&1 | tail -1)
TEST_PASS=$(echo "$TEST_RESULT" | grep -c "passed" || echo 0)
TEST_FAIL=$(echo "$TEST_RESULT" | grep -c "failed" || echo 0)
TEST_COUNT=$(echo "$TEST_RESULT" | grep -oP '\d+(?=\s+tests?)' || echo 0)

# 5. Build time (last run)
BUILD_TIME="null"
if [ -f ".agent-state.json" ]; then
  BUILD_TIME=$(python3 -c "
import json
d = json.load(open('.agent-state.json'))
print(d.get('duration_sec', 'null'))
" 2>/dev/null || echo "null")
fi

# 6. Dependencies count
DEPS=$(python3 -c "
import json
d = json.load(open('package.json'))
print(len(d.get('dependencies', {})) + len(d.get('devDependencies', {})))
" 2>/dev/null || echo 0)

# 7. File count
FILES=$(find src/ -name "*.ts" -o -name "*.tsx" 2>/dev/null | wc -l)

# Build snapshot
SNAPSHOT=$(cat << SNAPSHOT_EOF
{
  "timestamp": "$NOW",
  "coverage": $COVERAGE_PCT,
  "ts_errors": $TS_ERRORS,
  "eslint_count": $ESLINT_COUNT,
  "tests_pass": $TEST_PASS,
  "tests_fail": $TEST_FAIL,
  "test_count": $TEST_COUNT,
  "build_time_sec": $BUILD_TIME,
  "dependency_count": $DEPS,
  "file_count": $FILES
}
SNAPSHOT_EOF
)

# Append to metrics
python3 -c "
import json
m = json.load(open('$METRICS_FILE'))
m['snapshots'].append($SNAPSHOT)
json.dump(m, open('$METRICS_FILE', 'w'), indent=2)
"

echo "Metrics snapshot recorded: $NOW"
echo "  Coverage: ${COVERAGE_PCT:-N/A}%"
echo "  TS Errors: $TS_ERRORS"
echo "  ESLint: $ESLINT_COUNT"
echo "  Tests: $TEST_COUNT ($TEST_PASS passed, $TEST_FAIL failed)"
echo "  Files: $FILES"
echo "  Dependencies: $DEPS"

# Print trend if enough data
python3 -c "
import json
m = json.load(open('$METRICS_FILE'))
snaps = m['snapshots']
if len(snaps) >= 2:
    first = snaps[0]
    last = snaps[-1]
    print()
    print('=== Trends ===')
    if first.get('coverage') and last.get('coverage'):
        diff = last['coverage'] - first['coverage']
        arrow = '📈' if diff > 0 else '📉'
        print(f'  Coverage: {first[\"coverage\"]:.1f}% → {last[\"coverage\"]:.1f}% {arrow}')
    if first.get('ts_errors') is not None and last.get('ts_errors') is not None:
        diff = first['ts_errors'] - last['ts_errors']
        arrow = '✅' if diff > 0 else ('⚠️' if diff < 0 else '➡️')
        print(f'  TS Errors: {first[\"ts_errors\"]} → {last[\"ts_errors\"]} {arrow}')
    print(f'  Snapshots: {len(snaps)} total')
" 2>/dev/null || true
