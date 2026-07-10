#!/usr/bin/env python3
"""NOVA release engineering helper.

Creates deterministic package manifests, validates release invariants, and builds
versioned tarballs. It intentionally avoids invoking project build/test tools;
those remain delegated to GitHub Actions unless explicitly enabled elsewhere.
"""
from __future__ import annotations

import argparse
import ast
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

EXCLUDE_DIRS = {".git", "__pycache__", "node_modules", "dist", "build", "target", ".turbo", ".cache"}
EXCLUDE_FILES = {
    "CHANGELOG.generated.md",
}
EXCLUDE_PATTERNS = ["*.pyc", "*.pyo", "*.tar.gz", "*.sha256", "*.log", "*.tmp", "*.swp"]
REQUIRED_FILES = [
    "install.sh",
    "config/nova.env.example",
    "lib/nova-admin.py",
    "lib/nova-updater.py",
    "lib/nova-config.py",
    "lib/nova-backup.py",
    "lib/nova-health.py",
    "lib/nova-release.py",
    "lib/nova-ci.py",
    "lib/nova-acceptance.py",
    "lib/nova-system.py",
    "lib/nova-runtime-certify.py",
    "lib/nova-lease.py",
    "lib/nova-job-queue.py",
    "lib/nova-dispatcher.py",
    "lib/nova-github-actions-worker.py",
    "lib/nova-branch-policy.py",
    "lib/nova-release-train.py",
    "lib/nova-emergency.py",
    "lib/nova-roadmap.py",
    "lib/nova-orchestrator.py",
    "lib/nova-state.py",
    "repo-overlay/nova-bot.py",
    "systemd/nova-bot.service",
    "systemd/nova-self-update.timer",
    "systemd/nova-orchestrator.timer",
    "systemd/nova-dispatcher.timer",
    "systemd/nova-emergency.timer",
]


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def should_skip(path: Path, root: Path, *, for_manifest: bool = False) -> bool:
    rel = path.relative_to(root)
    parts = set(rel.parts)
    if parts & EXCLUDE_DIRS:
        return True
    if for_manifest and rel.as_posix() == "FACTORY_MANIFEST.json":
        return True
    if rel.as_posix() in EXCLUDE_FILES:
        return True
    return any(fnmatch.fnmatch(path.name, pat) for pat in EXCLUDE_PATTERNS)


def files(root: Path, *, for_manifest: bool = False) -> list[Path]:
    out: list[Path] = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and not should_skip(p, root, for_manifest=for_manifest):
            out.append(p)
    return out


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(root: Path) -> dict:
    entries = []
    for p in files(root, for_manifest=True):
        rel = p.relative_to(root).as_posix()
        entries.append({"path": rel, "sha256": sha256(p), "bytes": p.stat().st_size})
    return {
        "name": "nova-factory",
        "edition": "autonomous-production-orchestrator",
        "manifest_format": 2,
        "created_at": utc(),
        "file_count": len(entries),
        "capabilities": [
            "rbac-telegram-control-plane",
            "actor-correlated-jsonl-audit",
            "privileged-admin-boundary",
            "config-validation-redaction",
            "health-snapshots",
            "root-owned-backup-restore-prune",
            "validated-self-update-rollback",
            "release-engineering",
            "ci-read-model",
            "acceptance-matrix",
            "shell-free-telegram-read-path",
            "production-system-snapshot",
            "runtime-certification",
            "global-leases-and-inhibitors",
            "durable-job-queue",
            "remote-agent-dispatch",
            "alpha-beta-stable-release-train",
            "emergency-recovery-policy",
            "evidence-based-roadmap-scoring",
            "orchestration-kernel",
            "state-integrity-quarantine",
            "deferred-attempt-tracking",
            "package-validation",
            "systemd-monitor-watchdog-integration",
        ],
        "files": entries,
    }


