#!/usr/bin/env python3
"""NOVA durable job queue.

Jobs are stored as individual JSON files. The queue uses a single filesystem
lock for deterministic claim/requeue semantics across timers, Telegram commands,
and remote workers. This avoids SQLite/system dependencies while still preventing
race conditions between concurrent dispatcher/orchestrator passes.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import socket
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova"))
QUEUE_DIR = Path(os.environ.get("NOVA_JOB_DIR", str(VAR_DIR / "jobs")))
QUARANTINE_DIR = Path(os.environ.get("NOVA_STATE_QUARANTINE_DIR", str(VAR_DIR / "quarantine")))
STATUS_ORDER = ["queued", "claimed", "running", "succeeded", "failed", "blocked", "cancelled", "deferred"]
VALID_STATUS = set(STATUS_ORDER)
VALID_KIND = {"analysis", "fix", "develop", "improve", "ci-repair", "release", "maintenance", "emergency", "custom"}
PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "P4": 4}
LOCK_FILE = QUEUE_DIR / ".queue.lock"
DEFAULT_STALE_SECONDS = int(os.environ.get("NOVA_JOB_STALE_SECONDS", "14400"))


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now() -> int:
    return int(time.time())


def ensure() -> None:
    for status in STATUS_ORDER:
        (QUEUE_DIR / status).mkdir(parents=True, exist_ok=True)
    QUARANTINE_DIR.mkdir(parents=True, exist_ok=True)


class queue_lock:
    def __enter__(self):
        ensure()
        self.fh = LOCK_FILE.open("a+", encoding="utf-8")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type, exc, tb):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()
        return False


def atomic_json(path: Path, data: dict) -> None:
    ensure()
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


def safe_id(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.:-]+", "-", s)[:160].strip("-") or uuid.uuid4().hex


def path_for(job_id: str, status: str | None = None) -> Path:
    if status:
        return QUEUE_DIR / status / f"{safe_id(job_id)}.json"
    ensure()
    for st in STATUS_ORDER:
        p = QUEUE_DIR / st / f"{safe_id(job_id)}.json"
        if p.exists():
            return p
    return QUEUE_DIR / "queued" / f"{safe_id(job_id)}.json"


def quarantine_bad_json(path: Path, error: str) -> None:
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        dst_dir = QUARANTINE_DIR / "jobs" / stamp / path.parent.name
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / (path.name + ".bad")
        shutil.move(str(path), str(dst))
        meta = {"source": str(path), "quarantined_at": utc(), "error": error}
        atomic_json(dst.with_suffix(dst.suffix + ".json"), meta)
    except Exception:
        pass

def read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        quarantine_bad_json(path, str(exc))
        return None
    except Exception:
        return None


def iter_jobs(statuses: list[str] | None = None) -> list[dict]:
    ensure()
    result = []
    for status in (statuses or STATUS_ORDER):
        if status not in VALID_STATUS:
            continue
        for p in (QUEUE_DIR / status).glob("*.json"):
            data = read(p)
            if data:
                data["_path"] = str(p)
                result.append(data)
    return result


def write_job(job: dict, status: str | None = None) -> dict:
    status = status or job.get("status") or "queued"
    job["status"] = status
    job["updated_at"] = utc()
    atomic_json(path_for(job["id"], status), job)
    return job


def move_job(job: dict, new_status: str) -> dict:
    old_path = Path(job.get("_path") or path_for(job["id"], job.get("status")))
    job.pop("_path", None)
    old_status = job.get("status")
    job["status"] = new_status
    job.setdefault("history", []).append({"at": utc(), "from": old_status, "to": new_status})
    write_job(job, new_status)
    try:
        if old_path.exists() and old_path != path_for(job["id"], new_status):
            old_path.unlink()
    except Exception:
        pass
    return job


def enqueue(args) -> dict:
    ensure()
    kind = args.kind if args.kind in VALID_KIND else "custom"
    priority = args.priority.upper()
    if priority not in PRIORITY_ORDER:
        priority = "P2"
    job_id = args.id or f"{priority.lower()}-{kind}-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    payload = {}
    if args.payload:
        try:
            payload = json.loads(args.payload)
        except Exception as exc:
            raise SystemExit(f"invalid payload json: {exc}")
    job = {
        "id": safe_id(job_id),
        "kind": kind,
        "title": args.title.strip(),
        "description": args.description.strip(),
        "priority": priority,
        "status": "queued",
        "source": args.source,
        "channel": args.channel,
        "release_channel": args.release_channel,
        "project_dir": args.project_dir or os.environ.get("NOVA_PROJECT_DIR", ""),
        "attempts": 0,
        "max_attempts": args.max_attempts,
        "created_at": utc(),
        "created_epoch": now(),
        "updated_at": utc(),
        "not_before_epoch": args.not_before or 0,
        "payload": payload,
        "acceptance": args.acceptance,
        "validation": args.validation,
        "history": [{"at": utc(), "to": "queued", "source": args.source}],
    }
    return write_job(job, "queued")


def get_job(job_id: str) -> dict | None:
    p = path_for(job_id)
    data = read(p)
    if data:
        data["_path"] = str(p)
    return data


def eligible(job: dict) -> bool:
    if job.get("status") != "queued":
        return False
    if int(job.get("not_before_epoch") or 0) > now():
        return False
    if int(job.get("attempts") or 0) >= int(job.get("max_attempts") or 3):
        return False
    return True


def next_job() -> dict | None:
    jobs = [j for j in iter_jobs(["queued"]) if eligible(j)]
    jobs.sort(key=lambda j: (PRIORITY_ORDER.get(j.get("priority", "P2"), 2), int(j.get("created_epoch") or 0)))
    return jobs[0] if jobs else None


def claim(worker: str) -> dict:
    job = next_job()
    if not job:
        return {"ok": False, "status": "empty"}
    job["claimed_by"] = worker or socket.gethostname()
    job["claimed_at"] = utc()
    return {"ok": True, "job": move_job(job, "claimed")}


def update_status(job_id: str, status: str, *, note: str = "", result: str = "", not_before: int = 0) -> dict:
    if status not in VALID_STATUS:
        raise SystemExit(f"invalid status: {status}")
    job = get_job(job_id)
    if not job:
        return {"ok": False, "status": "not-found", "id": job_id}
    if status == "running":
        job["attempts"] = int(job.get("attempts") or 0) + 1
        job["started_at"] = utc()
    if status in {"succeeded", "failed", "cancelled", "blocked"}:
        job["finished_at"] = utc()
    if status == "queued" and not_before:
        job["not_before_epoch"] = int(not_before)
    if note:
        job.setdefault("notes", []).append({"at": utc(), "note": note})
    if result:
        job["result"] = result
    return {"ok": True, "job": move_job(job, status)}


def requeue(job_id: str, *, note: str = "manual requeue", delay_seconds: int = 0) -> dict:
    nb = now() + max(0, int(delay_seconds)) if delay_seconds else 0
    return update_status(job_id, "queued", note=note, not_before=nb)

def reap_stale(age_seconds: int = DEFAULT_STALE_SECONDS) -> dict:
    ensure()
    cutoff = now() - max(60, int(age_seconds))
    requeued = []
    for status in ["claimed", "running"]:
        for path in (QUEUE_DIR / status).glob("*.json"):
            job = read(path)
            if not job:
                continue
            updated_epoch = int(path.stat().st_mtime)
            if updated_epoch > cutoff:
                continue
            job.setdefault("notes", []).append({"at": utc(), "note": f"requeued stale {status} job after {age_seconds}s"})
            job["claimed_by"] = ""
            job["claimed_at"] = ""
            requeued.append(move_job(job, "queued"))
    return {"generated_at": utc(), "ok": True, "requeued": requeued, "age_seconds": age_seconds}


def stats() -> dict:
    ensure()
    counts = {st: len(list((QUEUE_DIR / st).glob("*.json"))) for st in STATUS_ORDER}
    by_kind: dict[str, int] = {}
    for j in iter_jobs():
        by_kind[j.get("kind", "unknown")] = by_kind.get(j.get("kind", "unknown"), 0) + 1
    return {"generated_at": utc(), "queue_dir": str(QUEUE_DIR), "counts": counts, "by_kind": by_kind}


def print_json(data) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="NOVA durable job queue")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("enqueue")
    sp.add_argument("--id", default="")
    sp.add_argument("--kind", default="custom")
    sp.add_argument("--title", required=True)
    sp.add_argument("--description", default="")
    sp.add_argument("--priority", default="P2")
    sp.add_argument("--source", default="manual")
    sp.add_argument("--channel", default="dev")
    sp.add_argument("--release-channel", default="")
    sp.add_argument("--project-dir", default="")
    sp.add_argument("--acceptance", default="")
    sp.add_argument("--validation", default="")
    sp.add_argument("--payload", default="")
    sp.add_argument("--not-before", type=int, default=0)
    sp.add_argument("--max-attempts", type=int, default=3)

    sp = sub.add_parser("list")
    sp.add_argument("--status", action="append")
    sp.add_argument("--limit", type=int, default=50)

    sp = sub.add_parser("show")
    sp.add_argument("job_id")

    sp = sub.add_parser("claim")
    sp.add_argument("--worker", default="")

    sp = sub.add_parser("set-status")
    sp.add_argument("job_id")
    sp.add_argument("status", choices=STATUS_ORDER)
    sp.add_argument("--note", default="")
    sp.add_argument("--result", default="")
    sp.add_argument("--not-before", type=int, default=0)

    sp = sub.add_parser("requeue")
    sp.add_argument("job_id")
    sp.add_argument("--note", default="manual requeue")
    sp.add_argument("--delay", type=int, default=0)

    sp = sub.add_parser("cancel")
    sp.add_argument("job_id")
    sp.add_argument("--note", default="manual cancellation")

    sub.add_parser("next")
    sp = sub.add_parser("reap-stale")
    sp.add_argument("--age", type=int, default=DEFAULT_STALE_SECONDS)
    sub.add_parser("stats")

    args = p.parse_args(argv)
    with queue_lock():
        if args.cmd == "enqueue":
            return print_json({"ok": True, "job": enqueue(args)})
        if args.cmd == "list":
            jobs = iter_jobs(args.status)
            jobs.sort(key=lambda j: (PRIORITY_ORDER.get(j.get("priority", "P2"), 2), int(j.get("created_epoch") or 0)))
            return print_json({"generated_at": utc(), "jobs": jobs[: max(1, args.limit)]})
        if args.cmd == "show":
            job = get_job(args.job_id)
            if not job:
                print_json({"ok": False, "status": "not-found", "id": args.job_id})
                return 1
            return print_json({"ok": True, "job": job})
        if args.cmd == "claim":
            data = claim(args.worker)
            print_json(data)
            return 0 if data.get("ok") else 3
        if args.cmd == "set-status":
            data = update_status(args.job_id, args.status, note=args.note, result=args.result, not_before=args.not_before)
            print_json(data)
            return 0 if data.get("ok") else 1
        if args.cmd == "requeue":
            data = requeue(args.job_id, note=args.note, delay_seconds=args.delay)
            print_json(data)
            return 0 if data.get("ok") else 1
        if args.cmd == "cancel":
            data = update_status(args.job_id, "cancelled", note=args.note)
            print_json(data)
            return 0 if data.get("ok") else 1
        if args.cmd == "next":
            job = next_job()
            return print_json({"ok": bool(job), "job": job})
        if args.cmd == "reap-stale":
            return print_json(reap_stale(args.age))
        if args.cmd == "stats":
            return print_json(stats())
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
