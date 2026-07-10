#!/usr/bin/env python3
"""NOVA privileged admin boundary.

Every privileged operation reachable from Telegram or timers is allowlisted here.
The bot should never call raw sudo/systemctl/shell commands directly.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LIB_DIR = Path("/usr/local/lib/nova")
UPDATER = LIB_DIR / "nova-updater.py"
CONFIG = LIB_DIR / "nova-config.py"
BACKUP = LIB_DIR / "nova-backup.py"
HEALTH = LIB_DIR / "nova-health.py"
RELEASE = LIB_DIR / "nova-release.py"
CI = LIB_DIR / "nova-ci.py"
ACCEPTANCE = LIB_DIR / "nova-acceptance.py"
SYSTEM = LIB_DIR / "nova-system.py"
CERTIFY = LIB_DIR / "nova-runtime-certify.py"
LEASE = LIB_DIR / "nova-lease.py"
QUEUE = LIB_DIR / "nova-job-queue.py"
DISPATCHER = LIB_DIR / "nova-dispatcher.py"
RELEASE_TRAIN = LIB_DIR / "nova-release-train.py"
EMERGENCY = LIB_DIR / "nova-emergency.py"
ROADMAP = LIB_DIR / "nova-roadmap.py"
ORCHESTRATOR = LIB_DIR / "nova-orchestrator.py"
STATE = LIB_DIR / "nova-state.py"
GITHUB_WORKER = LIB_DIR / "nova-github-actions-worker.py"
BRANCH_POLICY = LIB_DIR / "nova-branch-policy.py"
AUDIT_LOG = Path(os.environ.get("NOVA_AUDIT_LOG", "/var/log/nova/audit.log"))
ACTOR = os.environ.get("NOVA_ACTOR", "")
CORRELATION_ID = os.environ.get("NOVA_CORRELATION_ID", "")
SERVICE_RE = re.compile(r"^nova-[A-Za-z0-9_.@-]+\.(service|timer)$")
ALLOWED_ACTIONS = {"status", "start", "stop", "restart", "enable", "disable", "is-active", "is-enabled"}
ALLOWED_SERVICES = {
    "nova-dev-agent.service",
    "nova-monitor.service",
    "nova-bot.service",
    "nova-watchdog.timer",
    "nova-maintenance.timer",
    "nova-daily-digest.timer",
    "nova-api-health.timer",
    "nova-self-update.timer",
    "nova-orchestrator.service",
    "nova-orchestrator.timer",
    "nova-dispatcher.service",
    "nova-dispatcher.timer",
    "nova-emergency.service",
    "nova-emergency.timer",
}
LOGS = {
    "controller": "/var/log/nova/nova-dev-agent.log",
    "telegram": "/var/log/nova/nova-bot.log",
    "monitor": "/var/log/nova/nova-monitor.log",
    "watchdog": "/var/log/nova/nova-watchdog.log",
    "maintenance": "/var/log/nova/nova-maintenance.log",
    "updater": "/var/log/nova/nova-updater.log",
    "audit": "/var/log/nova/audit.log",
}
REDACT_RE = re.compile(r"(bot\d+:[A-Za-z0-9_-]+|token=[^\s]+|Authorization:\s*Bearer\s+[^\s]+)", re.I)


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def redact(text: str) -> str:
    return REDACT_RE.sub("***REDACTED***", text)


def audit(action: str, args: list[str], rc: int, duration_ms: int) -> None:
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": utc(),
            "event": "admin.command",
            "action": action,
            "args": [redact(str(x)) for x in args],
            "returncode": rc,
            "duration_ms": duration_ms,
            "uid": os.getuid(),
            "euid": os.geteuid(),
            "sudo_user": os.environ.get("SUDO_USER"),
            "actor": ACTOR or os.environ.get("NOVA_TELEGRAM_USER_ID"),
            "correlation_id": CORRELATION_ID or os.environ.get("NOVA_CORRELATION_ID"),
        }
        with AUDIT_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        try:
            AUDIT_LOG.chmod(0o600)
        except Exception:
            pass
    except Exception:
        pass


def run(argv: list[str], timeout: int = 120, *, passthrough: bool = True) -> int:
    started = time.time()
    cp = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    out = redact(cp.stdout)
    err = redact(cp.stderr)
    if passthrough:
        sys.stdout.write(out)
        sys.stderr.write(err)
    audit(Path(argv[0]).name, argv[1:], cp.returncode, int((time.time() - started) * 1000))
    return int(cp.returncode)


def run_json(argv: list[str], timeout: int = 120) -> tuple[int, dict | list | None, str]:
    started = time.time()
    cp = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    audit(Path(argv[0]).name, argv[1:], cp.returncode, int((time.time() - started) * 1000))
    try:
        return cp.returncode, json.loads(cp.stdout or "null"), cp.stderr
    except Exception:
        return cp.returncode, None, cp.stderr or cp.stdout


def require_service(name: str) -> None:
    if not SERVICE_RE.fullmatch(name) or name not in ALLOWED_SERVICES:
        raise SystemExit(f"service is not allowed: {name}")


def cmd_service(args) -> int:
    require_service(args.name)
    if args.action not in ALLOWED_ACTIONS:
        raise SystemExit(f"action is not allowed: {args.action}")
    if args.action == "status":
        return run(["systemctl", "status", args.name, "--no-pager", "-l"], 30)
    return run(["systemctl", args.action, args.name], 60)


def unit_snapshot(name: str) -> dict:
    require_service(name)
    def one(*cmd: str) -> str:
        cp = subprocess.run(list(cmd), text=True, capture_output=True, timeout=15)
        return (cp.stdout or cp.stderr).strip()
    return {
        "name": name,
        "active": one("systemctl", "is-active", name),
        "enabled": one("systemctl", "is-enabled", name),
        "failed": one("systemctl", "is-failed", name),
    }


def cmd_services(args) -> int:
    if args.json:
        data = {name: unit_snapshot(name) for name in sorted(ALLOWED_SERVICES)}
        print(json.dumps({"generated_at": utc(), "services": data}, indent=2, ensure_ascii=False))
        audit("services", ["--json"], 0, 0)
        return 0
    units = sorted(ALLOWED_SERVICES)
    return run(["systemctl", "status", *units, "--no-pager", "-l"], 60)


def cmd_update(args) -> int:
    if not UPDATER.exists():
        raise SystemExit(f"updater not installed: {UPDATER}")
    if args.update_action == "history":
        # History is composed from update status plus operational backups.
        status_rc, status, status_err = run_json([str(UPDATER), "status"], 60)
        backup_rc, backups, backup_err = run_json([str(BACKUP), "list"], 60) if BACKUP.exists() else (127, None, "backup tool not installed")
        data = {"generated_at": utc(), "update_status": status, "backups": backups, "errors": [e for e in [status_err, backup_err] if e]}
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0 if status_rc == 0 and backup_rc in {0, 127} else 2
    cmd = [str(UPDATER), args.update_action]
    if args.force and args.update_action in {"apply", "auto"}:
        cmd.append("--force")
    if args.backup and args.update_action == "rollback":
        cmd.append(args.backup)
    return run(cmd, 900)


def cmd_maintenance(args) -> int:
    script = LIB_DIR / "scripts" / "maintenance.sh"
    if not script.exists():
        raise SystemExit("maintenance.sh is not installed")
    return run([str(script)], 900)


def cmd_doctor(args) -> int:
    script = LIB_DIR / "scripts" / "doctor.sh"
    if script.exists():
        cmd = [str(script)]
        if args.json:
            cmd.append("--json")
        if args.quick:
            cmd.append("--quick")
        return run(cmd, 300)
    data = {"generated_at": utc(), "lib_dir": str(LIB_DIR), "updater": UPDATER.exists(), "python": sys.version.split()[0]}
    print(json.dumps(data, indent=2, ensure_ascii=False))
    audit("doctor", [], 0, 0)
    return 0


def cmd_logs(args) -> int:
    source = args.source
    if source not in LOGS:
        raise SystemExit(f"unknown log source: {source}")
    n = max(1, min(int(args.lines), 500))
    path = Path(LOGS[source])
    if not path.exists():
        print(f"log file not found: {path}")
        audit("logs", [source, str(n)], 0, 0)
        return 0
    return run(["/usr/bin/tail", f"-{n}", str(path)], 30)


def cmd_config(args) -> int:
    if not CONFIG.exists():
        raise SystemExit(f"config tool not installed: {CONFIG}")
    cmd = [str(CONFIG), args.config_action]
    if args.env:
        cmd = [str(CONFIG), "--env", args.env, args.config_action]
    return run(cmd, 120)


def cmd_backup(args) -> int:
    if not BACKUP.exists():
        raise SystemExit(f"backup tool not installed: {BACKUP}")
    cmd = [str(BACKUP), args.backup_action]
    label = getattr(args, "label", None)
    backup = getattr(args, "backup", None)
    if label and args.backup_action == "create":
        cmd.append(label)
    if backup and args.backup_action in {"inspect", "restore"}:
        cmd.append(backup)
    return run(cmd, 900)


def cmd_health(args) -> int:
    if not HEALTH.exists():
        raise SystemExit(f"health tool not installed: {HEALTH}")
    cmd = [str(HEALTH)]
    if args.write:
        cmd.append("--write")
    if args.quick:
        cmd.append("--quick")
    return run(cmd, 120)

def cmd_release(args) -> int:
    if not RELEASE.exists():
        raise SystemExit(f"release tool not installed: {RELEASE}")
    cmd = [str(RELEASE), args.release_action]
    if args.path:
        cmd.extend(["--path", args.path])
    if args.output_dir:
        cmd.extend(["--output-dir", args.output_dir])
    if args.version:
        cmd.extend(["--version", args.version])
    return run(cmd, 900)


def cmd_ci(args) -> int:
    if not CI.exists():
        raise SystemExit(f"ci tool not installed: {CI}")
    cmd = [str(CI), args.ci_action]
    if args.limit:
        cmd.extend(["--limit", str(args.limit)])
    return run(cmd, 120)



def cmd_system(args) -> int:
    if not SYSTEM.exists():
        raise SystemExit(f"system tool not installed: {SYSTEM}")
    cmd = [str(SYSTEM), "--format", args.format]
    if getattr(args, "sort", None):
        cmd.extend(["--sort", args.sort])
    return run(cmd, 120)

def cmd_acceptance(args) -> int:
    if not ACCEPTANCE.exists():
        raise SystemExit(f"acceptance tool not installed: {ACCEPTANCE}")
    cmd = [str(ACCEPTANCE)]
    if args.path:
        cmd.extend(["--path", args.path])
    if args.json:
        cmd.append("--json")
    return run(cmd, 900)



def cmd_certify(args) -> int:
    if not CERTIFY.exists():
        raise SystemExit(f"runtime certification tool not installed: {CERTIFY}")
    cmd = [str(CERTIFY)]
    if args.json:
        cmd.append("--json")
    if args.include_backup:
        cmd.append("--include-backup")
    return run(cmd, 420)


def cmd_lease(args) -> int:
    if not LEASE.exists():
        raise SystemExit(f"lease tool not installed: {LEASE}")
    cmd = [str(LEASE), args.lease_action]
    if args.lease_action == "acquire":
        cmd.append(args.category)
        if args.owner:
            cmd.extend(["--owner", args.owner])
        if args.ttl:
            cmd.extend(["--ttl", str(args.ttl)])
        if args.reason:
            cmd.extend(["--reason", args.reason])
        if args.soft:
            cmd.append("--soft")
    elif args.lease_action in {"release", "renew", "remove-deferred", "record-deferred-attempt"}:
        cmd.append(args.identifier)
        if args.lease_action == "renew" and args.ttl:
            cmd.extend(["--ttl", str(args.ttl)])
        if args.lease_action == "record-deferred-attempt":
            cmd.extend(["--rc", str(args.rc)])
            if args.note:
                cmd.extend(["--note", args.note])
    elif args.lease_action in {"should-defer", "defer"}:
        cmd.append(args.category)
        if args.lease_action == "should-defer":
            if args.reason:
                cmd.extend(["--reason", args.reason])
        else:
            if args.reason:
                cmd.extend(["--reason", args.reason])
            cmd.extend(args.command or [])
    return run(cmd, 120)


def cmd_queue(args) -> int:
    if not QUEUE.exists():
        raise SystemExit(f"queue tool not installed: {QUEUE}")
    cmd = [str(QUEUE), args.queue_action]
    if args.queue_action == "enqueue":
        cmd.extend(["--kind", args.kind, "--priority", args.priority, "--title", args.title])
        if args.description:
            cmd.extend(["--description", args.description])
        if args.source:
            cmd.extend(["--source", args.source])
    elif args.queue_action in {"show", "cancel"}:
        cmd.append(args.job_id)
    elif args.queue_action == "requeue":
        cmd.append(args.job_id)
        if args.note:
            cmd.extend(["--note", args.note])
        if args.delay:
            cmd.extend(["--delay", str(args.delay)])
    elif args.queue_action == "set-status":
        cmd.extend([args.job_id, args.status])
        if args.note:
            cmd.extend(["--note", args.note])
        if args.not_before:
            cmd.extend(["--not-before", str(args.not_before)])
    elif args.queue_action == "list":
        if args.status:
            for st in args.status:
                cmd.extend(["--status", st])
        if args.limit:
            cmd.extend(["--limit", str(args.limit)])
    elif args.queue_action == "claim":
        if args.worker:
            cmd.extend(["--worker", args.worker])
    elif args.queue_action == "reap-stale":
        if args.age:
            cmd.extend(["--age", str(args.age)])
    return run(cmd, 180)


def cmd_dispatcher(args) -> int:
    if not DISPATCHER.exists():
        raise SystemExit(f"dispatcher tool not installed: {DISPATCHER}")
    cmd = [str(DISPATCHER), args.dispatch_action]
    if args.dispatch_action == "dispatch-loop" and args.limit:
        cmd.extend(["--limit", str(args.limit)])
    return run(cmd, 900)



def cmd_branch_policy(args) -> int:
    if not BRANCH_POLICY.exists():
        raise SystemExit(f"branch policy tool not installed: {BRANCH_POLICY}")
    cmd = [str(BRANCH_POLICY), args.branch_policy_action]
    if args.branch_policy_action in {"validate-branch", "guard-push"}:
        cmd.append(args.branch)
        if args.branch_policy_action == "guard-push" and args.purpose:
            cmd.extend(["--purpose", args.purpose])
    elif args.branch_policy_action == "target-for":
        if args.kind:
            cmd.append(args.kind)
        if args.channel:
            cmd.extend(["--channel", args.channel])
    elif args.branch_policy_action == "branch-name":
        if args.job_id:
            cmd.extend(["--job-id", args.job_id])
        if args.kind:
            cmd.extend(["--kind", args.kind])
        if args.title:
            cmd.extend(["--title", args.title])
    return run(cmd, 180)

def cmd_github_worker(args) -> int:
    if not GITHUB_WORKER.exists():
        raise SystemExit(f"github actions worker tool not installed: {GITHUB_WORKER}")
    cmd = [str(GITHUB_WORKER), args.github_worker_action]
    if args.github_worker_action == "dispatch":
        if args.job_json:
            cmd.append(args.job_json)
        if args.job_id:
            cmd.extend(["--job-id", args.job_id])
        if args.task:
            cmd.extend(["--task", args.task])
        if args.mode:
            cmd.extend(["--mode", args.mode])
        if args.target_branch:
            cmd.extend(["--target-branch", args.target_branch])
    return run(cmd, 900)


def cmd_release_train(args) -> int:
    if not RELEASE_TRAIN.exists():
        raise SystemExit(f"release train tool not installed: {RELEASE_TRAIN}")
    cmd = [str(RELEASE_TRAIN), args.train_action]
    if args.train_action in {"cut", "promote"}:
        cmd.extend([args.channel, args.version])
        if args.force:
            cmd.append("--force")
    elif args.train_action == "rollback":
        cmd.append(args.channel)
        if args.reason:
            cmd.extend(["--reason", args.reason])
    elif args.train_action in {"freeze", "unfreeze"}:
        if args.reason:
            cmd.extend(["--reason", args.reason])
    return run(cmd, 300)


def cmd_emergency(args) -> int:
    if not EMERGENCY.exists():
        raise SystemExit(f"emergency tool not installed: {EMERGENCY}")
    cmd = [str(EMERGENCY), args.emergency_action]
    if args.emergency_action in {"check", "restart-unhealthy"}:
        if args.dry_run:
            cmd.append("--dry-run")
        if args.emergency_action == "check" and args.reboot:
            cmd.append("--reboot")
    return run(cmd, 180)


def cmd_roadmap(args) -> int:
    if not ROADMAP.exists():
        raise SystemExit(f"roadmap tool not installed: {ROADMAP}")
    cmd = [str(ROADMAP), args.roadmap_action]
    if args.limit:
        cmd.extend(["--limit", str(args.limit)])
    return run(cmd, 180)


def cmd_state(args) -> int:
    if not STATE.exists():
        raise SystemExit(f"state tool not installed: {STATE}")
    cmd = [str(STATE), args.state_action, "--json"]
    if args.var_dir:
        cmd.extend(["--var-dir", args.var_dir])
    return run(cmd, 180)


def cmd_orchestrator(args) -> int:
    if not ORCHESTRATOR.exists():
        raise SystemExit(f"orchestrator tool not installed: {ORCHESTRATOR}")
    cmd = [str(ORCHESTRATOR), args.orchestrator_action]
    if args.orchestrator_action == "cycle":
        if args.dispatch_limit is not None:
            cmd.extend(["--dispatch-limit", str(args.dispatch_limit)])
        if args.deferred_limit is not None:
            cmd.extend(["--deferred-limit", str(args.deferred_limit)])
        if args.roadmap:
            cmd.append("--roadmap")
        if args.no_emergency:
            cmd.append("--no-emergency")
    return run(cmd, 900)

def cmd_validate_package(args) -> int:
    root = Path(args.path).resolve()
    if not root.exists():
        raise SystemExit(f"package path not found: {root}")
    errors: list[str] = []
    for sh in root.rglob("*.sh"):
        cp = subprocess.run(["bash", "-n", str(sh)], capture_output=True, text=True, timeout=30)
        if cp.returncode != 0:
            errors.append(f"bash -n failed: {sh}: {cp.stderr.strip()}")
    for py in root.rglob("*.py"):
        try:
            import ast
            ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        except Exception as exc:
            errors.append(f"python syntax failed: {py}: {exc}")
    crlf = []
    for p in root.rglob("*"):
        if p.is_file() and p.stat().st_size < 2_000_000:
            try:
                if b"\r\n" in p.read_bytes():
                    crlf.append(str(p))
            except Exception:
                pass
    if crlf:
        errors.append("CRLF files: " + ", ".join(crlf[:20]))
    bot = root / "repo-overlay" / "nova-bot.py"
    if bot.exists():
        bot_text = bot.read_text(encoding="utf-8", errors="replace")
        if "create_subprocess_shell" in bot_text:
            errors.append("telegram bot must not use create_subprocess_shell")
        if "shell=True" in bot_text:
            errors.append("telegram bot must not use shell=True")
    required_tools = ["nova-lease.py", "nova-job-queue.py", "nova-dispatcher.py", "nova-github-actions-worker.py", "nova-branch-policy.py", "nova-release-train.py", "nova-emergency.py", "nova-roadmap.py", "nova-orchestrator.py", "nova-state.py"]
    missing_tools = [name for name in required_tools if not (root / "lib" / name).exists()]
    if missing_tools:
        errors.append("missing orchestration tools: " + ", ".join(missing_tools))
    env_example = root / "config" / "nova.env.example"
    if env_example.exists():
        env_text = env_example.read_text(encoding="utf-8", errors="replace")
        if "NOVA_EXEC_ALLOWLIST=git,gh,systemctl" in env_text:
            errors.append("production exec allowlist is too broad")
    data = {"generated_at": utc(), "path": str(root), "valid": not errors, "errors": errors}
    print(json.dumps(data, indent=2, ensure_ascii=False))
    audit("validate-package", [str(root)], 0 if not errors else 2, 0)
    return 0 if not errors else 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="NOVA privileged admin boundary")
    parser.add_argument("--actor", default="", help="audited caller identity, e.g. telegram:<id>:<role>")
    parser.add_argument("--correlation-id", default="", help="audited command correlation id")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("service")
    p.add_argument("action", choices=sorted(ALLOWED_ACTIONS))
    p.add_argument("name")
    p.set_defaults(func=cmd_service)

    p = sub.add_parser("services")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_services)

    p = sub.add_parser("update")
    p.add_argument("update_action", choices=["status", "check", "apply", "auto", "rollback", "history"])
    p.add_argument("backup", nargs="?")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("maintenance")
    p.set_defaults(func=cmd_maintenance)

    p = sub.add_parser("doctor")
    p.add_argument("--json", action="store_true")
    p.add_argument("--quick", action="store_true")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("logs")
    p.add_argument("source", choices=sorted(LOGS))
    p.add_argument("lines", nargs="?", default="60")
    p.set_defaults(func=cmd_logs)

    p = sub.add_parser("config")
    p.add_argument("config_action", choices=["validate", "safe", "diff"])
    p.add_argument("--env")
    p.set_defaults(func=cmd_config)

    p = sub.add_parser("backup")
    bsub = p.add_subparsers(dest="backup_action", required=True)
    bp = bsub.add_parser("create")
    bp.add_argument("label", nargs="?")
    bsub.add_parser("list")
    bp = bsub.add_parser("inspect")
    bp.add_argument("backup", nargs="?")
    bp = bsub.add_parser("restore")
    bp.add_argument("backup", nargs="?")
    bsub.add_parser("prune")
    p.set_defaults(func=cmd_backup)

    p = sub.add_parser("health")
    p.add_argument("--write", action="store_true")
    p.add_argument("--quick", action="store_true")
    p.set_defaults(func=cmd_health)

    p = sub.add_parser("release")
    p.add_argument("release_action", choices=["validate", "manifest", "package", "checksum", "changelog"])
    p.add_argument("--path")
    p.add_argument("--output-dir")
    p.add_argument("--version")
    p.set_defaults(func=cmd_release)

    p = sub.add_parser("ci")
    p.add_argument("ci_action", choices=["status", "failed", "prs", "release"])
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_ci)

    p = sub.add_parser("system")
    p.add_argument("system_action", choices=["snapshot"], nargs="?", default="snapshot")
    p.add_argument("--format", choices=["json", "text"], default="json")
    p.add_argument("--sort", choices=["cpu", "mem", "pid"], default="cpu")
    p.set_defaults(func=cmd_system)

    p = sub.add_parser("acceptance")
    p.add_argument("--path")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_acceptance)

    p = sub.add_parser("certify")
    p.add_argument("--json", action="store_true")
    p.add_argument("--include-backup", action="store_true")
    p.set_defaults(func=cmd_certify)


    p = sub.add_parser("lease")
    lp = p.add_subparsers(dest="lease_action", required=True)
    ap = lp.add_parser("acquire")
    ap.add_argument("category")
    ap.add_argument("--owner", default="")
    ap.add_argument("--ttl", type=int, default=7200)
    ap.add_argument("--reason", default="")
    ap.add_argument("--soft", action="store_true")
    rp = lp.add_parser("release")
    rp.add_argument("identifier")
    rp = lp.add_parser("renew")
    rp.add_argument("identifier")
    rp.add_argument("--ttl", type=int, default=7200)
    lp.add_parser("status")
    spd = lp.add_parser("should-defer")
    spd.add_argument("category")
    spd.add_argument("--reason", default="")
    dp = lp.add_parser("defer")
    dp.add_argument("category")
    dp.add_argument("--reason", default="manual deferral")
    dp.add_argument("command", nargs=argparse.REMAINDER)
    lp.add_parser("due")
    rp = lp.add_parser("remove-deferred")
    rp.add_argument("identifier")
    rd = lp.add_parser("record-deferred-attempt")
    rd.add_argument("identifier")
    rd.add_argument("--rc", type=int, required=True)
    rd.add_argument("--note", default="")
    lp.add_parser("clean")
    p.set_defaults(func=cmd_lease)

    p = sub.add_parser("queue")
    qp = p.add_subparsers(dest="queue_action", required=True)
    ep = qp.add_parser("enqueue")
    ep.add_argument("--kind", default="custom")
    ep.add_argument("--priority", default="P2")
    ep.add_argument("--title", required=True)
    ep.add_argument("--description", default="")
    ep.add_argument("--source", default="telegram")
    lp = qp.add_parser("list")
    lp.add_argument("--status", action="append")
    lp.add_argument("--limit", type=int, default=25)
    spj = qp.add_parser("show")
    spj.add_argument("job_id")
    cp = qp.add_parser("claim")
    cp.add_argument("--worker", default="admin")
    ss = qp.add_parser("set-status")
    ss.add_argument("job_id")
    ss.add_argument("status", choices=["queued", "claimed", "running", "succeeded", "failed", "blocked", "cancelled", "deferred"])
    ss.add_argument("--note", default="")
    ss.add_argument("--not-before", type=int, default=0)
    rq = qp.add_parser("requeue")
    rq.add_argument("job_id")
    rq.add_argument("--note", default="manual requeue")
    rq.add_argument("--delay", type=int, default=0)
    cn = qp.add_parser("cancel")
    cn.add_argument("job_id")
    qp.add_parser("next")
    rp = qp.add_parser("reap-stale")
    rp.add_argument("--age", type=int, default=14400)
    qp.add_parser("stats")
    p.set_defaults(func=cmd_queue)

    p = sub.add_parser("dispatcher")
    p.add_argument("dispatch_action", choices=["status", "dispatch-one", "dispatch-loop"])
    p.add_argument("--limit", type=int, default=3)
    p.set_defaults(func=cmd_dispatcher)


    p = sub.add_parser("branch-policy")
    bp = p.add_subparsers(dest="branch_policy_action", required=True)
    bp.add_parser("status")
    bp.add_parser("ensure")
    vb = bp.add_parser("validate-branch")
    vb.add_argument("branch")
    gp = bp.add_parser("guard-push")
    gp.add_argument("branch")
    gp.add_argument("--purpose", default="")
    tf = bp.add_parser("target-for")
    tf.add_argument("kind", nargs="?", default="develop")
    tf.add_argument("--channel", default="")
    bn = bp.add_parser("branch-name")
    bn.add_argument("--job-id", default="")
    bn.add_argument("--kind", default="agent")
    bn.add_argument("--title", default="task")
    p.set_defaults(func=cmd_branch_policy)

    p = sub.add_parser("github-worker")
    p.add_argument("github_worker_action", choices=["status", "render-workflow", "ensure-workflow", "dispatch"])
    p.add_argument("job_json", nargs="?")
    p.add_argument("--job-id", default="")
    p.add_argument("--task", default="")
    p.add_argument("--mode", default="")
    p.add_argument("--target-branch", default="")
    p.set_defaults(func=cmd_github_worker)

    p = sub.add_parser("release-train")
    rt = p.add_subparsers(dest="train_action", required=True)
    rt.add_parser("status")
    cp = rt.add_parser("cut")
    cp.add_argument("channel", choices=["alpha", "beta", "stable"])
    cp.add_argument("version")
    cp.add_argument("--force", action="store_true")
    pp = rt.add_parser("promote")
    pp.add_argument("channel", choices=["beta", "stable"])
    pp.add_argument("version")
    pp.add_argument("--force", action="store_true")
    rb = rt.add_parser("rollback")
    rb.add_argument("channel", choices=["alpha", "beta", "stable"])
    rb.add_argument("--reason", default="manual rollback")
    fr = rt.add_parser("freeze")
    fr.add_argument("--reason", default="manual freeze")
    uf = rt.add_parser("unfreeze")
    uf.add_argument("--reason", default="manual unfreeze")
    p.set_defaults(func=cmd_release_train)

    p = sub.add_parser("emergency")
    p.add_argument("emergency_action", choices=["status", "check", "restart-unhealthy"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--reboot", action="store_true")
    p.set_defaults(func=cmd_emergency)

    p = sub.add_parser("roadmap")
    p.add_argument("roadmap_action", choices=["ideas", "enqueue"])
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_roadmap)

    p = sub.add_parser("state")
    p.add_argument("state_action", choices=["audit", "repair", "summary"])
    p.add_argument("--var-dir", default="")
    p.set_defaults(func=cmd_state)

    p = sub.add_parser("orchestrator")
    p.add_argument("orchestrator_action", choices=["status", "cycle"])
    p.add_argument("--dispatch-limit", type=int, default=2)
    p.add_argument("--deferred-limit", type=int, default=5)
    p.add_argument("--roadmap", action="store_true")
    p.add_argument("--no-emergency", action="store_true")
    p.set_defaults(func=cmd_orchestrator)

    p = sub.add_parser("validate-package")
    p.add_argument("path")
    p.set_defaults(func=cmd_validate_package)

    args = parser.parse_args(argv)
    global ACTOR, CORRELATION_ID
    if getattr(args, "actor", ""):
        ACTOR = args.actor
    if getattr(args, "correlation_id", ""):
        CORRELATION_ID = args.correlation_id
    try:
        return int(args.func(args))
    except subprocess.TimeoutExpired as exc:
        print(f"timeout: {exc}", file=sys.stderr)
        audit("timeout", sys.argv[1:], 124, 0)
        return 124


if __name__ == "__main__":
    raise SystemExit(main())
