#!/usr/bin/env python3
"""NOVA repository branch policy manager.

Adopts the production branching model for the managed repository:
  main      -> stable only
  develop   -> continuous integration/development target
  agent/*   -> autonomous worker task branches
  feature/* -> human feature branches
  fix/*     -> scoped fix branches
  release/* -> beta/stable preparation branches
  hotfix/*  -> urgent stable fixes

The weak server remains a control plane. This tool validates branch decisions,
creates the develop branch when needed, and optionally applies GitHub branch
protection through gh when the token has sufficient rights.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

RETRYABLE = 75


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def env_bool(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def split_list(value: str) -> list[str]:
    return [x.strip() for x in re.split(r"[\s,]+", value or "") if x.strip()]


def cfg() -> dict:
    stable = os.environ.get("NOVA_STABLE_BRANCH", "main").strip() or "main"
    develop = os.environ.get("NOVA_DEVELOP_BRANCH") or os.environ.get("NOVA_BRANCH", "develop")
    develop = develop.strip() or "develop"
    legacy = os.environ.get("NOVA_LEGACY_DEVELOP_BRANCH", "Dev").strip()
    return {
        "repo": (os.environ.get("NOVA_GITHUB_REPO") or os.environ.get("NOVA_GH_REPO", "")).strip(),
        "stable_branch": stable,
        "develop_branch": develop,
        "legacy_develop_branch": legacy,
        "agent_prefix": os.environ.get("NOVA_AGENT_BRANCH_PREFIX", "agent").strip().strip("/") or "agent",
        "feature_prefix": os.environ.get("NOVA_FEATURE_BRANCH_PREFIX", "feature").strip().strip("/") or "feature",
        "fix_prefix": os.environ.get("NOVA_FIX_BRANCH_PREFIX", "fix").strip().strip("/") or "fix",
        "release_prefix": os.environ.get("NOVA_RELEASE_BRANCH_PREFIX", "release").strip().strip("/") or "release",
        "hotfix_prefix": os.environ.get("NOVA_HOTFIX_BRANCH_PREFIX", "hotfix").strip().strip("/") or "hotfix",
        "allow_direct_main": env_bool("NOVA_BRANCH_POLICY_ALLOW_DIRECT_MAIN", "0"),
        "allow_direct_develop": env_bool("NOVA_BRANCH_POLICY_ALLOW_DIRECT_DEVELOP", "0"),
        "create_develop": env_bool("NOVA_BRANCH_POLICY_CREATE_DEVELOP", "1"),
        "apply_protection": env_bool("NOVA_BRANCH_POLICY_APPLY_PROTECTION", "0"),
        "prefer_pr": env_bool("NOVA_BRANCH_POLICY_PREFER_PR", "1"),
        "enforce": env_bool("NOVA_BRANCH_POLICY_ENFORCE", "1"),
        "include_legacy_dev": env_bool("NOVA_BRANCH_POLICY_INCLUDE_LEGACY_DEV", "1"),
        "extra_allowed": split_list(os.environ.get("NOVA_BRANCH_POLICY_EXTRA_ALLOWED", "")),
    }


def run(argv: list[str], *, cwd: str | Path | None = None, timeout: int = 120, check: bool = False) -> subprocess.CompletedProcess[str]:
    cp = subprocess.run(argv, cwd=str(cwd) if cwd else None, text=True, capture_output=True, timeout=timeout)
    if check and cp.returncode != 0:
        raise RuntimeError(f"command failed rc={cp.returncode}: {' '.join(argv)}\n{cp.stderr or cp.stdout}")
    return cp


def gh_available() -> bool:
    return bool(shutil.which("gh"))


def git_available() -> bool:
    return bool(shutil.which("git"))


def branch_ref(repo: str, branch: str) -> dict | None:
    if not repo or not gh_available():
        return None
    cp = run(["gh", "api", f"repos/{repo}/git/ref/heads/{branch}"], timeout=60)
    if cp.returncode != 0:
        return None
    try:
        return json.loads(cp.stdout or "{}")
    except Exception:
        return None


def branch_exists(repo: str, branch: str) -> bool:
    return branch_ref(repo, branch) is not None


def protected_status(repo: str, branch: str) -> dict:
    if not repo or not gh_available():
        return {"checked": False, "protected": False, "reason": "gh unavailable or repo missing"}
    cp = run(["gh", "api", f"repos/{repo}/branches/{branch}/protection"], timeout=60)
    if cp.returncode == 0:
        return {"checked": True, "protected": True}
    return {"checked": True, "protected": False, "reason": (cp.stderr or cp.stdout).strip()[:500]}


def allowed_prefixes(c: dict) -> list[str]:
    return [c["agent_prefix"], c["feature_prefix"], c["fix_prefix"], c["release_prefix"], c["hotfix_prefix"]]


def branch_kind(branch: str, c: dict | None = None) -> str:
    c = c or cfg()
    branch = (branch or "").strip()
    if not branch:
        return "empty"
    if branch == c["stable_branch"]:
        return "stable"
    if branch == c["develop_branch"]:
        return "develop"
    if c["include_legacy_dev"] and c["legacy_develop_branch"] and branch == c["legacy_develop_branch"]:
        return "legacy-develop"
    for key, kind in [
        ("agent_prefix", "agent"),
        ("feature_prefix", "feature"),
        ("fix_prefix", "fix"),
        ("release_prefix", "release"),
        ("hotfix_prefix", "hotfix"),
    ]:
        prefix = c[key]
        if branch.startswith(prefix + "/") and len(branch) > len(prefix) + 1:
            return kind
    if branch in set(c["extra_allowed"]):
        return "extra-allowed"
    return "unknown"


def validate_branch_name(branch: str, c: dict | None = None) -> dict:
    c = c or cfg()
    kind = branch_kind(branch, c)
    ok = kind not in {"empty", "unknown"}
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", branch or ""):
        ok = False
        reason = "branch contains unsafe characters"
    elif ".." in branch or branch.endswith("/") or branch.startswith("/") or "//" in branch:
        ok = False
        reason = "branch is not a safe git ref segment"
    elif kind == "unknown":
        reason = "branch does not match the adopted NOVA branch policy"
    elif kind == "empty":
        reason = "branch is empty"
    else:
        reason = "allowed"
    return {"ok": ok, "branch": branch, "kind": kind, "reason": reason}


def target_for(kind: str, channel: str = "", c: dict | None = None) -> str:
    c = c or cfg()
    kind = (kind or "").strip().lower()
    channel = (channel or "").strip().lower()
    if kind in {"hotfix", "stable-fix"}:
        return c["stable_branch"]
    if kind in {"release", "release-check"} and channel == "stable":
        return c["stable_branch"]
    return c["develop_branch"]


def slug(text: str, max_len: int = 48) -> str:
    raw = (text or "task").lower()
    raw = re.sub(r"[^a-z0-9._-]+", "-", raw)
    raw = re.sub(r"-+", "-", raw).strip("-._")
    return (raw[:max_len].strip("-._") or "task")


def branch_name(job_id: str, kind: str, title: str, c: dict | None = None) -> str:
    c = c or cfg()
    k = (kind or "").lower()
    if k in {"fix", "ci-repair", "bug"}:
        prefix = c["fix_prefix"]
    elif k in {"release", "release-check"}:
        prefix = c["release_prefix"]
    elif k in {"hotfix", "stable-fix"}:
        prefix = c["hotfix_prefix"]
    elif k in {"feature", "develop"}:
        prefix = c["feature_prefix"]
    else:
        prefix = c["agent_prefix"]
    jid = slug(job_id or hashlib.sha1((title or utc()).encode()).hexdigest()[:10], 24)
    return f"{prefix}/{jid}-{slug(title)}"


def guard_push(branch: str, purpose: str = "", c: dict | None = None) -> dict:
    c = c or cfg()
    validation = validate_branch_name(branch, c)
    if not validation["ok"]:
        return {"ok": False, "allowed": False, "branch": branch, "reason": validation["reason"], "kind": validation["kind"]}
    kind = validation["kind"]
    if kind == "stable" and not c["allow_direct_main"]:
        return {"ok": False, "allowed": False, "branch": branch, "kind": kind, "reason": "direct push to stable branch is disabled; use release/* or hotfix/* + PR"}
    if kind in {"develop", "legacy-develop"} and not c["allow_direct_develop"]:
        return {"ok": False, "allowed": False, "branch": branch, "kind": kind, "reason": "direct push to develop branch is disabled; use agent/*, feature/*, or fix/* + PR"}
    return {"ok": True, "allowed": True, "branch": branch, "kind": kind, "reason": "allowed"}


def status() -> dict:
    c = cfg()
    branches = [c["stable_branch"], c["develop_branch"]]
    if c["include_legacy_dev"] and c["legacy_develop_branch"] and c["legacy_develop_branch"] not in branches:
        branches.append(c["legacy_develop_branch"])
    data = {
        "generated_at": utc(),
        "repo": c["repo"],
        "policy": {
            "stable_branch": c["stable_branch"],
            "develop_branch": c["develop_branch"],
            "legacy_develop_branch": c["legacy_develop_branch"] if c["include_legacy_dev"] else "",
            "protected_direct_push": {"main": not c["allow_direct_main"], "develop": not c["allow_direct_develop"]},
            "allowed_prefixes": allowed_prefixes(c),
            "enforce": c["enforce"],
            "prefer_pr": c["prefer_pr"],
        },
        "gh_available": gh_available(),
        "git_available": git_available(),
        "branches": {},
    }
    for br in branches:
        exists = branch_exists(c["repo"], br) if c["repo"] and gh_available() else False
        item = {"exists": exists, "kind": branch_kind(br, c)}
        if exists:
            item["protection"] = protected_status(c["repo"], br)
        data["branches"][br] = item
    return data


def create_branch_from(repo: str, source: str, target: str) -> dict:
    ref = branch_ref(repo, target)
    if ref:
        return {"ok": True, "status": "exists", "branch": target}
    src = branch_ref(repo, source)
    if not src:
        return {"ok": False, "status": "source-missing", "source": source, "target": target}
    sha = src.get("object", {}).get("sha")
    if not sha:
        return {"ok": False, "status": "source-sha-missing", "source": source, "target": target}
    cp = run(["gh", "api", f"repos/{repo}/git/refs", "-X", "POST", "-f", f"ref=refs/heads/{target}", "-f", f"sha={sha}"], timeout=90)
    return {"ok": cp.returncode == 0, "status": "created" if cp.returncode == 0 else "create-failed", "branch": target, "stdout": cp.stdout.strip(), "stderr": cp.stderr.strip()}


def protect_branch(repo: str, branch: str) -> dict:
    body = {
        "required_status_checks": None,
        "enforce_admins": True,
        "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": True},
        "restrictions": None,
        "required_linear_history": True,
        "allow_force_pushes": False,
        "allow_deletions": False,
        "block_creations": False,
        "required_conversation_resolution": True,
        "lock_branch": False,
        "allow_fork_syncing": True,
    }
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, prefix="nova-branch-protection-", suffix=".json") as fh:
        json.dump(body, fh)
        path = fh.name
    try:
        cp = run(["gh", "api", f"repos/{repo}/branches/{branch}/protection", "-X", "PUT", "--input", path], timeout=90)
        return {"ok": cp.returncode == 0, "branch": branch, "status": "protected" if cp.returncode == 0 else "protection-failed", "stdout": cp.stdout.strip(), "stderr": cp.stderr.strip()[:1000]}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def ensure() -> dict:
    c = cfg()
    if not c["repo"]:
        return {"ok": False, "status": "missing-repo", "detail": "set NOVA_GITHUB_REPO or NOVA_GH_REPO"}
    if not gh_available():
        return {"ok": False, "status": "missing-gh", "detail": "install and authenticate GitHub CLI"}
    results: list[dict] = []
    if c["create_develop"]:
        source = c["stable_branch"]
        if c["include_legacy_dev"] and c["legacy_develop_branch"] and branch_exists(c["repo"], c["legacy_develop_branch"]):
            source = c["legacy_develop_branch"]
        results.append(create_branch_from(c["repo"], source, c["develop_branch"]))
    if c["apply_protection"]:
        for br in [c["stable_branch"], c["develop_branch"]]:
            if branch_exists(c["repo"], br):
                results.append(protect_branch(c["repo"], br))
    ok = all(item.get("ok") for item in results) if results else True
    return {"ok": ok, "status": "ensured" if ok else "partial", "repo": c["repo"], "results": results, "policy": status().get("policy", {})}


def print_json(data: dict) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="NOVA branch policy manager")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("ensure")
    vb = sub.add_parser("validate-branch")
    vb.add_argument("branch")
    gp = sub.add_parser("guard-push")
    gp.add_argument("branch")
    gp.add_argument("--purpose", default="")
    tf = sub.add_parser("target-for")
    tf.add_argument("kind", nargs="?", default="develop")
    tf.add_argument("--channel", default="")
    bn = sub.add_parser("branch-name")
    bn.add_argument("--job-id", default="")
    bn.add_argument("--kind", default="agent")
    bn.add_argument("--title", default="task")
    args = p.parse_args(argv)
    c = cfg()
    try:
        if args.cmd == "status":
            return print_json(status())
        if args.cmd == "ensure":
            data = ensure(); print_json(data); return 0 if data.get("ok") else 1
        if args.cmd == "validate-branch":
            data = validate_branch_name(args.branch, c); print_json(data); return 0 if data.get("ok") else 2
        if args.cmd == "guard-push":
            data = guard_push(args.branch, args.purpose, c); print_json(data)
            if data.get("allowed") or not c["enforce"]:
                return 0
            return 2
        if args.cmd == "target-for":
            print(target_for(args.kind, args.channel, c)); return 0
        if args.cmd == "branch-name":
            print(branch_name(args.job_id, args.kind, args.title, c)); return 0
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "status": "error", "error": str(exc)}, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
