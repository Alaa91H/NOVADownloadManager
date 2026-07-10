#!/usr/bin/env python3
"""NOVA alpha/beta/stable release train manager."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova"))
STATE = Path(os.environ.get("NOVA_RELEASE_TRAIN_STATE", str(VAR_DIR / "release-train.json")))
QUEUE = Path(os.environ.get("NOVA_QUEUE_BIN", "/usr/local/lib/nova/nova-job-queue.py"))
CI = Path(os.environ.get("NOVA_CI_BIN", "/usr/local/lib/nova/nova-ci.py"))
CHANNELS = ["alpha", "beta", "stable"]
PROMOTION = {"beta": "alpha", "stable": "beta"}


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure() -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)


def read_state() -> dict:
    ensure()
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "version": 1,
        "created_at": utc(),
        "freeze": False,
        "channels": {ch: {"current": "", "last_cut_at": "", "last_promoted_at": "", "history": []} for ch in CHANNELS},
        "policy": {
            "alpha": "cut from develop when static gates pass",
            "beta": "promote alpha after CI green and no P0/P1 blockers",
            "stable": "promote beta after soak window and full release gate",
        },
    }


def write_state(data: dict) -> None:
    ensure()
    data["updated_at"] = utc()
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(STATE)


def run(argv: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, text=True, capture_output=True, timeout=timeout)


def semver(version: str) -> str:
    version = version.strip().lstrip("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.]+)?", version):
        raise SystemExit(f"invalid SemVer: {version}")
    return version


def enqueue_release(channel: str, version: str, action: str) -> dict:
    if not QUEUE.exists():
        return {"ok": False, "error": f"queue not installed: {QUEUE}"}
    cp = run([
        str(QUEUE), "enqueue", "--kind", "release", "--priority", "P1", "--source", "release-train",
        "--release-channel", channel, "--title", f"{action} {channel} v{version}",
        "--description", f"Release train requested {action} for {channel} v{version}",
        "--acceptance", "CI green, package validation green, changelog generated, artifacts checksummed",
        "--validation", "GitHub Actions release gate",
        "--payload", json.dumps({"channel": channel, "version": version, "action": action}, ensure_ascii=False),
    ])
    try:
        return json.loads(cp.stdout or "{}")
    except Exception:
        return {"ok": cp.returncode == 0, "stdout": cp.stdout, "stderr": cp.stderr}


def ci_gate() -> dict:
    if not CI.exists():
        return {"ok": None, "reason": "ci tool not installed"}
    cp = run([str(CI), "status", "--limit", "5"], timeout=120)
    try:
        data = json.loads(cp.stdout or "{}")
    except Exception:
        return {"ok": False, "reason": cp.stderr or cp.stdout}
    text = json.dumps(data).lower()
    red = any(x in text for x in ["failure", "timed_out", "cancelled"])
    return {"ok": cp.returncode == 0 and not red, "ci": data}



def base_version(value: str) -> str:
    return value.strip().lstrip("v").split("-", 1)[0]


def channel_matches(state: dict, channel: str, version: str) -> bool:
    current = str(state.get("channels", {}).get(channel, {}).get("current", ""))
    return bool(current) and base_version(current) == base_version(version)


def queue_gate() -> dict:
    if not QUEUE.exists():
        return {"ok": None, "reason": "queue not installed"}
    cp = run([str(QUEUE), "list", "--status", "failed", "--status", "blocked", "--limit", "100"], timeout=120)
    try:
        data = json.loads(cp.stdout or "{}")
    except Exception:
        return {"ok": False, "reason": cp.stderr or cp.stdout}
    blockers = []
    for job in data.get("jobs", []):
        if job.get("priority") in {"P0", "P1"}:
            blockers.append({"id": job.get("id"), "priority": job.get("priority"), "title": job.get("title"), "status": job.get("status")})
    return {"ok": not blockers, "blockers": blockers}

def cut(channel: str, version: str, *, force: bool = False) -> dict:
    if channel not in CHANNELS:
        raise SystemExit(f"invalid channel: {channel}")
    version = semver(version)
    state = read_state()
    if state.get("freeze") and not force:
        return {"ok": False, "status": "frozen", "message": "release train is frozen"}
    if channel != "alpha":
        return promote(channel, version, force=force)
    ch = state["channels"][channel]
    ch["current"] = f"v{version}-alpha" if "alpha" not in version else f"v{version}"
    ch["last_cut_at"] = utc()
    ch.setdefault("history", []).append({"at": utc(), "action": "cut", "version": ch["current"]})
    job = enqueue_release(channel, version, "cut")
    write_state(state)
    return {"ok": True, "status": "cut", "channel": channel, "version": ch["current"], "job": job}


def promote(channel: str, version: str, *, force: bool = False) -> dict:
    if channel not in {"beta", "stable"}:
        raise SystemExit("promote supports beta or stable")
    version = semver(version)
    state = read_state()
    if state.get("freeze") and not force:
        return {"ok": False, "status": "frozen"}
    previous = PROMOTION[channel]
    if not force and not channel_matches(state, previous, version):
        return {"ok": False, "status": "promotion-source-missing", "required_channel": previous, "version": f"v{version}", "source_current": state["channels"][previous].get("current", "")}
    gate = ci_gate()
    qgate = queue_gate()
    if (gate.get("ok") is False or qgate.get("ok") is False) and not force:
        return {"ok": False, "status": "gate-failed", "gate": gate, "queue_gate": qgate}
    suffix = "beta" if channel == "beta" else ""
    value = f"v{version}-{suffix}" if suffix and suffix not in version else f"v{version}"
    ch = state["channels"][channel]
    ch["current"] = value
    ch["last_promoted_at"] = utc()
    ch.setdefault("history", []).append({"at": utc(), "action": "promote", "version": value, "gate": {"ok": gate.get("ok")}, "queue_gate": {"ok": qgate.get("ok")}})
    job = enqueue_release(channel, version, "promote")
    write_state(state)
    return {"ok": True, "status": "promoted", "channel": channel, "version": value, "gate": gate, "job": job}


def rollback(channel: str, reason: str) -> dict:
    state = read_state()
    if channel not in CHANNELS:
        raise SystemExit(f"invalid channel: {channel}")
    hist = state["channels"][channel].setdefault("history", [])
    current = state["channels"][channel].get("current", "")
    previous = ""
    for entry in reversed(hist[:-1]):
        if entry.get("version") and entry.get("version") != current:
            previous = entry["version"]; break
    state["channels"][channel]["current"] = previous
    hist.append({"at": utc(), "action": "rollback", "from": current, "to": previous, "reason": reason})
    job = enqueue_release(channel, previous or "0.0.0", "rollback")
    write_state(state)
    return {"ok": True, "status": "rollback-requested", "channel": channel, "from": current, "to": previous, "job": job}


def freeze(value: bool, reason: str) -> dict:
    state = read_state()
    state["freeze"] = value
    state["freeze_reason"] = reason
    state["freeze_changed_at"] = utc()
    write_state(state)
    return {"ok": True, "freeze": value, "reason": reason}


def print_json(data) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="NOVA release train manager")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sp = sub.add_parser("cut")
    sp.add_argument("channel", choices=CHANNELS)
    sp.add_argument("version")
    sp.add_argument("--force", action="store_true")
    sp = sub.add_parser("promote")
    sp.add_argument("channel", choices=["beta", "stable"])
    sp.add_argument("version")
    sp.add_argument("--force", action="store_true")
    sp = sub.add_parser("rollback")
    sp.add_argument("channel", choices=CHANNELS)
    sp.add_argument("--reason", default="manual rollback")
    sp = sub.add_parser("freeze")
    sp.add_argument("--reason", default="manual freeze")
    sp = sub.add_parser("unfreeze")
    sp.add_argument("--reason", default="manual unfreeze")
    args = p.parse_args(argv)
    if args.cmd == "status":
        return print_json(read_state())
    if args.cmd == "cut":
        data = cut(args.channel, args.version, force=args.force); print_json(data); return 0 if data.get("ok") else 1
    if args.cmd == "promote":
        data = promote(args.channel, args.version, force=args.force); print_json(data); return 0 if data.get("ok") else 1
    if args.cmd == "rollback":
        return print_json(rollback(args.channel, args.reason))
    if args.cmd == "freeze":
        return print_json(freeze(True, args.reason))
    if args.cmd == "unfreeze":
        return print_json(freeze(False, args.reason))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