def write_manifest(root: Path) -> dict:
    data = manifest(root)
    (root / "FACTORY_MANIFEST.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return data


def run(argv: list[str], timeout: int = 60) -> tuple[int, str, str]:
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return cp.returncode, cp.stdout.strip(), cp.stderr.strip()
    except Exception as exc:
        return 127, "", str(exc)


def validate(root: Path) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    root = root.resolve()
    for rel in REQUIRED_FILES:
        if not (root / rel).exists():
            errors.append(f"missing required file: {rel}")
    for p in files(root):
        try:
            data = p.read_bytes()
        except Exception as exc:
            errors.append(f"unreadable: {p}: {exc}")
            continue
        rel = p.relative_to(root).as_posix()
        if b"\r\n" in data or b"\r" in data:
            errors.append(f"CRLF/CR found: {rel}")
        if p.suffix == ".sh":
            rc, _out, err = run(["bash", "-n", str(p)], 30)
            if rc != 0:
                errors.append(f"bash syntax failed: {rel}: {err}")
        if p.suffix == ".py":
            try:
                ast.parse(data.decode("utf-8"), filename=str(p))
            except Exception as exc:
                errors.append(f"python syntax failed: {rel}: {exc}")
    if list(root.rglob("__pycache__")):
        errors.append("__pycache__ directories found")
    if list(root.rglob("*.pyc")):
        errors.append(".pyc files found")
    sudoers_text = (root / "install.sh").read_text(encoding="utf-8", errors="replace") if (root / "install.sh").exists() else ""
    if "NOPASSWD: ALL" in sudoers_text:
        errors.append("unrestricted sudoers rule detected")
    env_text = (root / "config/nova.env.example").read_text(encoding="utf-8", errors="replace") if (root / "config/nova.env.example").exists() else ""
    if "NOVA_ENABLE_EXEC=0" not in env_text:
        errors.append("/exec is not disabled in nova.env.example")
    bot_text = (root / "repo-overlay/nova-bot.py").read_text(encoding="utf-8", errors="replace") if (root / "repo-overlay/nova-bot.py").exists() else ""
    if "OWNER_USER_IDS" not in bot_text or "NOVA_OWNER_IDS" not in bot_text:
        errors.append("telegram owner allowlist is missing")
    if "--actor" not in bot_text or "--correlation-id" not in bot_text:
        errors.append("telegram admin calls are not actor-correlated")
    if "create_subprocess_shell" in bot_text:
        errors.append("telegram bot must not use create_subprocess_shell")
    if "shell=True" in bot_text:
        errors.append("telegram bot must not use shell=True")
    if "NOVA_EXEC_ALLOWLIST=git,gh,systemctl" in env_text:
        errors.append("exec allowlist remains too broad for production defaults")
    for required in ["nova-lease.py", "nova-job-queue.py", "nova-dispatcher.py", "nova-github-actions-worker.py", "nova-branch-policy.py", "nova-release-train.py", "nova-emergency.py", "nova-roadmap.py", "nova-orchestrator.py", "nova-state.py"]:
        if required not in sudoers_text + bot_text + env_text and not (root / "lib" / required).exists():
            errors.append(f"orchestration surface missing {required}")
    if "should-defer maintenance" not in (root / "lib" / "scripts" / "maintenance.sh").read_text(encoding="utf-8", errors="replace"):
        errors.append("maintenance does not respect global leases")
    if "acquire_task_lease" not in (root / "lib" / "agent.sh").read_text(encoding="utf-8", errors="replace"):
        errors.append("agent controller does not publish task leases")
    mf = root / "FACTORY_MANIFEST.json"
    if mf.exists():
        try:
            recorded = json.loads(mf.read_text(encoding="utf-8"))
            by_path = {x["path"]: x for x in recorded.get("files", []) if isinstance(x, dict) and "path" in x}
            for p in files(root, for_manifest=True):
                rel = p.relative_to(root).as_posix()
                if rel not in by_path:
                    warnings.append(f"manifest missing current file: {rel}")
                    continue
                if by_path[rel].get("sha256") != sha256(p):
                    warnings.append(f"manifest hash stale: {rel}")
        except Exception as exc:
            errors.append(f"manifest unreadable: {exc}")
    else:
        warnings.append("FACTORY_MANIFEST.json missing; run nova-release.py manifest")
    return {"generated_at": utc(), "path": str(root), "valid": not errors, "errors": errors, "warnings": warnings}


def version_string(root: Path, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    v = root / "VERSION"
    if v.exists():
        raw = v.read_text(encoding="utf-8", errors="replace").strip().splitlines()[0]
        raw = "-".join(raw.split())
        return "".join(c for c in raw if c.isalnum() or c in ".-_")[:80] or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def build_package(root: Path, output_dir: Path, version: str | None = None) -> dict:
    root = root.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(root)
    ver = version_string(root, version)
    archive = output_dir / f"nova-factory-{ver}.tar.gz"
    tmp_parent = Path(tempfile.mkdtemp(prefix="nova-release-"))
    try:
        staging = tmp_parent / "nova-factory"
        shutil.copytree(root, staging, ignore=lambda d, names: [n for n in names if should_skip(Path(d) / n, root if Path(d).is_relative_to(root) else Path(d))])
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(staging, arcname="nova-factory")
    finally:
        shutil.rmtree(tmp_parent, ignore_errors=True)
    digest = sha256(archive)
    (archive.with_suffix(archive.suffix + ".sha256")).write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    return {"ok": True, "archive": str(archive), "sha256": digest, "sha256_file": str(archive.with_suffix(archive.suffix + ".sha256"))}


def checksum(path: Path) -> dict:
    if path.is_dir():
        data = {p.relative_to(path).as_posix(): sha256(p) for p in files(path)}
        return {"generated_at": utc(), "path": str(path), "files": data}
    return {"generated_at": utc(), "path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size}


def changelog(root: Path) -> dict:
    data = manifest(root)
    lines = ["# Generated Changelog", "", f"Generated: {data['created_at']}", "", "## Capabilities", ""]
    for cap in data["capabilities"]:
        lines.append(f"- {cap}")
    lines += ["", "## Package inventory", "", f"- Files: {data['file_count']}"]
    out = root / "CHANGELOG.generated.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"ok": True, "path": str(out), "bytes": out.stat().st_size}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA release engineering helper")
    parser.add_argument("cmd", choices=["validate", "manifest", "package", "checksum", "changelog"])
    parser.add_argument("--path", default=".")
    parser.add_argument("--output-dir", default=".")
    parser.add_argument("--version")
    args = parser.parse_args(argv)
    root = Path(args.path).resolve()
    if args.cmd == "validate":
        data = validate(root)
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0 if data["valid"] else 2
    if args.cmd == "manifest":
        data = write_manifest(root)
    elif args.cmd == "package":
        data = build_package(root, Path(args.output_dir), args.version)
    elif args.cmd == "checksum":
        data = checksum(root)
    elif args.cmd == "changelog":
        data = changelog(root)
    else:
        return 2
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
