#!/usr/bin/env bash
# NOVA Doctor — static/runtime diagnostics for the factory node.
set -euo pipefail

JSON=0
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --quick) QUICK=1 ;;
  esac
done

ENV_FILE="${NOVA_ENV_FILE:-/etc/nova/nova.env}"
LIB_DIR="${NOVA_LIB_DIR:-/usr/local/lib/nova}"
VAR_DIR="${NOVA_VAR_DIR:-/var/lib/nova}"
LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
PROJECT_DIR="${NOVA_PROJECT_DIR:-}"
if [[ -z "$PROJECT_DIR" && -f "$ENV_FILE" ]]; then
  PROJECT_DIR="$(python3 - "$ENV_FILE" <<'PY' 2>/dev/null || true
import re,sys
for raw in open(sys.argv[1], encoding='utf-8', errors='replace'):
    line=raw.strip()
    if line.startswith('NOVA_PROJECT_DIR='):
        print(line.split('=',1)[1].strip().strip('"').strip("'")); break
PY
)"
fi
PROJECT_DIR="${PROJECT_DIR:-/home/ubuntu/NOVA}"

CONFIG_BIN="$LIB_DIR/nova-config.py"
HEALTH_BIN="$LIB_DIR/nova-health.py"
BACKUP_BIN="$LIB_DIR/nova-backup.py"
UPDATER_BIN="$LIB_DIR/nova-updater.py"
ADMIN_BIN="$LIB_DIR/nova-admin.py"

if [[ "$JSON" == 1 ]]; then
  python3 - "$ENV_FILE" "$LIB_DIR" "$VAR_DIR" "$LOG_DIR" "$PROJECT_DIR" <<'PY'
import json, os, shutil, subprocess, sys
from pathlib import Path

env_file, lib_dir, var_dir, log_dir, project_dir = map(Path, sys.argv[1:6])

def run(argv, timeout=30):
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        out = (cp.stdout or cp.stderr).strip()
        try:
            parsed = json.loads(out) if out else None
        except Exception:
            parsed = out[:4000]
        return {"rc": cp.returncode, "output": parsed}
    except Exception as exc:
        return {"rc": 127, "error": str(exc)}

checks = {}
checks["paths"] = {
    "env_file": {"path": str(env_file), "exists": env_file.exists(), "mode": oct(env_file.stat().st_mode & 0o777) if env_file.exists() else None},
    "lib_dir": {"path": str(lib_dir), "exists": lib_dir.exists()},
    "var_dir": {"path": str(var_dir), "exists": var_dir.exists()},
    "log_dir": {"path": str(log_dir), "exists": log_dir.exists()},
    "project_dir": {"path": str(project_dir), "exists": project_dir.exists(), "git": (project_dir/'.git').exists()},
}
for name in ["nova-admin.py", "nova-updater.py", "nova-config.py", "nova-backup.py", "nova-health.py", "nova-release.py", "nova-ci.py", "nova-acceptance.py", "nova-system.py", "nova-runtime-certify.py"]:
    p = lib_dir / name
    checks[f"tool:{name}"] = {"exists": p.exists(), "executable": os.access(p, os.X_OK)}
checks["config"] = run([str(lib_dir/"nova-config.py"), "validate"]) if (lib_dir/"nova-config.py").exists() else {"rc":127,"error":"missing nova-config.py"}
checks["health"] = run([str(lib_dir/"nova-health.py"), "--write"]) if (lib_dir/"nova-health.py").exists() else {"rc":127,"error":"missing nova-health.py"}
checks["system_snapshot"] = run([str(lib_dir/"nova-system.py"), "--format", "json"]) if (lib_dir/"nova-system.py").exists() else {"rc":127,"error":"missing nova-system.py"}
checks["backups"] = run([str(lib_dir/"nova-backup.py"), "list"]) if (lib_dir/"nova-backup.py").exists() else {"rc":127,"error":"missing nova-backup.py"}
checks["systemd"] = {}
for unit in ["nova-bot.service", "nova-dev-agent.service", "nova-monitor.service", "nova-self-update.timer", "nova-watchdog.timer"]:
    checks["systemd"][unit] = run(["systemctl", "is-active", unit])
checks["disk"] = {}
for p in [Path('/'), var_dir, log_dir]:
    try:
        total, used, free = shutil.disk_usage(str(p if p.exists() else p.parent))
        checks["disk"][str(p)] = {"total": total, "used": used, "free": free, "used_percent": round(used*100/total,2)}
    except Exception as exc:
        checks["disk"][str(p)] = {"error": str(exc)}

errors=[]; warnings=[]
if checks["config"].get("rc", 1) != 0:
    errors.append("configuration validation failed")
for key, val in checks["paths"].items():
    if not val.get("exists"):
        warnings.append(f"missing path: {key}")
for key, val in checks.items():
    if key.startswith("tool:") and not val.get("exists"):
        errors.append(f"missing {key}")
status = "ok" if not errors else "failed"
print(json.dumps({"status":status,"errors":errors,"warnings":warnings,"checks":checks}, indent=2, ensure_ascii=False))
raise SystemExit(0 if not errors else 2)
PY
  exit $?
fi

echo "=== NOVA Doctor ==="
echo "Env:      $ENV_FILE"
echo "Lib:      $LIB_DIR"
echo "Project:  $PROJECT_DIR"
echo "Var/log:  $VAR_DIR / $LOG_DIR"
echo

fail=0
warn=0

check_rc() {
  local label="$1"; shift
  echo "== $label =="
  if "$@"; then
    echo "OK: $label"
  else
    local rc=$?
    echo "FAIL($rc): $label"
    fail=$((fail+1))
  fi
  echo
}

check_warn() {
  local label="$1"; shift
  echo "== $label =="
  if "$@"; then
    echo "OK: $label"
  else
    local rc=$?
    echo "WARN($rc): $label"
    warn=$((warn+1))
  fi
  echo
}

check_rc "config validate" "$CONFIG_BIN" validate
check_warn "health snapshot" "$HEALTH_BIN" --write
check_warn "backup listing" "$BACKUP_BIN" list
if [[ -x "$LIB_DIR/nova-system.py" ]]; then
  check_warn "system snapshot" "$LIB_DIR/nova-system.py" --format text
fi

if command -v systemctl >/dev/null 2>&1; then
  echo "== systemd units =="
  for unit in nova-bot.service nova-dev-agent.service nova-monitor.service nova-self-update.timer nova-watchdog.timer nova-maintenance.timer; do
    printf '%-28s ' "$unit"
    systemctl is-active "$unit" 2>/dev/null || true
  done
  echo
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  unit_files=()
  for f in /etc/systemd/system/nova-*.service /etc/systemd/system/nova-*.timer; do
    [[ -e "$f" ]] && unit_files+=("$f")
  done
  if (( ${#unit_files[@]} > 0 )); then
    check_warn "systemd-analyze verify" systemd-analyze verify "${unit_files[@]}"
  fi
fi

echo "== disk =="
df -h / "$VAR_DIR" "$LOG_DIR" 2>/dev/null | awk '!seen[$1$6]++' || true
echo

echo "== git =="
if [[ -d "$PROJECT_DIR/.git" ]]; then
  git -C "$PROJECT_DIR" status --short || true
  git -C "$PROJECT_DIR" log -1 --pretty='%h %s' || true
else
  echo "WARN: project is not a git checkout"
  warn=$((warn+1))
fi
echo

echo "Summary: failures=$fail warnings=$warn"
if [[ "$QUICK" == 1 ]]; then
  [[ "$fail" -eq 0 ]]
else
  [[ "$fail" -eq 0 ]]
fi
