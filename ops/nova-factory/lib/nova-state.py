#!/usr/bin/env python3
"""NOVA runtime state integrity auditor and repair helper.

Scans the file-backed control-plane state (leases, deferred operations, job
queue, health/update/release train state) and quarantines unreadable JSON rather
than silently deleting it. This keeps long-running production installations
recoverable and auditable after disk-full, abrupt reboot, or partial-write events.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova"))
QUARANTINE_DIR = Path(os.environ.get("NOVA_STATE_QUARANTINE_DIR", str(VAR_DIR / "quarantine")))
SCAN_DIRS = ["leases", "deferred", "jobs", "backups"]
SCAN_FILES = ["health.json", "update-state.json", "orchestrator-state.json", "release-train.json", "emergency-state.json"]


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now() -> int:
    return int(time.time())


def read_json(path: Path) -> tuple[bool, object | None, str]:
    try:
        return True, json.loads(path.read_text(encoding="utf-8")), ""
    except Exception as exc:
        return False, None, str(exc)


def json_paths(var_dir: Path) -> list[Path]:
    paths: list[Path] = []
    for rel in SCAN_FILES:
        p = var_dir / rel
        if p.exists():
            paths.append(p)
    for rel in SCAN_DIRS:
        root = var_dir / rel
        if root.exists():
            paths.extend(sorted(root.rglob("*.json")))
    return sorted(set(paths))


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def quarantine(path: Path, error: str, *, var_dir: Path = VAR_DIR) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    rel = path.relative_to(var_dir) if path.is_relative_to(var_dir) else Path(path.name)
    dst = QUARANTINE_DIR / stamp / rel.with_suffix(rel.suffix + ".bad")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(dst))
    atomic_json(dst.with_suffix(dst.suffix + ".json"), {
        "source": str(path),
        "relative_source": rel.as_posix(),
        "quarantined_at": utc(),
        "error": error,
    })
    return dst


def audit(var_dir: Path = VAR_DIR) -> dict:
    paths = json_paths(var_dir)
    bad = []
    ok_count = 0
    for p in paths:
        ok, _data, err = read_json(p)
        if ok:
            ok_count += 1
        else:
            bad.append({"path": str(p), "error": err})
    return {
        "generated_at": utc(),
        "var_dir": str(var_dir),
        "ok": not bad,
        "json_files": len(paths),
        "valid_json_files": ok_count,
        "invalid_json_files": bad,
        "quarantine_dir": str(QUARANTINE_DIR),
    }


def repair(var_dir: Path = VAR_DIR) -> dict:
    report = audit(var_dir)
    moved = []
    for item in report["invalid_json_files"]:
        p = Path(item["path"])
        if p.exists():
            dst = quarantine(p, item["error"], var_dir=var_dir)
            moved.append({"source": str(p), "quarantined_to": str(dst), "error": item["error"]})
    after = audit(var_dir)
    return {"generated_at": utc(), "ok": after["ok"], "moved": moved, "after": after}


def summary(var_dir: Path = VAR_DIR) -> dict:
    report = audit(var_dir)
    counts = {}
    for d in SCAN_DIRS:
        root = var_dir / d
        counts[d] = len(list(root.rglob("*.json"))) if root.exists() else 0
    return {"generated_at": utc(), "ok": report["ok"], "counts": counts, "invalid_count": len(report["invalid_json_files"]), "quarantine_dir": str(QUARANTINE_DIR)}


def print_json(data: dict) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="NOVA runtime state integrity tool")
    p.add_argument("cmd", choices=["audit", "repair", "summary"])
    p.add_argument("--var-dir", default=str(VAR_DIR))
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    var_dir = Path(args.var_dir)
    if args.cmd == "audit":
        data = audit(var_dir)
    elif args.cmd == "repair":
        data = repair(var_dir)
    else:
        data = summary(var_dir)
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0 if data.get("ok", True) else 2


if __name__ == "__main__":
    raise SystemExit(main())
