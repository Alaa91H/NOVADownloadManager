#!/usr/bin/env python3
"""NOVA autonomous orchestration kernel.

Runs coordination passes for deferred operations, health snapshots, job dispatch,
release train state, and emergency policy. This is the production control loop
for keeping timers cooperative rather than competing.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

LIB_DIR = Path(os.environ.get("NOVA_LIB_DIR", "/usr/local/lib/nova"))
LEASE = LIB_DIR / "nova-lease.py"
QUEUE = LIB_DIR / "nova-job-queue.py"
DISPATCHER = LIB_DIR / "nova-dispatcher.py"
HEALTH = LIB_DIR / "nova-health.py"
EMERGENCY = LIB_DIR / "nova-emergency.py"
ROADMAP = LIB_DIR / "nova-roadmap.py"
RELEASE_TRAIN = LIB_DIR / "nova-release-train.py"
VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova"))
STATE = VAR_DIR / "orchestrator-state.json"
ORCHESTRATOR_LEASE_ID = ""

ALLOWED_DEFERRED = {
    str(LIB_DIR / "nova-admin.py"),
    str(LIB_DIR / "nova-updater.py"),
    str(LIB_DIR / "nova-backup.py"),
    str(LIB_DIR / "nova-health.py"),
    str(LIB_DIR / "nova-release-train.py"),
    str(LIB_DIR / "nova-dispatcher.py"),
    str(LIB_DIR / "nova-state.py"),
    str(LIB_DIR / "scripts" / "maintenance.sh"),
    str(LIB_DIR / "scripts" / "doctor.sh"),
}


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(argv: list[str], timeout: int = 180, env: dict[str, str] | None = None) -> dict:
    cp = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, env=env)
    try:
        data = json.loads(cp.stdout or "{}")
    except Exception:
        data = {"stdout": cp.stdout[-4000:], "stderr": cp.stderr[-4000:]}
    return {"argv": argv, "rc": cp.returncode, "data": data, "stderr": cp.stderr[-2000:]}


def write_state(data: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(STATE)


def command_allowed(command: list[str]) -> tuple[bool, str]:
    if not command:
        return False, "empty command"
    exe = command[0]
    try:
        resolved = str(Path(exe).resolve())
    except Exception:
        resolved = exe
    if exe in ALLOWED_DEFERRED or resolved in ALLOWED_DEFERRED:
        return True, "allowed"
    return False, f"deferred command not allowlisted: {exe}"


def acquire_cycle_lease() -> tuple[bool, str, dict]:
    if not LEASE.exists():
        return True, "", {"status": "lease-tool-missing"}
    res = run([str(LEASE), "acquire", "orchestrator", "--owner", f"orchestrator:{os.getpid()}", "--ttl", os.environ.get("NOVA_ORCHESTRATOR_LEASE_TTL_SECONDS", "1800"), "--reason", "orchestration cycle"], timeout=30)
    data = res.get("data") or {}
    if res.get("rc") == 0 and data.get("ok") and data.get("id"):
        return True, str(data["id"]), data
    return False, "", data


def release_cycle_lease(lease_id: str) -> None:
    if lease_id and LEASE.exists():
        run([str(LEASE), "release", lease_id], timeout=30)


def record_deferred_attempt(item_id: str, rc: int, note: str) -> None:
    if item_id and LEASE.exists():
        run([str(LEASE), "record-deferred-attempt", item_id, "--rc", str(rc), "--note", note[-2000:]], timeout=30)


def run_due_deferred(limit: int = 5) -> dict:
    if not LEASE.exists():
        return {"ok": True, "status": "lease-tool-missing"}
    due = run([str(LEASE), "due"], timeout=60)
    items = []
    try:
        items = list((due.get("data") or {}).get("due") or [])[: max(0, limit)]
    except Exception:
        items = []
    executed = []
    for item in items:
        command = list(item.get("command") or [])
        ok, reason = command_allowed(command)
        if not ok:
            executed.append({"id": item.get("id"), "ok": False, "status": "rejected", "reason": reason})
            # Remove rejected deferred commands; they should never loop forever.
            if item.get("id"):
                run([str(LEASE), "remove-deferred", str(item["id"])], timeout=30)
            continue
        env = os.environ.copy()
        env["NOVA_DEFERRED_RUN"] = "1"
        result = run(command, timeout=int(os.environ.get("NOVA_DEFERRED_TIMEOUT", "900")), env=env)
        item_id = str(item.get("id") or "")
        note = result.get("stderr") or json.dumps(result.get("data"), ensure_ascii=False)[:2000]
        record_deferred_attempt(item_id, int(result["rc"]), note)
        executed.append({"id": item.get("id"), "ok": result["rc"] == 0, "command": command, "result": result})
        if result["rc"] == 0 and item.get("id"):
            run([str(LEASE), "remove-deferred", str(item["id"])], timeout=30)
    return {"ok": all(x.get("ok") for x in executed), "due_seen": len(items), "executed": executed}


def cycle(*, dispatch_limit: int = 2, roadmap: bool = False, emergency: bool = True, deferred_limit: int = 5) -> dict:
    ok, lease_id, lease_data = acquire_cycle_lease()
    if not ok:
        results = {"generated_at": utc(), "ok": True, "status": "skipped-active-orchestrator", "lease": lease_data, "steps": []}
        write_state(results)
        return results
    results = {"generated_at": utc(), "lease_id": lease_id, "steps": []}
    try:
        if LEASE.exists():
            results["steps"].append(run([str(LEASE), "clean"], timeout=60))
            results["steps"].append({"argv": [str(LEASE), "run-due"], "rc": 0, "data": run_due_deferred(deferred_limit), "stderr": ""})
        if QUEUE.exists():
            results["steps"].append(run([str(QUEUE), "reap-stale", "--age", os.environ.get("NOVA_JOB_STALE_SECONDS", "14400")], timeout=60))
        state_tool = LIB_DIR / "nova-state.py"
        if state_tool.exists():
            results["steps"].append(run([str(state_tool), "audit", "--json"], timeout=120))
        if HEALTH.exists():
            results["steps"].append(run([str(HEALTH), "--write", "--quick"], timeout=120))
        if DISPATCHER.exists() and dispatch_limit > 0:
            results["steps"].append(run([str(DISPATCHER), "dispatch-loop", "--limit", str(dispatch_limit)], timeout=900))
        if roadmap and ROADMAP.exists():
            results["steps"].append(run([str(ROADMAP), "enqueue", "--limit", "3"], timeout=120))
        if RELEASE_TRAIN.exists():
            results["steps"].append(run([str(RELEASE_TRAIN), "status"], timeout=120))
        if emergency and EMERGENCY.exists():
            results["steps"].append(run([str(EMERGENCY), "check", "--dry-run"], timeout=120))
        write_state(results)
        return results
    finally:
        release_cycle_lease(lease_id)


def status() -> dict:
    try:
        state = json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        state = {}
    status = {"generated_at": utc(), "state": state}
    for name, tool, args in [
        ("leases", LEASE, ["status", "--json"]),
        ("queue", QUEUE, ["stats"]),
        ("dispatcher", DISPATCHER, ["status"]),
        ("release_train", RELEASE_TRAIN, ["status"]),
        ("emergency", EMERGENCY, ["status"]),
    ]:
        if tool.exists():
            status[name] = run([str(tool), *args], timeout=120)
    return status


def print_json(data) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="NOVA orchestration kernel")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("cycle")
    sp.add_argument("--dispatch-limit", type=int, default=2)
    sp.add_argument("--deferred-limit", type=int, default=5)
    sp.add_argument("--roadmap", action="store_true")
    sp.add_argument("--no-emergency", action="store_true")
    sub.add_parser("status")
    args = p.parse_args(argv)
    if args.cmd == "cycle":
        return print_json(cycle(dispatch_limit=args.dispatch_limit, deferred_limit=args.deferred_limit, roadmap=args.roadmap, emergency=not args.no_emergency))
    if args.cmd == "status":
        return print_json(status())
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
