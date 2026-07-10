#!/usr/bin/env python3
"""NOVA health snapshot generator."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ENV_FILE = Path(os.environ.get("NOVA_ENV_FILE", "/etc/nova/nova.env"))
VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova"))
LOG_DIR = Path(os.environ.get("NOVA_LOG_DIR", "/var/log/nova"))
HEALTH_FILE = VAR_DIR / "health.json"
SERVICES = [
    "nova-bot.service",
    "nova-dev-agent.service",
    "nova-monitor.service",
]
TIMERS = [
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


def parse_env(path: Path = ENV_FILE) -> dict[str, str]:
    env = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
                env[k] = v
    return env


def run(argv: list[str], timeout: int = 20) -> tuple[int, str, str]:
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return cp.returncode, cp.stdout.strip(), cp.stderr.strip()
    except Exception as exc:
        return 127, "", str(exc)


def systemd_unit(name: str) -> dict:
    code, out, err = run(["systemctl", "is-active", name], 10)
    enabled_code, enabled, _ = run(["systemctl", "is-enabled", name], 10)
    failed_code, failed, _ = run(["systemctl", "is-failed", name], 10)
    return {
        "name": name,
        "active": out or "unknown",
        "enabled": enabled if enabled_code == 0 else enabled or "unknown",
        "failed": failed if failed_code == 0 else failed or "unknown",
        "ok": out == "active" or (name.endswith(".service") and out in {"inactive", "unknown"}),
        "error": err,
    }


def disk(path: str) -> dict:
    try:
        total, used, free = shutil.disk_usage(path)
        pct = round(used * 100 / total, 2) if total else 0
        return {"path": path, "total": total, "used": used, "free": free, "used_percent": pct, "ok": pct < 90}
    except Exception as exc:
        return {"path": path, "error": str(exc), "ok": False}


def git_state(project: Path, branch: str) -> dict:
    if not (project / ".git").exists():
        return {"ok": False, "error": f"not a git checkout: {project}"}
    code, head, err = run(["git", "-C", str(project), "rev-parse", "--short", "HEAD"], 20)
    _, current_branch, _ = run(["git", "-C", str(project), "rev-parse", "--abbrev-ref", "HEAD"], 20)
    _, status, _ = run(["git", "-C", str(project), "status", "--porcelain"], 20)
    return {
        "ok": code == 0,
        "project_dir": str(project),
        "head": head,
        "branch": current_branch,
        "expected_branch": branch,
        "dirty_paths": len([ln for ln in status.splitlines() if ln.strip()]),
        "error": err,
    }


def read_json_file(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}

def state_integrity(var_dir: Path) -> dict:
    tool = Path(os.environ.get("NOVA_LIB_DIR", "/usr/local/lib/nova")) / "nova-state.py"
    if not tool.exists():
        return {"ok": True, "status": "state-tool-missing"}
    code, out, err = run([str(tool), "summary", "--json"], 30)
    try:
        data = json.loads(out or "{}")
    except Exception:
        data = {"ok": False, "error": err or out}
    data["returncode"] = code
    return data

def queue_counts(var_dir: Path) -> dict:
    root = var_dir / "jobs"
    statuses = ["queued", "claimed", "running", "succeeded", "failed", "blocked", "cancelled", "deferred"]
    return {status: len(list((root / status).glob("*.json"))) if (root / status).exists() else 0 for status in statuses}

def active_leases(var_dir: Path) -> list[dict]:
    leases = []
    for path in (var_dir / "leases").glob("*.json") if (var_dir / "leases").exists() else []:
        data = read_json_file(path)
        if data:
            leases.append(data)
    return leases

def file_age(path: Path) -> dict:
    if not path.exists():
        return {"path": str(path), "exists": False, "age_seconds": None}
    age = max(0, int(time.time() - path.stat().st_mtime))
    return {"path": str(path), "exists": True, "age_seconds": age, "mtime": int(path.stat().st_mtime)}


def snapshot(write: bool = False) -> dict:
    env = parse_env()
    project = Path(env.get("NOVA_PROJECT_DIR", "/home/ubuntu/NOVA"))
    branch = env.get("NOVA_BRANCH") or env.get("NOVA_DEVELOP_BRANCH", "develop")
    service_states = [systemd_unit(s) for s in SERVICES]
    timer_states = [systemd_unit(t) for t in TIMERS]
    update_file = Path(env.get("NOVA_VAR_DIR", str(VAR_DIR))) / "update-status.json"
    agent_state = Path(env.get("NOVA_VAR_DIR", str(VAR_DIR))) / ".agent-state.json"
    monitor_hb = Path(env.get("NOVA_VAR_DIR", str(VAR_DIR))) / ".monitor-heartbeat"

    issues: list[str] = []
    for s in service_states:
        if s["name"] in {"nova-bot.service", "nova-monitor.service"} and s["active"] != "active":
            issues.append(f"{s['name']} is {s['active']}")
        if s["failed"] == "failed":
            issues.append(f"{s['name']} is failed")
    for t in timer_states:
        if t["active"] != "active":
            issues.append(f"{t['name']} timer is {t['active']}")
    root_disk = disk("/")
    var_disk = disk(str(VAR_DIR if VAR_DIR.exists() else "/var"))
    if not root_disk.get("ok"):
        issues.append("root disk usage is high or unavailable")
    if not var_disk.get("ok"):
        issues.append("var/nova disk usage is high or unavailable")
    g = git_state(project, branch)
    if not g.get("ok"):
        issues.append(g.get("error", "git state unavailable"))
    if g.get("dirty_paths", 0) > 0:
        issues.append(f"repository has {g['dirty_paths']} uncommitted path(s)")

    monitor_age = file_age(monitor_hb)
    if monitor_age["exists"] and monitor_age["age_seconds"] is not None and monitor_age["age_seconds"] > 300:
        issues.append("monitor heartbeat is stale")

    status = "healthy"
    if issues:
        status = "degraded" if len(issues) <= 3 else "failed"
    if update_file.exists():
        try:
            upd = json.loads(update_file.read_text(encoding="utf-8"))
            if upd.get("last_result") == "running":
                status = "updating"
        except Exception:
            upd = {}
    else:
        upd = {}

    runtime_var = Path(env.get("NOVA_VAR_DIR", str(VAR_DIR)))
    leases = active_leases(runtime_var)
    qcounts = queue_counts(runtime_var)
    integrity = state_integrity(runtime_var)
    if not integrity.get("ok", True):
        issues.append("runtime state integrity audit found invalid JSON")
    if any(l.get("category") == "update" for l in leases):
        status = "updating"
    if any(l.get("category") == "maintenance" for l in leases):
        status = "maintenance" if status == "healthy" else status

    data = {
        "generated_at": utc(),
        "epoch": int(time.time()),
        "status": status,
        "issues": issues,
        "orchestration": {"active_leases": leases, "queue_counts": qcounts, "state_integrity": integrity},
        "services": {s["name"]: s for s in service_states},
        "timers": {t["name"]: t for t in timer_states},
        "disk": {"root": root_disk, "nova": var_disk},
        "git": g,
        "files": {
            "env": file_age(ENV_FILE),
            "agent_state": file_age(agent_state),
            "monitor_heartbeat": monitor_age,
            "update_status": file_age(update_file),
        },
        "last_update": upd,
    }
    if write:
        HEALTH_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = HEALTH_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(HEALTH_FILE)
    return data


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="NOVA health snapshot")
    p.add_argument("--write", action="store_true")
    p.add_argument("--quick", action="store_true", help="exit non-zero only on failed status")
    args = p.parse_args(argv)
    data = snapshot(write=args.write)
    print(json.dumps(data, indent=2, ensure_ascii=False))
    if args.quick:
        return 0 if data["status"] in {"healthy", "degraded", "updating"} else 2
    return 0 if data["status"] != "failed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
