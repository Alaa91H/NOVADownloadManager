#!/usr/bin/env python3
"""NOVA Factory updater.

A root-owned, policy-gated updater for the managed repository, Telegram bot,
controller scripts, systemd units, and factory runtime files. It is designed to
be invoked by nova-admin.py or the nova-self-update systemd timer, not directly
from arbitrary Telegram shell commands.
"""
from __future__ import annotations

import argparse
import json
import os
import ast
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

ENV_FILE = Path("/etc/nova/nova.env")
LIB_DIR = Path("/usr/local/lib/nova")
SCRIPTS_DIR = LIB_DIR / "scripts"
FACTORY_CACHE = LIB_DIR / "factory-source"
SYSTEMD_DIR = Path("/etc/systemd/system")
VAR_DIR_DEFAULT = Path("/var/lib/nova")
LOG_DIR_DEFAULT = Path("/var/log/nova")
SERVICE_ALLOWLIST = {
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
    "nova-offsite-backup.timer",
}
REPO_OVERLAY_FILES = {
    "nova-bot.py",
    "nova-bot-update.py",
    "nova-dev-agent.sh",
    "nova-watchdog.py",
    "AGENTS.md",
    "CONSTITUTION.md",
}
SCRIPT_NAMES = {
    "analyze.sh",
    "api-health.sh",
    "maintenance.sh",
    "metrics.sh",
    "offsite-backup.sh",
    "research.sh",
    "self-update.sh",
    "watchdog.sh",
    "doctor.sh",
    "package-validate.sh",
    "run-tests.sh",
    "release.sh",
}
ROOT_FILE_ALLOWLIST = {"README.md", "VERSION", "FACTORY_MANIFEST.json"}


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_env_file(path: Path = ENV_FILE) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            env[key] = value
    return env


def merged_env() -> dict[str, str]:
    env = load_env_file()
    env.update({k: v for k, v in os.environ.items() if k.startswith("NOVA_") or k in {"HOME", "PATH"}})
    return env


@dataclass
class Config:
    env: dict[str, str]
    project_dir: Path
    branch: str
    gh_repo: str
    target_user: str
    target_home: Path
    var_dir: Path
    log_dir: Path
    backup_dir: Path
    strategy: str
    auto_enabled: bool
    factory_source_dir: str

    @classmethod
    def load(cls) -> "Config":
        env = merged_env()
        user = env.get("NOVA_TARGET_USER") or os.environ.get("SUDO_USER") or "ubuntu"
        explicit_home = env.get("NOVA_TARGET_HOME")
        if explicit_home:
            home = Path(explicit_home)
        else:
            try:
                home = Path(pwd.getpwnam(user).pw_dir)
            except Exception:
                home = Path(f"/home/{user}")
        project = Path(env.get("NOVA_PROJECT_DIR") or str(home / "NOVA")).resolve()
        var_dir = Path(env.get("NOVA_VAR_DIR") or str(VAR_DIR_DEFAULT)).resolve()
        log_dir = Path(env.get("NOVA_LOG_DIR") or str(LOG_DIR_DEFAULT)).resolve()
        backup_dir = Path(env.get("NOVA_UPDATE_BACKUP_DIR") or str(var_dir / "backups")).resolve()
        strategy = (env.get("NOVA_UPDATE_STRATEGY") or "ff-only").strip().lower()
        if strategy not in {"ff-only", "rebase", "reset"}:
            strategy = "ff-only"
        enabled = (env.get("NOVA_SELF_UPDATE_ENABLED") or "1").strip().lower() in {"1", "true", "yes", "on"}
        return cls(
            env=env,
            project_dir=project,
            branch=env.get("NOVA_BRANCH") or env.get("NOVA_DEVELOP_BRANCH") or "develop",
            gh_repo=env.get("NOVA_GH_REPO") or "Alaa91H/NOVADownloadManager",
            target_user=user,
            target_home=home,
            var_dir=var_dir,
            log_dir=log_dir,
            backup_dir=backup_dir,
            strategy=strategy,
            auto_enabled=enabled,
            factory_source_dir=env.get("NOVA_FACTORY_SOURCE_DIR") or "ops/nova-factory",
        )

    @property
    def status_file(self) -> Path:
        return self.var_dir / "update-status.json"

    @property
    def log_file(self) -> Path:
        return self.log_dir / "nova-updater.log"


