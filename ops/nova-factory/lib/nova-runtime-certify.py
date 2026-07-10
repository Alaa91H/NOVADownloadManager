#!/usr/bin/env python3
"""NOVA runtime certification checks.

This is the production acceptance layer meant to be executed on the target VM
after installation. It performs live, mostly non-destructive checks and reports a
machine-readable verdict. Use static acceptance before packaging and runtime
certification after deployment.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

LIB_DIR = Path(os.environ.get("NOVA_LIB_DIR", "/usr/local/lib/nova"))
ENV_FILE = Path(os.environ.get("NOVA_ENV_FILE", "/etc/nova/nova.env"))
SERVICE_UNITS = [
    "nova-bot.service",
    "nova-dev-agent.service",
    "nova-monitor.service",
]
TIMER_UNITS = [
    "nova-watchdog.timer",
    "nova-maintenance.timer",
    "nova-daily-digest.timer",
    "nova-api-health.timer",
    "nova-self-update.timer",
    "nova-orchestrator.timer",
    "nova-dispatcher.timer",
    "nova-emergency.timer",
]


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(name: str, argv: list[str], timeout: int = 120, required: bool = True) -> dict:
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        ok = cp.returncode == 0
        return {
            "name": name,
            "ok": ok,
            "required": required,
            "returncode": cp.returncode,
            "stdout": (cp.stdout or "")[-4000:],
            "stderr": (cp.stderr or "")[-4000:],
        }
    except Exception as exc:
        return {"name": name, "ok": False, "required": required, "returncode": 127, "stdout": "", "stderr": str(exc)}


def unit_check(unit: str, *, should_be_active: bool = True) -> dict:
    active = run(f"systemd-active:{unit}", ["systemctl", "is-active", unit], 30, required=should_be_active)
    enabled = run(f"systemd-enabled:{unit}", ["systemctl", "is-enabled", unit], 30, required=True)
    failed = run(f"systemd-failed:{unit}", ["systemctl", "is-failed", unit], 30, required=True)
    # systemctl is-failed returns 1 for non-failed units; that is a healthy result.
    failed["ok"] = failed["stdout"].strip() in {"active", "inactive", "unknown"} or failed["returncode"] != 0
    return {"unit": unit, "active": active, "enabled": enabled, "failed": failed, "ok": active["ok"] and enabled["ok"] and failed["ok"]}


def certify(include_backup: bool = False) -> dict:
    checks: list[dict] = []
    checks.append({"name": "env-file", "ok": ENV_FILE.exists(), "required": True, "path": str(ENV_FILE)})
    for rel in [
        "nova-admin.py", "nova-config.py", "nova-health.py", "nova-system.py",
        "nova-backup.py", "nova-updater.py", "nova-release.py", "nova-ci.py",
        "nova-lease.py", "nova-job-queue.py", "nova-dispatcher.py", "nova-github-actions-worker.py", "nova-branch-policy.py", "nova-release-train.py",
        "nova-emergency.py", "nova-roadmap.py", "nova-orchestrator.py", "nova-state.py",
    ]:
        path = LIB_DIR / rel
        checks.append({"name": f"tool:{rel}", "ok": path.exists() and os.access(path, os.X_OK), "required": True, "path": str(path)})
    checks.append(run("config-validate", [str(LIB_DIR / "nova-config.py"), "validate"], 120, True))
    checks.append(run("health-write", [str(LIB_DIR / "nova-health.py"), "--write"], 120, True))
    checks.append(run("system-snapshot", [str(LIB_DIR / "nova-system.py"), "--format", "json"], 120, True))
    checks.append(run("update-status", [str(LIB_DIR / "nova-updater.py"), "status"], 120, True))
    checks.append(run("lease-status", [str(LIB_DIR / "nova-lease.py"), "status", "--json"], 120, True))
    checks.append(run("queue-stats", [str(LIB_DIR / "nova-job-queue.py"), "stats"], 120, True))
    checks.append(run("dispatcher-status", [str(LIB_DIR / "nova-dispatcher.py"), "status"], 120, True))
    checks.append(run("github-worker-status", [str(LIB_DIR / "nova-github-actions-worker.py"), "status"], 120, False))
    checks.append(run("branch-policy-status", [str(LIB_DIR / "nova-branch-policy.py"), "status"], 120, False))
    checks.append(run("release-train-status", [str(LIB_DIR / "nova-release-train.py"), "status"], 120, True))
    checks.append(run("emergency-status", [str(LIB_DIR / "nova-emergency.py"), "status"], 120, True))
    checks.append(run("orchestrator-status", [str(LIB_DIR / "nova-orchestrator.py"), "status"], 180, True))
    checks.append(run("state-audit", [str(LIB_DIR / "nova-state.py"), "audit", "--json"], 180, True))
    if include_backup:
        checks.append(run("backup-create", [str(LIB_DIR / "nova-backup.py"), "create", "runtime-certify"], 300, True))
    else:
        checks.append(run("backup-list", [str(LIB_DIR / "nova-backup.py"), "list"], 120, True))
    checks.append(run("systemd-daemon-verify", ["systemd-analyze", "verify", *[f"/etc/systemd/system/{u}" for u in SERVICE_UNITS + TIMER_UNITS]], 120, False))
    unit_results = [unit_check(u, should_be_active=(u in {"nova-bot.service", "nova-monitor.service"} or u.endswith(".timer"))) for u in SERVICE_UNITS + TIMER_UNITS]
    checks.extend({"name": f"unit:{r['unit']}", "ok": r["ok"], "required": True, "details": r} for r in unit_results)
    required_failures = [c for c in checks if c.get("required", True) and not c.get("ok")]
    warnings = [c for c in checks if not c.get("required", True) and not c.get("ok")]
    return {
        "generated_at": utc(),
        "ok": not required_failures,
        "status": "production-runtime-certified" if not required_failures else "failed",
        "required_failures": required_failures,
        "warnings": warnings,
        "checks": checks,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA runtime certification")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--include-backup", action="store_true", help="create a real backup as part of certification")
    args = parser.parse_args(argv)
    data = certify(include_backup=args.include_backup)
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        for c in data["checks"]:
            print(f"{'OK' if c.get('ok') else 'FAIL'} {c.get('name')} required={c.get('required', True)}")
        if data["warnings"]:
            print(f"WARNINGS: {len(data['warnings'])}")
        print("OK: production runtime certified" if data["ok"] else "FAIL: runtime certification failed")
    return 0 if data["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
