#!/usr/bin/env python3
"""NOVA production system snapshot helper.

Read-only system introspection used by nova-admin and the Telegram bot. The
helper intentionally avoids shell pipelines; every external command is invoked
through argv arrays and all dynamic values are bounded by allowlists.
"""
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
PROJECT_DEFAULT = Path(os.environ.get("NOVA_PROJECT_DIR", "/home/ubuntu/NOVA"))
SERVICE_NAMES = [
    "nova-dev-agent.service",
    "nova-bot.service",
    "nova-monitor.service",
    "nova-watchdog.timer",
    "nova-maintenance.timer",
    "nova-daily-digest.timer",
    "nova-api-health.timer",
    "nova-self-update.timer",
]
SERVICE_RE = re.compile(r"^nova-[A-Za-z0-9_.@-]+\.(service|timer)$")


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_env(path: Path = ENV_FILE) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            env[key] = value
    return env


def run(argv: list[str], timeout: int = 20, cwd: Path | None = None) -> tuple[int, str, str]:
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)
        return int(cp.returncode), cp.stdout.strip(), cp.stderr.strip()
    except Exception as exc:
        return 127, "", str(exc)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def proc_stat() -> tuple[int, int]:
    raw = read_text(Path("/proc/stat")).splitlines()[0].split()[1:]
    nums = [int(x) for x in raw]
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    total = sum(nums)
    return idle, total


def cpu_percent() -> float | None:
    try:
        idle1, total1 = proc_stat()
        time.sleep(0.08)
        idle2, total2 = proc_stat()
        total_delta = total2 - total1
        idle_delta = idle2 - idle1
        if total_delta <= 0:
            return None
        return round((1 - (idle_delta / total_delta)) * 100, 2)
    except Exception:
        return None


def meminfo() -> dict:
    data: dict[str, int] = {}
    for line in read_text(Path("/proc/meminfo")).splitlines():
        if ":" not in line:
            continue
        k, rest = line.split(":", 1)
        parts = rest.strip().split()
        if parts and parts[0].isdigit():
            data[k] = int(parts[0]) * 1024
    total = data.get("MemTotal", 0)
    avail = data.get("MemAvailable", 0)
    used = max(0, total - avail)
    swap_total = data.get("SwapTotal", 0)
    swap_free = data.get("SwapFree", 0)
    return {
        "total": total,
        "available": avail,
        "used": used,
        "used_percent": round((used * 100 / total), 2) if total else None,
        "swap_total": swap_total,
        "swap_used": max(0, swap_total - swap_free),
        "swap_used_percent": round(((swap_total - swap_free) * 100 / swap_total), 2) if swap_total else 0,
    }


def loadavg() -> dict:
    parts = read_text(Path("/proc/loadavg")).split()
    return {
        "1m": parts[0] if len(parts) > 0 else None,
        "5m": parts[1] if len(parts) > 1 else None,
        "15m": parts[2] if len(parts) > 2 else None,
        "processes": parts[3] if len(parts) > 3 else None,
    }


def uptime() -> dict:
    raw = read_text(Path("/proc/uptime")).split()
    seconds = int(float(raw[0])) if raw else 0
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    label = f"{days}d {hours}h {minutes}m" if days else f"{hours}h {minutes}m"
    return {"seconds": seconds, "label": label}


def disk(path: Path) -> dict:
    try:
        total, used, free = shutil.disk_usage(path)
        return {"path": str(path), "total": total, "used": used, "free": free, "used_percent": round(used * 100 / total, 2) if total else None}
    except Exception as exc:
        return {"path": str(path), "error": str(exc)}


def dir_size(path: Path) -> dict:
    if not path.exists():
        return {"path": str(path), "exists": False, "bytes": None}
    code, out, err = run(["du", "-sb", str(path)], 30)
    if code == 0 and out.split():
        try:
            return {"path": str(path), "exists": True, "bytes": int(out.split()[0])}
        except Exception:
            pass
    return {"path": str(path), "exists": True, "bytes": None, "error": err or out}


def network() -> dict:
    items = []
    for line in read_text(Path("/proc/net/dev")).splitlines()[2:]:
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo":
            continue
        parts = rest.split()
        if len(parts) >= 16:
            items.append({"interface": iface, "rx_bytes": int(parts[0]), "tx_bytes": int(parts[8])})
    return {"interfaces": items[:8]}