def ensure_dirs(cfg: Config) -> None:
    for path in [cfg.var_dir, cfg.log_dir, cfg.backup_dir, LIB_DIR, SCRIPTS_DIR]:
        path.mkdir(parents=True, exist_ok=True)


def log(cfg: Config, message: str) -> None:
    ensure_dirs(cfg)
    line = f"[{utc()}] {message}"
    print(line)
    with cfg.log_file.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def run(args: list[str], *, cwd: Path | None = None, timeout: int = 120, check: bool = False) -> subprocess.CompletedProcess[str]:
    cp = subprocess.run(args, cwd=str(cwd) if cwd else None, text=True, capture_output=True, timeout=timeout)
    if check and cp.returncode != 0:
        raise RuntimeError(f"command failed ({cp.returncode}): {' '.join(args)}\n{cp.stdout}\n{cp.stderr}")
    return cp


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_status(cfg: Config) -> dict:
    try:
        return json.loads(cfg.status_file.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_status(cfg: Config, **updates) -> dict:
    data = read_status(cfg)
    data.update(updates)
    data["updated_at"] = utc()
    atomic_json(cfg.status_file, data)
    return data


def git_value(cfg: Config, *args: str) -> str:
    cp = run(["git", "-C", str(cfg.project_dir), *args], timeout=60)
    return cp.stdout.strip()


def repo_hashes(cfg: Config) -> tuple[str, str]:
    current = git_value(cfg, "rev-parse", "HEAD") if (cfg.project_dir / ".git").exists() else "none"
    remote = "none"
    if (cfg.project_dir / ".git").exists():
        cp = run(["git", "-C", str(cfg.project_dir), "ls-remote", "origin", cfg.branch], timeout=60)
        if cp.returncode == 0 and cp.stdout.strip():
            remote = cp.stdout.split()[0]
    return current, remote


def discover_factory_dir(cfg: Config) -> Path | None:
    configured = Path(cfg.factory_source_dir)
    candidates: list[Path] = []
    candidates.append(configured if configured.is_absolute() else cfg.project_dir / configured)
    candidates.extend([
        cfg.project_dir / "ops" / "nova-factory",
        cfg.project_dir / "nova-factory",
        cfg.project_dir / ".nova" / "factory",
        FACTORY_CACHE,
    ])
    for candidate in candidates:
        if (candidate / "install.sh").exists() and (candidate / "repo-overlay").exists():
            return candidate.resolve()
    return None


def copytree_clean(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    ignore = shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "node_modules", "dist", "target")
    shutil.copytree(src, dst, ignore=ignore)


def validate_source(factory: Path) -> list[str]:
    errors: list[str] = []
    for sh in factory.rglob("*.sh"):
        cp = run(["bash", "-n", str(sh)], timeout=30)
        if cp.returncode != 0:
            errors.append(f"bash -n failed: {sh}: {cp.stderr.strip()}")
    for py in factory.rglob("*.py"):
        try:
            ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        except Exception as exc:
            errors.append(f"python syntax failed: {py}: {exc}")
    for unit in list((factory / "systemd").glob("*.service")) + list((factory / "systemd").glob("*.timer")):
        text = unit.read_text(encoding="utf-8", errors="replace")
        if "ExecStart=" in text and "nova" not in text.lower():
            errors.append(f"unexpected systemd unit content: {unit}")
    return errors


def backup_current(cfg: Config) -> Path:
    ensure_dirs(cfg)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup = cfg.backup_dir / f"nova-factory-backup-{stamp}.tar.gz"
    targets: list[Path] = []
    if LIB_DIR.exists():
        targets.append(LIB_DIR)
    for unit in SYSTEMD_DIR.glob("nova-*.service"):
        targets.append(unit)
    for unit in SYSTEMD_DIR.glob("nova-*.timer"):
        targets.append(unit)
    for name in REPO_OVERLAY_FILES:
        path = cfg.project_dir / name
        if path.exists():
            targets.append(path)
    manifest = {
        "created_at": utc(),
        "project_dir": str(cfg.project_dir),
        "branch": cfg.branch,
        "repo": cfg.gh_repo,
        "targets": [str(p) for p in targets],
    }
    with tempfile.TemporaryDirectory(prefix="nova-backup-") as td:
        td_path = Path(td)
        manifest_path = td_path / "backup-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        with tarfile.open(backup, "w:gz") as tar:
            tar.add(manifest_path, arcname="backup-manifest.json")
            for target in targets:
                if target.exists():
                    arcname = str(target).lstrip("/")
                    tar.add(target, arcname=arcname, recursive=True)
    backup.chmod(0o600)
    return backup


def safe_extract_tar(tar_path: Path, dest: Path = Path("/")) -> None:
    dest = dest.resolve()
    with tarfile.open(tar_path, "r:gz") as tar:
        members = []
        for member in tar.getmembers():
            if member.name == "backup-manifest.json":
                continue
            member_path = Path(member.name)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise RuntimeError(f"refusing unsafe archive member: {member.name}")
            target = (dest / member_path).resolve()
            if dest != Path("/").resolve() and not str(target).startswith(str(dest)):
                raise RuntimeError(f"refusing unsafe archive member: {member.name}")
            members.append(member)
        tar.extractall(dest, members=members)


def retarget_unit_text(text: str, cfg: Config) -> str:
    return (text
        .replace("/home/ubuntu/NOVA", str(cfg.project_dir))
        .replace("User=ubuntu", f"User={cfg.target_user}")
        .replace("Group=ubuntu", f"Group={cfg.target_user}")
        .replace("HOME=/home/ubuntu", f"HOME={cfg.target_home}")
        .replace("/home/ubuntu/.opencode", str(cfg.target_home / ".opencode"))
        .replace("/home/ubuntu/backups", str(cfg.target_home / "backups"))
    )


def install_file(src: Path, dst: Path, mode: int = 0o755) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    dst.chmod(mode)


def chown_user(path: Path, cfg: Config) -> None:
    try:
        shutil.chown(path, user=cfg.target_user, group=cfg.target_user)
    except Exception:
        pass


def sync_runtime_from_factory(cfg: Config, factory: Path) -> None:
    log(cfg, f"syncing factory runtime from {factory}")
    # Persist the source snapshot for future local repair/rollback operations.
    if factory.resolve() != FACTORY_CACHE.resolve():
        copytree_clean(factory, FACTORY_CACHE)

    for name in [
        "agent.sh", "monitor.sh", "controller-guard.sh", "daily-digest.py",
        "nova-admin.py", "nova-updater.py", "nova-config.py", "nova-backup.py",
        "nova-health.py", "nova-release.py", "nova-ci.py", "nova-acceptance.py", "nova-system.py", "nova-runtime-certify.py",
        "nova-lease.py", "nova-job-queue.py", "nova-dispatcher.py", "nova-github-actions-worker.py", "nova-branch-policy.py", "nova-release-train.py", "nova-emergency.py", "nova-roadmap.py", "nova-orchestrator.py", "nova-state.py",
    ]:
        src = factory / "lib" / name
        if src.exists():
            install_file(src, LIB_DIR / name, 0o755)
    if (factory / "lib" / "scripts").exists():
        SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
        for src in (factory / "lib" / "scripts").iterdir():
            if src.is_file() and src.name in SCRIPT_NAMES:
                install_file(src, SCRIPTS_DIR / src.name, 0o755)
    if (factory / "lib" / "blocked-bin" / "block-command").exists():
        bb = LIB_DIR / "blocked-bin"
        bb.mkdir(parents=True, exist_ok=True)
        install_file(factory / "lib" / "blocked-bin" / "block-command", bb / "block-command", 0o755)
        for cmd in ["cargo", "eslint", "npm", "npx", "playwright", "pnpm", "tauri", "tsc", "vite", "vitest", "yarn"]:
            link = bb / cmd
            if link.exists() or link.is_symlink():
                link.unlink()
            link.symlink_to(bb / "block-command")

    if (factory / "repo-overlay").exists():
        cfg.project_dir.mkdir(parents=True, exist_ok=True)
        for src in (factory / "repo-overlay").iterdir():
            if src.is_file() and src.name in REPO_OVERLAY_FILES:
                dst = cfg.project_dir / src.name
                install_file(src, dst, 0o755 if src.suffix in {".py", ".sh"} else 0o644)
                chown_user(dst, cfg)

    if (factory / "git-hooks").exists() and (cfg.project_dir / ".git").exists():
        hooks = cfg.project_dir / ".git" / "hooks"
        hooks.mkdir(parents=True, exist_ok=True)
        for name in ["pre-commit", "commit-msg", "pre-push"]:
            src = factory / "git-hooks" / name
            if src.exists():
                dst = hooks / name
                install_file(src, dst, 0o755)
                chown_user(dst, cfg)

    if (factory / "systemd").exists():
        for src in list((factory / "systemd").glob("*.service")) + list((factory / "systemd").glob("*.timer")):
            text = retarget_unit_text(src.read_text(encoding="utf-8"), cfg)
            dst = SYSTEMD_DIR / src.name
            dst.write_text(text, encoding="utf-8")
            dst.chmod(0o644)
        run(["systemctl", "daemon-reload"], timeout=60)


def update_repo(cfg: Config, force: bool = False) -> tuple[str, str, bool]:
    if not (cfg.project_dir / ".git").exists():
        raise RuntimeError(f"project is not a git repository: {cfg.project_dir}")
    before, remote_before = repo_hashes(cfg)
    run(["git", "-C", str(cfg.project_dir), "fetch", "origin", cfg.branch], timeout=180, check=True)
    remote = git_value(cfg, "rev-parse", f"origin/{cfg.branch}")
    dirty = git_value(cfg, "status", "--porcelain")
    strategy = "reset" if force else cfg.strategy
    if dirty and strategy != "reset":
        raise RuntimeError("repository has uncommitted changes; set NOVA_UPDATE_STRATEGY=reset or run manual cleanup")
    if before == remote:
        return before, remote, False
    if strategy == "ff-only":
        anc = run(["git", "-C", str(cfg.project_dir), "merge-base", "--is-ancestor", before, f"origin/{cfg.branch}"], timeout=30)
        if anc.returncode != 0:
            raise RuntimeError("remote is not a fast-forward of the local checkout")
        run(["git", "-C", str(cfg.project_dir), "merge", "--ff-only", f"origin/{cfg.branch}"], timeout=180, check=True)
    elif strategy == "rebase":
        run(["git", "-C", str(cfg.project_dir), "pull", "--rebase", "origin", cfg.branch], timeout=240, check=True)
    else:
        run(["git", "-C", str(cfg.project_dir), "reset", "--hard", f"origin/{cfg.branch}"], timeout=180, check=True)
    after = git_value(cfg, "rev-parse", "HEAD")
    return before, after, True


def restart_services(cfg: Config, restart_bot: bool = True) -> None:
    for service in [
        "nova-dev-agent.service", "nova-monitor.service", "nova-watchdog.timer",
        "nova-maintenance.timer", "nova-daily-digest.timer", "nova-self-update.timer",
        "nova-orchestrator.timer", "nova-dispatcher.timer", "nova-emergency.timer",
        "nova-orchestrator.service", "nova-dispatcher.service", "nova-emergency.service",
    ]:
        run(["systemctl", "try-restart", service], timeout=60)
    if restart_bot:
        # Let the caller return its Telegram reply before the interface restarts.
        subprocess.Popen([
            sys.executable,
            "-c",
            "import subprocess,time; time.sleep(4); subprocess.run(['systemctl','try-restart','nova-bot.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cleanup_backups(cfg: Config) -> None:
    keep = int(cfg.env.get("NOVA_UPDATE_BACKUP_KEEP", "8") or "8")
    backups = sorted(cfg.backup_dir.glob("nova-factory-backup-*.tar.gz"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in backups[keep:]:
        try:
            old.unlink()
        except Exception:
            pass


def check(cfg: Config) -> int:
    ensure_dirs(cfg)
    current, remote = repo_hashes(cfg)
    factory = discover_factory_dir(cfg)
    status = write_status(cfg,
        last_check_at=utc(),
        current_sha=current,
        remote_sha=remote,
        update_available=(remote != "none" and current != remote),
        factory_source=str(factory) if factory else None,
        auto_enabled=cfg.auto_enabled,
        strategy=cfg.strategy,
    )
    print(json.dumps(status, indent=2, ensure_ascii=False))
    return 0



def should_defer_update(cfg: Config, *, auto: bool) -> bool:
    if not auto:
        return False
    lease_bin = Path(cfg.env.get("NOVA_LEASE_BIN") or str(LIB_DIR / "nova-lease.py"))
    if not lease_bin.exists():
        return False
    cp = run([str(lease_bin), "should-defer", "update", "--reason", "scheduled self-update waits for active critical work", "--command", str(LIB_DIR / "nova-admin.py"), "update", "auto"], timeout=30)
    return cp.returncode == 75

def apply(cfg: Config, *, force: bool = False, auto: bool = False) -> int:
    ensure_dirs(cfg)
    if auto and not cfg.auto_enabled:
        log(cfg, "auto self-update disabled by NOVA_SELF_UPDATE_ENABLED=0")
        write_status(cfg, last_auto_at=utc(), last_result="skipped-disabled")
        return 0
    if should_defer_update(cfg, auto=auto):
        log(cfg, "auto self-update deferred because a critical orchestration lease is active")
        write_status(cfg, last_auto_at=utc(), last_result="deferred-active-lease")
        return 0

    lock_path = cfg.var_dir / "update.lock"
    with lock_path.open("w") as lock_fh:
        try:
            import fcntl
            fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log(cfg, "another update is already running")
            return 2

        before, remote = repo_hashes(cfg)
        if auto and before == remote:
            log(cfg, f"already up to date ({before[:12]})")
            write_status(cfg, last_auto_at=utc(), last_result="already-current", current_sha=before, remote_sha=remote)
            return 0

        backup = backup_current(cfg)
        write_status(cfg, last_started_at=utc(), last_result="running", backup=str(backup), previous_sha=before)
        log(cfg, f"backup created: {backup}")
        try:
            before_sha, after_sha, repo_changed = update_repo(cfg, force=force)
            factory = discover_factory_dir(cfg)
            if not factory:
                raise RuntimeError("factory source directory not found; set NOVA_FACTORY_SOURCE_DIR or keep ops/nova-factory in the repo")
            errors = validate_source(factory)
            if errors:
                raise RuntimeError("source validation failed:\n" + "\n".join(errors[:12]))
            sync_runtime_from_factory(cfg, factory)
            restart_services(cfg, restart_bot=True)
            cleanup_backups(cfg)
            write_status(cfg,
                last_finished_at=utc(),
                last_result="success",
                previous_sha=before_sha,
                current_sha=after_sha,
                repo_changed=repo_changed,
                backup=str(backup),
                factory_source=str(factory),
            )
            log(cfg, f"update complete: {before_sha[:12]} -> {after_sha[:12]}")
            return 0
        except Exception as exc:
            log(cfg, f"update failed: {exc}")
            try:
                log(cfg, f"rolling back from backup: {backup}")
                safe_extract_tar(backup, Path("/"))
                run(["systemctl", "daemon-reload"], timeout=60)
                restart_services(cfg, restart_bot=True)
                write_status(cfg, last_finished_at=utc(), last_result="rolled-back", error=str(exc), backup=str(backup))
            except Exception as rb:
                write_status(cfg, last_finished_at=utc(), last_result="rollback-failed", error=str(exc), rollback_error=str(rb), backup=str(backup))
                log(cfg, f"rollback failed: {rb}")
            return 1


def rollback(cfg: Config, backup: str | None = None) -> int:
    ensure_dirs(cfg)
    if backup:
        path = Path(backup)
    else:
        backups = sorted(cfg.backup_dir.glob("nova-factory-backup-*.tar.gz"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not backups:
            print("No backups found", file=sys.stderr)
            return 1
        path = backups[0]
    if not path.exists():
        print(f"Backup not found: {path}", file=sys.stderr)
        return 1
    safe_extract_tar(path, Path("/"))
    run(["systemctl", "daemon-reload"], timeout=60)
    restart_services(cfg, restart_bot=True)
    write_status(cfg, last_rollback_at=utc(), last_result="manual-rollback", rollback_backup=str(path))
    log(cfg, f"rollback complete from {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA factory updater")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("check")
    p_apply = sub.add_parser("apply")
    p_apply.add_argument("--force", action="store_true")
    p_auto = sub.add_parser("auto")
    p_auto.add_argument("--force", action="store_true")
    p_rb = sub.add_parser("rollback")
    p_rb.add_argument("backup", nargs="?")
    args = parser.parse_args(argv)
    cfg = Config.load()
    if args.cmd == "status":
        data = read_status(cfg)
        if not data:
            current, remote = repo_hashes(cfg)
            data = {"current_sha": current, "remote_sha": remote, "updated_at": utc()}
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "check":
        return check(cfg)
    if args.cmd == "apply":
        return apply(cfg, force=args.force, auto=False)
    if args.cmd == "auto":
        return apply(cfg, force=args.force, auto=True)
    if args.cmd == "rollback":
        return rollback(cfg, args.backup)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
