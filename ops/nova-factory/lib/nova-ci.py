#!/usr/bin/env python3
"""Read-only GitHub CI status helper for NOVA Factory."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ENV_FILE = Path(os.environ.get("NOVA_ENV_FILE", "/etc/nova/nova.env"))
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_env(path: Path = ENV_FILE) -> dict[str, str]:
    env = {}
    if path.exists():
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
        "repo": env.get("NOVA_GH_REPO", "Alaa91H/NOVADownloadManager"),
        "branch": env.get("NOVA_BRANCH") or env.get("NOVA_DEVELOP_BRANCH", "develop"),
        "project_dir": env.get("NOVA_PROJECT_DIR", "/home/ubuntu/NOVA"),
    }


def run_gh(args: list[str], timeout: int = 45) -> tuple[int, str, str]:
    try:
        cp = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)
        return cp.returncode, cp.stdout.strip(), cp.stderr.strip()
    except FileNotFoundError:
        return 127, "", "GitHub CLI (gh) is not installed"
    except Exception as exc:
        return 127, "", str(exc)


def base_check() -> tuple[dict, list[str]]:
    c = cfg()
    errors = []
    if not REPO_RE.fullmatch(c["repo"]):
        errors.append("NOVA_GH_REPO must be owner/name")
    return c, errors


def status(limit: int) -> dict:
    c, errors = base_check()
    if errors:
        return {"generated_at": utc(), "ok": False, "errors": errors}
    rc, out, err = run_gh(["run", "list", "--repo", c["repo"], "--branch", c["branch"], "--limit", str(limit), "--json", "databaseId,status,conclusion,displayTitle,createdAt,event,headSha"])
    runs = []
    if rc == 0 and out:
        try:
            runs = json.loads(out)
        except Exception as exc:
            errors.append(f"failed to parse gh output: {exc}")
    elif rc != 0:
        errors.append(err or out or f"gh exited {rc}")
    return {"generated_at": utc(), "ok": rc == 0 and not errors, "repo": c["repo"], "branch": c["branch"], "runs": runs, "errors": errors}


def failed(limit: int) -> dict:
    data = status(limit)
    runs = data.get("runs", [])
    data["failed_runs"] = [r for r in runs if str(r.get("conclusion", "")).lower() in {"failure", "cancelled", "timed_out", "action_required"}]
    return data


def prs(limit: int) -> dict:
    c, errors = base_check()
    if errors:
        return {"generated_at": utc(), "ok": False, "errors": errors}
    rc, out, err = run_gh(["pr", "list", "--repo", c["repo"], "--limit", str(limit), "--json", "number,title,state,isDraft,author,headRefName,baseRefName,updatedAt"])
    prs_data = []
    if rc == 0 and out:
        try:
            prs_data = json.loads(out)
        except Exception as exc:
            errors.append(f"failed to parse gh output: {exc}")
    elif rc != 0:
        errors.append(err or out or f"gh exited {rc}")
    return {"generated_at": utc(), "ok": rc == 0 and not errors, "repo": c["repo"], "pull_requests": prs_data, "errors": errors}


def release(limit: int) -> dict:
    c, errors = base_check()
    if errors:
        return {"generated_at": utc(), "ok": False, "errors": errors}
    rc, out, err = run_gh(["release", "list", "--repo", c["repo"], "--limit", str(limit), "--json", "name,tagName,isDraft,isPrerelease,createdAt,publishedAt"])
    releases = []
    if rc == 0 and out:
        try:
            releases = json.loads(out)
        except Exception as exc:
            errors.append(f"failed to parse gh output: {exc}")
    elif rc != 0:
        errors.append(err or out or f"gh exited {rc}")
    return {"generated_at": utc(), "ok": rc == 0 and not errors, "repo": c["repo"], "releases": releases, "errors": errors}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA read-only GitHub CI helper")
    parser.add_argument("cmd", choices=["status", "failed", "prs", "release"])
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args(argv)
    limit = max(1, min(args.limit, 50))
    if args.cmd == "status":
        data = status(limit)
    elif args.cmd == "failed":
        data = failed(limit)
    elif args.cmd == "prs":
        data = prs(limit)
    elif args.cmd == "release":
        data = release(limit)
    else:
        return 2
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0 if data.get("ok", True) else 2


if __name__ == "__main__":
    raise SystemExit(main())
