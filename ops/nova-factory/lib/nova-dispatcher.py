#!/usr/bin/env python3
"""NOVA agent dispatcher.

The production server remains a control plane. By default this dispatcher does
not run heavy local build/test work. It either hands jobs to a configured remote
agent command/webhook, or leaves them queued for a remote worker to claim.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LIB_DIR = Path(os.environ.get("NOVA_LIB_DIR", "/usr/local/lib/nova"))
QUEUE = Path(os.environ.get("NOVA_QUEUE_BIN", str(LIB_DIR / "nova-job-queue.py")))
LEASE = Path(os.environ.get("NOVA_LEASE_BIN", str(LIB_DIR / "nova-lease.py")))
MODE = os.environ.get("NOVA_AGENT_DISPATCH_MODE", "remote-or-queue").strip().lower()
REMOTE_COMMAND = os.environ.get("NOVA_REMOTE_AGENT_COMMAND", "").strip()
WEBHOOK_URL = os.environ.get("NOVA_AGENT_WEBHOOK_URL", "").strip()
LOCAL_AGENT = os.environ.get("NOVA_LOCAL_AGENT_BIN", str(LIB_DIR / "agent.sh"))
GITHUB_ACTIONS_WORKER = Path(os.environ.get("NOVA_GITHUB_ACTIONS_WORKER_BIN", str(LIB_DIR / "nova-github-actions-worker.py")))
RETRYABLE_EXIT_CODES = {75}


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(argv: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, text=True, capture_output=True, timeout=timeout)


def q(*args: str, timeout: int = 120) -> tuple[int, dict, str]:
    cp = run([str(QUEUE), *args], timeout=timeout)
    try:
        return cp.returncode, json.loads(cp.stdout or "{}"), cp.stderr
    except Exception:
        return cp.returncode, {}, cp.stderr or cp.stdout


def lease_acquire(job_id: str, category: str = "dispatcher", ttl: int = 7200) -> str | None:
    cp = run([str(LEASE), "acquire", category, "--owner", f"dispatcher:{job_id}", "--job-id", job_id, "--ttl", str(ttl), "--reason", "dispatching job"], timeout=30)
    try:
        data = json.loads(cp.stdout or "{}")
    except Exception:
        return None
    return data.get("id") if data.get("ok") else None


def lease_release(lease_id: str | None) -> None:
    if lease_id:
        run([str(LEASE), "release", lease_id], timeout=30)


def backend_configured() -> bool:
    if MODE in {"github-actions", "actions"}:
        return GITHUB_ACTIONS_WORKER.exists() and bool(os.environ.get("NOVA_GITHUB_REPO") or os.environ.get("NOVA_GH_REPO"))
    if MODE in {"remote", "remote-or-queue"} and REMOTE_COMMAND:
        return True
    if MODE in {"webhook", "remote-or-queue"} and WEBHOOK_URL:
        return True
    if MODE == "local-agent" and os.environ.get("NOVA_ALLOW_LOCAL_AGENT_DISPATCH", "0") in {"1", "true", "yes", "on"}:
        return True
    return False


def remote_webhook(job: dict) -> tuple[bool, str]:
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=json.dumps(job, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "nova-dispatcher/1"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # nosec - operator-configured endpoint
        body = resp.read(64_000).decode("utf-8", errors="replace")
        return 200 <= resp.status < 300, body


def remote_command(job: dict) -> tuple[bool, str]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, prefix="nova-job-", suffix=".json") as fh:
        json.dump(job, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
        job_path = fh.name
    try:
        argv = shlex.split(REMOTE_COMMAND)
        if not argv:
            return False, "remote command is empty"
        exe = argv[0]
        if not os.path.isabs(exe):
            resolved = shutil.which(exe)
            if not resolved:
                return False, f"remote command not found: {exe}"
            argv[0] = resolved
        cp = run(argv + [job_path], timeout=int(os.environ.get("NOVA_REMOTE_AGENT_TIMEOUT", "900")))
        return cp.returncode == 0, (cp.stdout + "\n" + cp.stderr).strip()
    finally:
        try:
            os.unlink(job_path)
        except OSError:
            pass


def local_agent(job: dict) -> tuple[bool, str, bool]:
    if os.environ.get("NOVA_ALLOW_LOCAL_AGENT_DISPATCH", "0") not in {"1", "true", "yes", "on"}:
        return False, "local agent dispatch disabled; set NOVA_ALLOW_LOCAL_AGENT_DISPATCH=1 explicitly", False
    cp = run([LOCAL_AGENT], timeout=int(os.environ.get("NOVA_LOCAL_AGENT_TIMEOUT", "3600")))
    return cp.returncode == 0, (cp.stdout + "\n" + cp.stderr).strip(), cp.returncode in RETRYABLE_EXIT_CODES


def github_actions_dispatch(job: dict) -> tuple[bool, str, bool]:
    if not GITHUB_ACTIONS_WORKER.exists():
        return False, f"github actions worker tool not installed: {GITHUB_ACTIONS_WORKER}", False
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, prefix="nova-gh-job-", suffix=".json") as fh:
        json.dump(job, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
        job_path = fh.name
    try:
        cp = run([str(GITHUB_ACTIONS_WORKER), "dispatch", job_path], timeout=int(os.environ.get("NOVA_GITHUB_ACTIONS_WORKER_TIMEOUT", "900")))
        return cp.returncode == 0, (cp.stdout + "\n" + cp.stderr).strip(), cp.returncode in RETRYABLE_EXIT_CODES
    finally:
        try:
            os.unlink(job_path)
        except OSError:
            pass


def dispatch_one() -> dict:
    if not backend_configured():
        return {"ok": True, "status": "idle-no-dispatch-backend", "detail": "jobs remain queued for an external worker to claim"}
    rc, claimed, err = q("claim", "--worker", os.environ.get("NOVA_DISPATCHER_ID", "nova-dispatcher"))
    if rc != 0 or not claimed.get("ok"):
        return {"ok": True, "status": "empty", "detail": err or claimed}
    job = claimed["job"]
    job_id = job["id"]
    lease_id = lease_acquire(job_id, "dispatcher")
    if not lease_id:
        # Do not consume attempts when orchestration leases temporarily block dispatch.
        q("requeue", job_id, "--delay", os.environ.get("NOVA_DISPATCH_REQUEUE_DELAY_SECONDS", "300"), "--note", "active orchestration lease prevented dispatch")
        return {"ok": True, "status": "lease-conflict-requeued", "job": job_id}
    q("set-status", job_id, "running", "--note", f"dispatcher mode={MODE}")
    try:
        retryable = False
        if MODE in {"github-actions", "actions"}:
            ok, result, retryable = github_actions_dispatch(job)
        elif MODE in {"remote", "remote-or-queue"} and REMOTE_COMMAND:
            ok, result = remote_command(job)
        elif MODE in {"webhook", "remote-or-queue"} and WEBHOOK_URL:
            ok, result = remote_webhook(job)
        elif MODE == "local-agent":
            ok, result, retryable = local_agent(job)
        else:
            q("requeue", job_id, "--delay", os.environ.get("NOVA_DISPATCH_REQUEUE_DELAY_SECONDS", "300"), "--note", "dispatch backend unavailable after claim")
            return {"ok": True, "status": "requeued-backend-unavailable", "job": job_id}
        if retryable and not ok:
            q("requeue", job_id, "--delay", os.environ.get("NOVA_DISPATCH_REQUEUE_DELAY_SECONDS", "300"), "--note", result[:500])
            return {"ok": True, "status": "retryable-requeued", "job": job_id, "result": result[:1200]}
        q("set-status", job_id, "succeeded" if ok else "failed", "--result", result[:8000])
        return {"ok": ok, "status": "succeeded" if ok else "failed", "job": job_id, "result": result[:1200]}
    finally:
        lease_release(lease_id)


def status() -> dict:
    rc, stats, err = q("stats")
    return {
        "generated_at": utc(),
        "mode": MODE,
        "backend_configured": backend_configured(),
        "remote_command_configured": bool(REMOTE_COMMAND),
        "webhook_configured": bool(WEBHOOK_URL),
        "local_agent_enabled": os.environ.get("NOVA_ALLOW_LOCAL_AGENT_DISPATCH", "0") in {"1", "true", "yes", "on"},
        "github_actions_worker_available": GITHUB_ACTIONS_WORKER.exists(),
        "github_actions_repo": os.environ.get("NOVA_GITHUB_REPO") or os.environ.get("NOVA_GH_REPO", ""),
        "queue": stats,
        "queue_error": err if rc else "",
    }


def print_json(data) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="NOVA agent dispatcher")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("dispatch-one")
    sp = sub.add_parser("dispatch-loop")
    sp.add_argument("--limit", type=int, default=3)
    args = p.parse_args(argv)
    if args.cmd == "status":
        return print_json(status())
    if args.cmd == "dispatch-one":
        data = dispatch_one(); print_json(data); return 0 if data.get("ok") else 1
    if args.cmd == "dispatch-loop":
        results = []
        for _ in range(max(1, args.limit)):
            res = dispatch_one(); results.append(res)
            if res.get("status") in {"empty", "idle-no-dispatch-backend", "queued-for-remote-worker", "lease-conflict", "lease-conflict-requeued"}:
                break
        return print_json({"generated_at": utc(), "results": results})
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
