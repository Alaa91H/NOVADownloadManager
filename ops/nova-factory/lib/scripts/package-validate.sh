#!/usr/bin/env bash
# Validate a NOVA factory package directory before release/self-update.
set -euo pipefail
ROOT="${1:-$(pwd)}"
cd "$ROOT"
errors=0

echo "== package validate: $ROOT =="

while IFS= read -r -d '' f; do
  if ! bash -n "$f"; then
    errors=$((errors+1))
  fi
done < <(find . -type f -name '*.sh' -print0)

if ! python3 - <<'PYCHECK'
import ast
import pathlib
import sys
errors = []
for path in pathlib.Path('.').rglob('*.py'):
    if '.git' in path.parts:
        continue
    try:
        ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    except Exception as exc:
        errors.append(f'{path}: {exc}')
if errors:
    print('\n'.join(errors), file=sys.stderr)
    raise SystemExit(1)
PYCHECK
then
  errors=$((errors+1))
fi


if find . -type d -name '__pycache__' | grep -q .; then
  echo "ERROR: __pycache__ directories found"
  find . -type d -name '__pycache__'
  errors=$((errors+1))
fi

if find . -type f -name '*.pyc' | grep -q .; then
  echo "ERROR: .pyc files found"
  find . -type f -name '*.pyc'
  errors=$((errors+1))
fi

if grep -RIl $'\r' . --exclude-dir=.git --exclude='*.tar.gz' --exclude='*.sha256' | grep -q .; then
  echo "ERROR: CRLF/CR characters found"
  grep -RIl $'\r' . --exclude-dir=.git --exclude='*.tar.gz' --exclude='*.sha256' | head -50
  errors=$((errors+1))
fi

required=(install.sh config/nova.env.example lib/nova-admin.py lib/nova-updater.py lib/nova-config.py lib/nova-backup.py lib/nova-health.py lib/nova-release.py lib/nova-ci.py lib/nova-acceptance.py lib/nova-system.py lib/nova-runtime-certify.py lib/nova-lease.py lib/nova-job-queue.py lib/nova-dispatcher.py lib/nova-github-actions-worker.py lib/nova-branch-policy.py lib/nova-release-train.py lib/nova-emergency.py lib/nova-roadmap.py lib/nova-orchestrator.py lib/nova-state.py repo-overlay/nova-bot.py systemd/nova-bot.service systemd/nova-self-update.timer systemd/nova-orchestrator.timer systemd/nova-dispatcher.timer systemd/nova-emergency.timer tests/test_static_package.py)
for f in "${required[@]}"; do
  if [[ ! -e "$f" ]]; then
    echo "ERROR: missing required file $f"
    errors=$((errors+1))
  fi
done

if grep -q 'create_subprocess_shell\|shell=True' repo-overlay/nova-bot.py; then
  echo "ERROR: Telegram bot contains shell subprocess surface"
  errors=$((errors+1))
fi

if grep -q '^NOVA_EXEC_ALLOWLIST=.*systemctl' config/nova.env.example; then
  echo "ERROR: production exec allowlist is too broad"
  errors=$((errors+1))
fi

if [[ -x lib/nova-release.py ]]; then
  if ! lib/nova-release.py validate --path .; then
    errors=$((errors+1))
  fi
fi

if [[ -d tests ]]; then
  if ! PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests; then
    errors=$((errors+1))
  fi
fi

if [[ -d systemd ]] && command -v systemd-analyze >/dev/null 2>&1; then
  # Verify syntax using packaged units. In a package tree the ExecStart targets
  # are not installed yet, so filter that expected packaging warning.
  tmp_log="$(mktemp)"
  if ! systemd-analyze verify systemd/*.service systemd/*.timer >"$tmp_log" 2>&1; then
    if grep -Ev 'Command .+ is not executable: No such file or directory|Cannot add dependency job|Failed to create' "$tmp_log" | grep -q .; then
      cat "$tmp_log"
      errors=$((errors+1))
    else
      echo "WARN: systemd verify reported only package-tree missing ExecStart paths"
    fi
  fi
  rm -f "$tmp_log"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "OK: package validation passed"
else
  echo "FAIL: package validation errors=$errors"
fi
exit "$errors"
