#!/usr/bin/env python3
"""NOVA global leases and inhibitors.

This is the coordination primitive that keeps scheduled maintenance, updates,
cleanup, watchdog intervention, release work, and agent jobs from interrupting
one another. It is intentionally file-based so it works before databases or
network services are available.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import socket
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova"))
LEASE_DIR = Path(os.environ.get("NOVA_LEASE_DIR", str(VAR_DIR / "leases")))
DEFER_DIR = Path(os.environ.get("NOVA_DEFER_DIR", str(VAR_DIR / "deferred")))
LOCK_FILE = LEASE_DIR / ".lease.lock"
DEFAULT_TTL = int(os.environ.get("NOVA_DEFAULT_LEASE_TTL_SECONDS", "7200"))
MAX_DEFERRAL_SECONDS = int(os.environ.get("NOVA_MAX_DEFERRAL_SECONDS", "21600"))
MAX_DEFERRED_ATTEMPTS = int(os.environ.get("NOVA_DEFERRED_MAX_ATTEMPTS", "6"))
QUARANTINE_DIR = Path(os.environ.get("NOVA_STATE_QUARANTINE_DIR", str(VAR_DIR / "quarantine")))

CRITICAL_CATEGORIES = {"agent", "release", "update", "backup", "restore", "maintenance", "cleanup", "watchdog", "emergency", "dispatcher", "orchestrator"}
CONFLICTS: dict[str, set[str]] = {
    "agent": {"update", "maintenance", "cleanup", "release", "dispatcher"},
    "dispatcher": {"update", "maintenance", "cleanup", "release", "agent"},
    "update": {"agent", "dispatcher", "release", "backup", "maintenance", "cleanup"},
    "release": {"agent", "dispatcher", "update", "backup", "maintenance", "cleanup"},
    "backup": {"update", "release", "restore"},
    "restore": {"update", "release", "backup", "agent", "dispatcher", "maintenance", "cleanup"},
    "orchestrator": {"orchestrator"},
    "maintenance": {"agent", "dispatcher", "update", "release", "backup", "restore"},
    "cleanup": {"agent", "dispatcher", "update", "release", "backup", "restore"},
    "watchdog": {"update", "release", "backup"},
    "emergency": set(),
}


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now() -> int:
    return int(time.time())


def ensure_dirs() -> None:
    LEASE_DIR.mkdir(parents=True, exist_ok=True)
    DEFER_DIR.mkdir(parents=True, exist_ok=True)
    QUARANTINE_DIR.mkdir(parents=True, exist_ok=True)


class lease_lock:
    def __enter__(self):
        ensure_dirs()
        self.fh = LOCK_FILE.open("a+", encoding="utf-8")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type, exc, tb):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()
        return False


def atomic_json(path: Path, data: dict) -> None:
    ensure_dirs()
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        dir_fd = os.open(str(path.parent), os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        pass


def quarantine_bad_json(path: Path, error: str) -> None:
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        dst_dir = QUARANTINE_DIR / "leases" / stamp
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / (path.name + ".bad")
        shutil.move(str(path), str(dst))
        meta = {"source": str(path), "quarantined_at": utc(), "error": error}
        atomic_json(dst.with_suffix(dst.suffix + ".json"), meta)
    except Exception:
        pass

def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        quarantine_bad_json(path, str(exc))
        return None
    except Exception:
        return None


def lease_path(lease_id: str) -> Path:
    safe = "".join(c for c in lease_id if c.isalnum() or c in "._-:")[:160]
    return LEASE_DIR / f"{safe}.json"


def clean_expired() -> list[dict]:
    ensure_dirs()
    active: list[dict] = []
    ts = now()
    for path in LEASE_DIR.glob("*.json"):
        data = read_json(path)
        if not data:
            try:
                path.unlink()
            except Exception:
                pass
            continue
        expires_at = int(data.get("expires_epoch") or 0)
        if expires_at and expires_at < ts:
            data["expired_at"] = utc()
            data["status"] = "expired"
            try:
                path.unlink()
            except Exception:
                pass
            continue
        active.append(data)
    return active


def list_leases() -> list[dict]:
    return sorted(clean_expired(), key=lambda x: (x.get("category", ""), x.get("created_epoch", 0)))


def conflicting(category: str, *, allow_soft: bool = False) -> list[dict]:
    blocked_by = CONFLICTS.get(category, set())
    conflicts = []
    for lease in list_leases():
        lcat = lease.get("category")
        hard = bool(lease.get("hard", True))
        if lcat == category and category in {"update", "release", "backup", "restore", "orchestrator"}:
            conflicts.append(lease)
        elif lcat in blocked_by and (hard or not allow_soft):
            conflicts.append(lease)
    return conflicts


def acquire(category: str, owner: str, ttl: int, reason: str, *, hard: bool = True, job_id: str = "") -> dict:
    ensure_dirs()
    category = category.strip().lower()
    if category not in CRITICAL_CATEGORIES and not category.startswith("custom:"):
        raise SystemExit(f"unsupported lease category: {category}")
    conflicts = conflicting(category)
    if conflicts:
        return {"ok": False, "status": "conflict", "category": category, "conflicts": conflicts}
    lease_id = f"{category}-{uuid.uuid4().hex[:12]}"
    ts = now()
    data = {
        "ok": True,
        "id": lease_id,
        "category": category,
        "owner": owner or f"pid:{os.getpid()}",
        "reason": reason,
        "job_id": job_id,
        "hard": bool(hard),
        "host": socket.gethostname(),
        "pid": os.getpid(),
        "created_at": utc(),
        "created_epoch": ts,
        "expires_at": datetime.fromtimestamp(ts + ttl, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expires_epoch": ts + ttl,
    }
    atomic_json(lease_path(lease_id), data)
    return data


def release(lease_id: str) -> dict:
    path = lease_path(lease_id)
    if not path.exists():
        return {"ok": False, "status": "not-found", "id": lease_id}
    data = read_json(path) or {"id": lease_id}
    try:
        path.unlink()
    except Exception as exc:
        return {"ok": False, "status": "error", "id": lease_id, "error": str(exc)}
    data.update({"ok": True, "status": "released", "released_at": utc()})
    return data


def renew(lease_id: str, ttl: int) -> dict:
    path = lease_path(lease_id)
    data = read_json(path)
    if not data:
        return {"ok": False, "status": "not-found", "id": lease_id}
    ts = now()
    data["renewed_at"] = utc()
    data["expires_epoch"] = ts + ttl
    data["expires_at"] = datetime.fromtimestamp(ts + ttl, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    atomic_json(path, data)
    return {"ok": True, "status": "renewed", **data}


def defer(category: str, command: list[str], reason: str, *, actor: str = "", max_age: int = MAX_DEFERRAL_SECONDS) -> dict:
    ensure_dirs()
    ts = now()
    norm_cmd = [str(x) for x in command]
    # Coalesce duplicate deferred commands so timers do not create unbounded
    # backlogs while one long-running critical task is holding a lease.
    for path in sorted(DEFER_DIR.glob("*.json")):
        existing = read_json(path)
        if existing and existing.get("category") == category and existing.get("command") == norm_cmd:
            existing["updated_at"] = utc()
            existing["reason"] = reason or existing.get("reason", "")
            existing["defer_count"] = int(existing.get("defer_count") or 1) + 1
            existing["not_after_epoch"] = max(int(existing.get("not_after_epoch") or 0), ts + max_age)
            atomic_json(path, existing)
            return {"ok": True, "coalesced": True, **existing}
    item_id = f"{category}-{ts}-{uuid.uuid4().hex[:8]}"
    data = {
        "id": item_id,
        "category": category,
        "command": norm_cmd,
        "reason": reason,
        "actor": actor or os.environ.get("NOVA_ACTOR", "system"),
        "created_at": utc(),
        "created_epoch": ts,
        "not_after_epoch": ts + max_age,
        "defer_count": 1,
        "status": "deferred",
        "attempts": 0,
        "max_attempts": MAX_DEFERRED_ATTEMPTS,
    }
    atomic_json(DEFER_DIR / f"{item_id}.json", data)
    return {"ok": True, **data}


def due_deferred() -> list[dict]:
    ensure_dirs()
    result = []
    for path in sorted(DEFER_DIR.glob("*.json")):
        data = read_json(path)
        if not data or data.get("status") not in {"deferred", "retry"}:
            continue
        if int(data.get("not_before_epoch") or 0) > now():
            continue
        if int(data.get("attempts") or 0) >= int(data.get("max_attempts") or MAX_DEFERRED_ATTEMPTS):
            data["status"] = "failed"
            data["failed_at"] = utc()
            data.setdefault("last_error", "maximum deferred attempts reached")
            atomic_json(path, data)
            continue
        category = str(data.get("category") or "maintenance")
        conflicts = conflicting(category, allow_soft=True)
        if not conflicts:
            data["path"] = str(path)
            result.append(data)
        elif int(data.get("not_after_epoch") or 0) <= now():
            data["overdue"] = True
            data["blocked_by"] = conflicts
            data["last_blocked_at"] = utc()
            atomic_json(path, data)
    return result


def deferred_path(item_id: str) -> Path:
    safe = "".join(c for c in item_id if c.isalnum() or c in "._-:")[:160]
    return DEFER_DIR / f"{safe}.json"

def remove_deferred(item_id: str) -> dict:
    path = deferred_path(item_id)
    if not path.exists():
        return {"ok": False, "status": "not-found", "id": item_id}
    path.unlink()
    return {"ok": True, "status": "removed", "id": item_id}

def record_deferred_attempt(item_id: str, rc: int, note: str = "") -> dict:
    path = deferred_path(item_id)
    data = read_json(path)
    if not data:
        return {"ok": False, "status": "not-found", "id": item_id}
    data["attempts"] = int(data.get("attempts") or 0) + 1
    data["last_attempt_at"] = utc()
    data["last_rc"] = int(rc)
    if note:
        data["last_error"] = note[-2000:]
    if rc == 0:
        data["status"] = "succeeded"
        data["succeeded_at"] = utc()
    elif data["attempts"] >= int(data.get("max_attempts") or MAX_DEFERRED_ATTEMPTS):
        data["status"] = "failed"
        data["failed_at"] = utc()
    else:
        data["status"] = "retry"
        data["not_before_epoch"] = now() + min(3600, 60 * (2 ** max(0, data["attempts"] - 1)))
        data["updated_at"] = utc()
    atomic_json(path, data)
    return {"ok": True, **data}


def should_defer(category: str, command: list[str] | None = None, reason: str = "") -> dict:
    conflicts = conflicting(category)
    if not conflicts:
        return {"ok": True, "defer": False, "category": category, "conflicts": []}
    item = None
    if command:
        item = defer(category, command, reason or f"blocked by active lease for {category}")
    return {"ok": True, "defer": True, "category": category, "conflicts": conflicts, "deferred": item}


def print_json(data: dict | list) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="NOVA global lease and deferral manager")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("acquire")
    sp.add_argument("category")
    sp.add_argument("--owner", default="")
    sp.add_argument("--ttl", type=int, default=DEFAULT_TTL)
    sp.add_argument("--reason", default="")
    sp.add_argument("--job-id", default="")
    sp.add_argument("--soft", action="store_true")

    sp = sub.add_parser("release")
    sp.add_argument("lease_id")

    sp = sub.add_parser("renew")
    sp.add_argument("lease_id")
    sp.add_argument("--ttl", type=int, default=DEFAULT_TTL)

    sp = sub.add_parser("status")
    sp.add_argument("--json", action="store_true")

    sp = sub.add_parser("should-defer")
    sp.add_argument("--reason", default="")
    sp.add_argument("category")
    sp.add_argument("--command", nargs=argparse.REMAINDER, default=[])

    sp = sub.add_parser("defer")
    sp.add_argument("category")
    sp.add_argument("command", nargs=argparse.REMAINDER)
    sp.add_argument("--reason", default="manual deferral")

    sub.add_parser("due")
    sp = sub.add_parser("remove-deferred")
    sp.add_argument("item_id")
    sp = sub.add_parser("record-deferred-attempt")
    sp.add_argument("item_id")
    sp.add_argument("--rc", type=int, required=True)
    sp.add_argument("--note", default="")
    sub.add_parser("clean")

    args = p.parse_args(argv)
    with lease_lock():
        if args.cmd == "acquire":
            data = acquire(args.category, args.owner, args.ttl, args.reason, hard=not args.soft, job_id=args.job_id)
            print_json(data)
            return 0 if data.get("ok") else 75
        if args.cmd == "release":
            data = release(args.lease_id); print_json(data); return 0 if data.get("ok") else 1
        if args.cmd == "renew":
            data = renew(args.lease_id, args.ttl); print_json(data); return 0 if data.get("ok") else 1
        if args.cmd == "status":
            data = {"generated_at": utc(), "leases": list_leases(), "deferred": [read_json(p) for p in sorted(DEFER_DIR.glob('*.json')) if read_json(p)]}
            return print_json(data)
        if args.cmd == "should-defer":
            command = list(args.command or [])
            if command and command[0] == "--":
                command = command[1:]
            data = should_defer(args.category, command, args.reason)
            print_json(data)
            return 75 if data.get("defer") else 0
        if args.cmd == "defer":
            return print_json(defer(args.category, args.command, args.reason))
        if args.cmd == "due":
            return print_json({"generated_at": utc(), "due": due_deferred()})
        if args.cmd == "remove-deferred":
            data = remove_deferred(args.item_id); print_json(data); return 0 if data.get("ok") else 1
        if args.cmd == "record-deferred-attempt":
            data = record_deferred_attempt(args.item_id, args.rc, args.note); print_json(data); return 0 if data.get("ok") else 1
        if args.cmd == "clean":
            leases = clean_expired(); print_json({"generated_at": utc(), "active": leases}); return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