def _compact_systemctl(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return "unknown"
    if "System has not been booted with systemd" in value or "Failed to connect to" in value:
        return "unavailable"
    return value.splitlines()[0][:120]

def systemd_unit(name: str) -> dict:
    if not SERVICE_RE.fullmatch(name):
        return {"name": name, "active": "invalid", "enabled": "invalid", "failed": "invalid"}
    _c1, active, e1 = run(["systemctl", "is-active", name], 10)
    _c2, enabled, _e2 = run(["systemctl", "is-enabled", name], 10)
    _c3, failed, _e3 = run(["systemctl", "is-failed", name], 10)
    return {"name": name, "active": _compact_systemctl(active or e1), "enabled": _compact_systemctl(enabled), "failed": _compact_systemctl(failed)}


def git(project: Path, branch: str) -> dict:
    if not (project / ".git").exists():
        return {"project_dir": str(project), "ok": False, "error": "not a git checkout"}
    _c1, current, _e1 = run(["git", "-C", str(project), "rev-parse", "--abbrev-ref", "HEAD"], 20)
    _c2, head, _e2 = run(["git", "-C", str(project), "log", "--oneline", "-1"], 20)
    _c3, recent, _e3 = run(["git", "-C", str(project), "log", "--oneline", "-3"], 20)
    _c4, dirty, _e4 = run(["git", "-C", str(project), "status", "--porcelain"], 20)
    _c5, ahead, _e5 = run(["git", "-C", str(project), "rev-list", "--count", f"HEAD..origin/{branch}"], 20)
    _c6, behind, _e6 = run(["git", "-C", str(project), "rev-list", "--count", f"origin/{branch}..HEAD"], 20)
    return {
        "project_dir": str(project),
        "ok": True,
        "branch": current,
        "expected_branch": branch,
        "head": head,
        "recent": recent.splitlines(),
        "dirty_paths": len([x for x in dirty.splitlines() if x.strip()]),
        "ahead_remote_count": int(ahead) if ahead.isdigit() else 0,
        "behind_remote_count": int(behind) if behind.isdigit() else 0,
    }


def ps_rows(sort: str, limit: int) -> list[str]:
    sort_key = {"cpu": "-%cpu", "mem": "-%mem", "pid": "pid"}.get(sort, "-%cpu")
    code, out, err = run(["ps", "axo", "pid,comm,%cpu,%mem", f"--sort={sort_key}"], 20)
    if code != 0:
        return [(err or "ps unavailable")[:200]]
    return out.splitlines()[: max(2, min(limit + 1, 25))]


def fmt_bytes(value: int | None) -> str:
    if value is None:
        return "N/A"
    n = float(value)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024
    return f"{value}B"


def snapshot() -> dict:
    env = parse_env()
    project = Path(env.get("NOVA_PROJECT_DIR", str(PROJECT_DEFAULT))).resolve()
    branch = env.get("NOVA_BRANCH") or env.get("NOVA_DEVELOP_BRANCH", "develop")
    services = {name: systemd_unit(name) for name in SERVICE_NAMES}
    system = {
        "cpu_percent": cpu_percent(),
        "memory": meminfo(),
        "load": loadavg(),
        "uptime": uptime(),
        "disk": {
            "root": disk(Path("/")),
            "project": disk(project if project.exists() else Path("/")),
            "var_nova": disk(VAR_DIR if VAR_DIR.exists() else Path("/var")),
        },
        "directories": {
            "node_modules": dir_size(project / "node_modules"),
            "tauri_target": dir_size(project / "src-tauri" / "target"),
        },
        "network": network(),
    }
    return {
        "generated_at": utc(),
        "project_dir": str(project),
        "branch": branch,
        "system": system,
        "services": services,
        "git": git(project, branch),
        "processes": {
            "cpu": ps_rows("cpu", 10),
            "mem": ps_rows("mem", 10),
        },
    }


def render_text(data: dict) -> str:
    sysd = data["system"]
    mem = sysd["memory"]
    root = sysd["disk"]["root"]
    gitd = data.get("git", {})
    services = data.get("services", {})
    lines = [
        "NOVA production system snapshot",
        f"generated_at: {data.get('generated_at')}",
        f"project: {data.get('project_dir')}",
        f"cpu: {sysd.get('cpu_percent')}%  load: {sysd.get('load', {}).get('1m')}/{sysd.get('load', {}).get('5m')}/{sysd.get('load', {}).get('15m')}",
        f"memory: {fmt_bytes(mem.get('used'))}/{fmt_bytes(mem.get('total'))} ({mem.get('used_percent')}%)",
        f"disk /: {fmt_bytes(root.get('used'))}/{fmt_bytes(root.get('total'))} ({root.get('used_percent')}%)",
        f"uptime: {sysd.get('uptime', {}).get('label')}",
        "services:",
    ]
    for name, state in services.items():
        lines.append(f"  - {name}: active={state.get('active')} enabled={state.get('enabled')} failed={state.get('failed')}")
    lines.extend([
        "git:",
        f"  branch={gitd.get('branch')} head={gitd.get('head')} dirty={gitd.get('dirty_paths')} ahead={gitd.get('ahead_remote_count')} behind={gitd.get('behind_remote_count')}",
        "top cpu:",
        *[f"  {row}" for row in data.get("processes", {}).get("cpu", [])[:8]],
    ])
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA production system snapshot")
    parser.add_argument("--format", choices=["json", "text"], default="json")
    parser.add_argument("--sort", choices=["cpu", "mem", "pid"], default="cpu", help="used by process view")
    args = parser.parse_args(argv)
    data = snapshot()
    if args.format == "text":
        print(render_text(data))
    else:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
