#!/usr/bin/env python3
"""NOVA backup and restore manager.

Backups are root-owned operational archives. They may contain secrets from
/etc/nova, so archives are created as 0600 and are never intended for public
sharing.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ENV_FILE = Path(os.environ.get("NOVA_ENV_FILE", "/etc/nova/nova.env"))
LIB_DIR = Path("/usr/local/lib/nova")
LEASE = Path(os.environ.get("NOVA_LEASE_BIN", str(LIB_DIR / "nova-lease.py")))
SYSTEMD_DIR = Path("/etc/systemd/system")
DEFAULT_BACKUP_DIR = Path("/var/backups/nova")
SERVICE_RE = re.compile(r"^nova-[A-Za-z0-9_.@-]+\.(service|timer)$")
REPO_OVERLAY = {
    "nova-bot.py", "nova-bot-update.py", "nova-dev-agent.sh", "nova-watchdog.py",
    "AGENTS.md", "CONSTITUTION.md", "Plan.md",
}


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
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
            env[k] = v
    return env


def cfg() -> dict:
    env = parse_env()
    return {
        "env": env,
        "project_dir": Path(env.get("NOVA_PROJECT_DIR", "/home/ubuntu/NOVA")),
        "backup_dir": Path(env.get("NOVA_BACKUP_DIR") or env.get("NOVA_UPDATE_BACKUP_DIR") or str(DEFAULT_BACKUP_DIR)),
        "retention_days": int(env.get("NOVA_BACKUP_RETENTION_DAYS", "14") or "14"),
        "max_count": int(env.get("NOVA_BACKUP_MAX_COUNT", "20") or "20"),
    }


def safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-._") or "manual"


def collect_targets(project_dir: Path) -> list[Path]:
    targets: list[Path] = []
    for p in [ENV_FILE.parent, LIB_DIR]:
        if p.exists():
            targets.append(p)
    for unit in SYSTEMD_DIR.glob("nova-*.service"):
        if SERVICE_RE.fullmatch(unit.name):
            targets.append(unit)
    for unit in SYSTEMD_DIR.glob("nova-*.timer"):
        if SERVICE_RE.fullmatch(unit.name):
            targets.append(unit)
    if project_dir.exists():
        for name in REPO_OVERLAY:
            p = project_dir / name
            if p.exists():
                targets.append(p)
    return targets


def tar_add_safe(tar: tarfile.TarFile, path: Path, arcname: str) -> None:
    def filt(ti: tarfile.TarInfo) -> tarfile.TarInfo | None:
        parts = Path(ti.name).parts
        if "__pycache__" in parts or ti.name.endswith(".pyc"):
            return None
        if "/node_modules/" in ti.name or "/.git/objects/" in ti.name or "/target/" in ti.name:
            return None
        return ti
    tar.add(path, arcname=arcname, recursive=True, filter=filt)


def create(label: str = "manual") -> dict:
    c = cfg()
    backup_dir: Path = c["backup_dir"]
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = f"nova-backup-{stamp}-{safe_name(label)}.tar.gz"
    backup = backup_dir / name
    targets = collect_targets(c["project_dir"])
    manifest = {
        "created_at": utc(),
        "label": label,
        "project_dir": str(c["project_dir"]),
        "targets": [str(t) for t in targets],
        "format": 2,
    }
    with tempfile.TemporaryDirectory(prefix="nova-backup-") as td:
        mp = Path(td) / "backup-manifest.json"
        mp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        with tarfile.open(backup, "w:gz") as tar:
            tar.add(mp, arcname="backup-manifest.json")
            for target in targets:
                if target.exists():
                    tar_add_safe(tar, target, str(target).lstrip("/"))
    backup.chmod(0o600)
    return {"ok": True, "backup": str(backup), "manifest": manifest, "size_bytes": backup.stat().st_size}


def list_backups() -> dict:
    c = cfg()
    backup_dir: Path = c["backup_dir"]
    items = []
    for p in sorted(backup_dir.glob("nova-*.tar.gz"), key=lambda x: x.stat().st_mtime, reverse=True):
        entry = {"path": str(p), "name": p.name, "size_bytes": p.stat().st_size, "mtime": int(p.stat().st_mtime)}
        try:
            with tarfile.open(p, "r:gz") as tar:
                mf = tar.extractfile("backup-manifest.json")
                if mf:
                    entry["manifest"] = json.loads(mf.read().decode("utf-8"))
        except Exception as exc:
            entry["warning"] = str(exc)
        items.append(entry)
    return {"generated_at": utc(), "backup_dir": str(backup_dir), "count": len(items), "backups": items}


def newest_backup(path_arg: str | None = None) -> Path:
    if path_arg:
        p = Path(path_arg)
        if not p.exists():
            raise SystemExit(f"backup not found: {p}")
        return p
    items = list_backups()["backups"]
    if not items:
        raise SystemExit("no backups found")
    return Path(items[0]["path"])


def safe_extract(tar_path: Path, dest: Path = Path("/")) -> None:
    dest = dest.resolve()
    with tarfile.open(tar_path, "r:gz") as tar:
        members = []
        for member in tar.getmembers():
            if member.name == "backup-manifest.json":
                continue
            rel = Path(member.name)
            if rel.is_absolute() or ".." in rel.parts:
                raise RuntimeError(f"unsafe member: {member.name}")
            target = (dest / rel).resolve()
            if dest != Path("/").resolve() and not str(target).startswith(str(dest)):
                raise RuntimeError(f"unsafe target: {member.name}")
            members.append(member)
        tar.extractall(dest, members=members)



def acquire_restore_lease() -> str | None:
    if not LEASE.exists():
        return None
    cp = subprocess.run([str(LEASE), "acquire", "restore", "--owner", f"backup-restore:{os.getpid()}", "--ttl", "3600", "--reason", "backup restore"], capture_output=True, text=True, timeout=30)
    try:
        data = json.loads(cp.stdout or "{}")
    except Exception:
        data = {}
    if cp.returncode == 0 and data.get("ok") and data.get("id"):
        return str(data["id"])
    raise SystemExit("restore blocked by active orchestration lease: " + (cp.stdout or cp.stderr)[-1000:])

def release_restore_lease(lease_id: str | None) -> None:
    if lease_id and LEASE.exists():
        subprocess.run([str(LEASE), "release", lease_id], capture_output=True, text=True, timeout=30)

def restore(path_arg: str | None = None) -> dict:
    lease_id = acquire_restore_lease()
    try:
        backup = newest_backup(path_arg)
        safe_extract(backup, Path("/"))
        subprocess.run(["systemctl", "daemon-reload"], capture_output=True, text=True, timeout=60)
        return {"ok": True, "restored": str(backup), "restored_at": utc(), "lease_id": lease_id}
    finally:
        release_restore_lease(lease_id)


def inspect(path_arg: str | None = None) -> dict:
    backup = newest_backup(path_arg)
    with tarfile.open(backup, "r:gz") as tar:
        names = tar.getnames()
        manifest = {}
        try:
            mf = tar.extractfile("backup-manifest.json")
            if mf:
                manifest = json.loads(mf.read().decode("utf-8"))
        except Exception:
            pass
    return {"backup": str(backup), "manifest": manifest, "members": names[:500], "member_count": len(names)}


def prune() -> dict:
    c = cfg()
    backup_dir: Path = c["backup_dir"]
    max_count = c["max_count"]
    retention_days = c["retention_days"]
    now = datetime.now(timezone.utc).timestamp()
    backups = sorted(backup_dir.glob("nova-*.tar.gz"), key=lambda p: p.stat().st_mtime, reverse=True)
    removed = []
    keep = []
    for idx, p in enumerate(backups):
        age_days = (now - p.stat().st_mtime) / 86400
        if idx >= max_count or age_days > retention_days:
            try:
                p.unlink()
                removed.append(str(p))
            except Exception:
                keep.append(str(p))
        else:
            keep.append(str(p))
    return {"ok": True, "removed": removed, "kept": keep, "retention_days": retention_days, "max_count": max_count}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA backup manager")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("create")
    p.add_argument("label", nargs="?", default="manual")
    sub.add_parser("list")
    p = sub.add_parser("inspect")
    p.add_argument("backup", nargs="?")
    p = sub.add_parser("restore")
    p.add_argument("backup", nargs="?")
    sub.add_parser("prune")
    args = parser.parse_args(argv)
    if args.cmd == "create":
        data = create(args.label)
    elif args.cmd == "list":
        data = list_backups()
    elif args.cmd == "inspect":
        data = inspect(args.backup)
    elif args.cmd == "restore":
        data = restore(args.backup)
    elif args.cmd == "prune":
        data = prune()
    else:
        return 2
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
