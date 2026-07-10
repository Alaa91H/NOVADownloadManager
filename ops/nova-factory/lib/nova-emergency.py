#!/usr/bin/env python3
"""NOVA emergency recovery policy.

Handles service restart escalation and optional server reboot with cooldown and
boot-loop protection. Reboot is disabled by default and must be explicitly
enabled by env.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova"))
STATE = Path(os.environ.get("NOVA_EMERGENCY_STATE", str(VAR_DIR / "emergency-state.json")))
HEALTH_FILE = Path(os.environ.get("NOVA_HEALTH_FILE", str(VAR_DIR / "health.json")))
LEASE_DIR = Path(os.environ.get("NOVA_LEASE_DIR", str(VAR_DIR / "leases")))
ENABLED_REBOOT = os.environ.get("NOVA_EMERGENCY_REBOOT_ENABLED", "0").lower() in {"1", "true", "yes", "on"}
FAILURE_THRESHOLD = int(os.environ.get("NOVA_EMERGENCY_FAILURE_THRESHOLD", "4"))
STALE_MINUTES = int(os.environ.get("NOVA_EMERGENCY_STALE_MINUTES", "30"))
REBOOT_COOLDOWN_HOURS = int(os.environ.get("NOVA_EMERGENCY_REBOOT_COOLDOWN_HOURS", "12"))
ALLOWED_RESTARTS = ["nova-dev-agent.service", "nova-monitor.service", "nova-bot.service"]


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now() -> int:
    return int(time.time())


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = utc()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def run(argv: list[str], timeout: int = 60) -> tuple[int, str]:
    cp = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    return cp.returncode, (cp.stdout + "\n" + cp.stderr).strip()


def service_states() -> dict:
    states = {}
    for svc in ALLOWED_RESTARTS:
        rc, out = run(["systemctl", "is-active", svc], timeout=15)
        states[svc] = {"active": out.strip(), "ok": rc == 0}
    return states


def heartbeat_stale() -> bool:
    health = read_json(HEALTH_FILE)
    epoch = int(health.get("epoch") or health.get("generated_epoch") or 0)
    if not epoch:
        return True
    return now() - epoch > STALE_MINUTES * 60



def active_lease_categories() -> set[str]:
    cats: set[str] = set()
    if not LEASE_DIR.exists():
        return cats
    for path in LEASE_DIR.glob("*.json"):
        data = read_json(path)
        if data.get("category"):
            cats.add(str(data["category"]))
    return cats

def restart_unhealthy(dry_run: bool = False) -> dict:
    states = service_states()
    actions = []
    leases = active_lease_categories()
    protected = bool(leases & {"update", "release", "backup", "restore"})
    for svc, st in states.items():
        if not st.get("ok"):
            if protected and svc == "nova-dev-agent.service":
                actions.append({"service": svc, "action": "skipped-protected-by-lease", "leases": sorted(leases)})
            elif dry_run:
                actions.append({"service": svc, "action": "would-restart"})
            else:
                rc, out = run(["systemctl", "restart", svc], timeout=60)
                actions.append({"service": svc, "action": "restart", "rc": rc, "output": out[-1000:]})
    return {"states": states, "actions": actions, "active_leases": sorted(leases)}


def reboot_allowed(state: dict) -> tuple[bool, str]:
    if not ENABLED_REBOOT:
        return False, "reboot disabled by NOVA_EMERGENCY_REBOOT_ENABLED=0"
    last = int(state.get("last_reboot_epoch") or 0)
    if last and now() - last < REBOOT_COOLDOWN_HOURS * 3600:
        return False, "reboot cooldown active"
    boot_count = int(state.get("boot_loop_count") or 0)
    if boot_count >= 2:
        return False, "boot-loop protection active"
    return True, "allowed"


def evaluate(dry_run: bool = False, reboot: bool = False) -> dict:
    state = read_json(STATE)
    stale = heartbeat_stale()
    restarts = restart_unhealthy(dry_run=dry_run)
    unhealthy = stale or bool(restarts["actions"])
    if unhealthy:
        state["consecutive_failures"] = int(state.get("consecutive_failures") or 0) + 1
        state["last_failure_at"] = utc()
    else:
        state["consecutive_failures"] = 0
    decision = "observe"
    reboot_result = None
    if reboot or int(state.get("consecutive_failures") or 0) >= FAILURE_THRESHOLD:
        allowed, reason = reboot_allowed(state)
        if allowed:
            decision = "reboot" if not dry_run else "would-reboot"
            if not dry_run:
                state["last_reboot_epoch"] = now()
                state["last_reboot_at"] = utc()
                reboot_result = run(["systemctl", "reboot", "--message=NOVA emergency policy"], timeout=20)
            else:
                reboot_result = [0, "dry-run"]
        else:
            decision = "reboot-blocked"
            reboot_result = [1, reason]
    state["last_evaluated_at"] = utc()
    write_json(STATE, state)
    return {
        "generated_at": utc(),
        "ok": not unhealthy,
        "stale_health": stale,
        "consecutive_failures": state.get("consecutive_failures", 0),
        "restart_actions": restarts["actions"],
        "services": restarts["states"],
        "decision": decision,
        "reboot_enabled": ENABLED_REBOOT,
        "reboot_result": reboot_result,
        "state": state,
    }


def print_json(data) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="NOVA emergency recovery policy")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sp = sub.add_parser("check")
    sp.add_argument("--dry-run", action="store_true")
    sp.add_argument("--reboot", action="store_true")
    sp = sub.add_parser("restart-unhealthy")
    sp.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)
    if args.cmd == "status":
        return print_json({"generated_at": utc(), "state": read_json(STATE), "reboot_enabled": ENABLED_REBOOT, "services": service_states(), "health_stale": heartbeat_stale(), "active_leases": sorted(active_lease_categories())})
    if args.cmd == "check":
        return print_json(evaluate(dry_run=args.dry_run, reboot=args.reboot))
    if args.cmd == "restart-unhealthy":
        return print_json(restart_unhealthy(dry_run=args.dry_run))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
