#!/usr/bin/env python3
"""NOVA GitHub Actions worker bootstrap/dispatcher.

This tool lets the weak production server remain a control plane. It can
provision the GitHub Actions workflow file into the managed repository when it
is missing, then dispatch a workflow_dispatch run for queued NOVA jobs.

No build/lint/test work is executed on the server by this tool.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

RETRYABLE = 75
BRANCH_POLICY = Path(os.environ.get("NOVA_BRANCH_POLICY_BIN", "/usr/local/lib/nova/nova-branch-policy.py"))


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def env_bool(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def cfg() -> dict:
    repo = os.environ.get("NOVA_GITHUB_REPO") or os.environ.get("NOVA_GH_REPO", "").strip()
    workflow = os.environ.get("NOVA_GITHUB_WORKER_WORKFLOW", "nova-worker.yml").strip()
    base = os.environ.get("NOVA_GITHUB_WORKER_BASE_BRANCH") or os.environ.get("NOVA_DEVELOP_BRANCH") or os.environ.get("NOVA_BRANCH", "develop")
    provision = os.environ.get("NOVA_GITHUB_WORKER_AUTO_PROVISION", "1").strip().lower()
    mode = os.environ.get("NOVA_GITHUB_WORKER_PROVISION_MODE", "pr").strip().lower()
    branch = os.environ.get("NOVA_GITHUB_WORKER_BRANCH", "nova/bootstrap-github-worker").strip()
    return {
        "repo": repo,
        "workflow": workflow,
        "base_branch": base,
        "auto_provision": provision in {"1", "true", "yes", "on"},
        "provision_mode": mode if mode in {"pr", "commit", "none"} else "pr",
        "provision_branch": branch,
        "branch_policy": branch_cfg(),
        "force_update": env_bool("NOVA_GITHUB_WORKER_FORCE_UPDATE", "0"),
        "create_pr": env_bool("NOVA_GITHUB_WORKER_CREATE_PR", "1"),
    }


def run(argv: list[str], *, cwd: str | Path | None = None, timeout: int = 120, check: bool = False) -> subprocess.CompletedProcess[str]:
    cp = subprocess.run(argv, cwd=str(cwd) if cwd else None, text=True, capture_output=True, timeout=timeout)
    if check and cp.returncode != 0:
        raise RuntimeError(f"command failed rc={cp.returncode}: {' '.join(argv)}\n{cp.stderr or cp.stdout}")
    return cp


def require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise SystemExit(f"required tool not found: {name}")
    return path


def workflow_path(workflow: str) -> str:
    name = Path(workflow).name
    if not name.endswith((".yml", ".yaml")):
        name += ".yml"
    return f".github/workflows/{name}"



def branch_cfg() -> dict:
    stable = os.environ.get("NOVA_STABLE_BRANCH", "main").strip() or "main"
    develop = os.environ.get("NOVA_DEVELOP_BRANCH") or os.environ.get("NOVA_BRANCH", "develop")
    develop = develop.strip() or "develop"
    legacy = os.environ.get("NOVA_LEGACY_DEVELOP_BRANCH", "Dev").strip()
    include_legacy = os.environ.get("NOVA_BRANCH_POLICY_INCLUDE_LEGACY_DEV", "1").strip().lower() in {"1", "true", "yes", "on"}
    branches = []
    for br in [stable, develop, legacy if include_legacy else ""]:
        if br and br not in branches:
            branches.append(br)
    return {"stable": stable, "develop": develop, "legacy": legacy if include_legacy else "", "branches": branches}


def branch_lines(indent: int = 6) -> str:
    pad = " " * indent
    return "\n".join(f"{pad}- {br}" for br in branch_cfg()["branches"])


def branch_policy(*args: str, timeout: int = 120) -> dict:
    if not BRANCH_POLICY.exists():
        return {"ok": False, "status": "missing-branch-policy"}
    cp = run([str(BRANCH_POLICY), *args], timeout=timeout)
    try:
        data = json.loads(cp.stdout or "{}")
    except Exception:
        data = {"ok": cp.returncode == 0, "stdout": cp.stdout.strip(), "stderr": cp.stderr.strip()}
    data.setdefault("ok", cp.returncode == 0)
    data.setdefault("returncode", cp.returncode)
    return data


def target_for_mode(mode: str) -> str:
    if BRANCH_POLICY.exists():
        cp = run([str(BRANCH_POLICY), "target-for", mode or "develop"], timeout=30)
        if cp.returncode == 0 and cp.stdout.strip():
            return cp.stdout.strip()
    return branch_cfg()["develop"]


def safe_target_branch(branch: str, mode: str) -> str:
    candidate = (branch or "").strip() or target_for_mode(mode)
    if BRANCH_POLICY.exists():
        data = branch_policy("validate-branch", candidate, timeout=30)
        if data.get("ok"):
            return candidate
        return target_for_mode(mode)
    return candidate

def workflow_exists(repo: str, workflow: str, ref: str) -> bool:
    path = workflow_path(workflow)
    cp = run(["gh", "api", f"repos/{repo}/contents/{path}", "-f", f"ref={ref}"], timeout=60)
    return cp.returncode == 0


def render_workflow() -> str:
    node_version = os.environ.get("NOVA_GITHUB_WORKER_NODE_VERSION", "22")
    return f"""name: Nova Worker

on:
  workflow_dispatch:
    inputs:
      job_id:
        description: "NOVA job id"
        required: false
        type: string
      task:
        description: "Task description from NOVA"
        required: true
        type: string
      mode:
        description: "Worker mode"
        required: true
        default: "analyze"
        type: choice
        options:
          - analyze
          - fix
          - develop
          - improve
          - ci-repair
          - release-check
      target_branch:
        description: "Target branch"
        required: true
        default: "{branch_cfg()["develop"]}"
        type: string

  pull_request:
    branches:
{branch_lines(6)}

  push:
    branches:
{branch_lines(6)}

concurrency:
  group: nova-worker-${{{{ github.workflow }}}}-${{{{ github.ref }}}}
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write
  actions: read
  checks: read

jobs:
  validate:
    name: Validate repository
    runs-on: ubuntu-latest
    timeout-minutes: 90

    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: ${{{{ inputs.target_branch || github.ref }}}}

      - name: Setup Node.js when package.json exists
        if: hashFiles('package.json') != ''
        uses: actions/setup-node@v4
        with:
          node-version: "{node_version}"

      - name: Enable Corepack
        if: hashFiles('package.json') != ''
        run: corepack enable

      - name: Install dependencies
        if: hashFiles('package.json') != ''
        run: |
          if [ -f pnpm-lock.yaml ]; then
            pnpm install --frozen-lockfile
          elif [ -f package-lock.json ]; then
            npm ci
          elif [ -f yarn.lock ]; then
            yarn install --immutable || yarn install --frozen-lockfile
          else
            npm install
          fi

      - name: Typecheck/lint/test/build when available
        if: hashFiles('package.json') != ''
        run: |
          run_script() {{
            name="$1"
            if node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts[process.argv[1]] ? 0 : 1)" "$name"; then
              if [ -f pnpm-lock.yaml ]; then
                pnpm "$name"
              elif [ -f yarn.lock ]; then
                yarn "$name"
              else
                npm run "$name"
              fi
            else
              echo "No $name script"
            fi
          }}
          run_script typecheck
          run_script lint
          run_script test
          run_script build

      - name: Repository static summary
        if: always()
        run: |
          mkdir -p nova-worker-report
          git status --short > nova-worker-report/git-status.txt || true
          git log --oneline -n 20 > nova-worker-report/recent-commits.txt || true
          find . -maxdepth 3 -type f \
            -not -path './.git/*' \
            -not -path './node_modules/*' \
            | sort | head -500 > nova-worker-report/file-inventory.txt

      - name: Write NOVA worker report
        if: always()
        run: |
          {{
            echo "# Nova Worker Report"
            echo
            echo "- Job ID: ${{{{ inputs.job_id || 'manual' }}}}"
            echo "- Mode: ${{{{ inputs.mode || 'ci' }}}}"
            echo "- Task: ${{{{ inputs.task || 'push/pull_request validation' }}}}"
            echo "- Branch: ${{{{ inputs.target_branch || github.ref_name }}}}"
            echo "- Commit: ${{{{ github.sha }}}}"
            echo "- Run: ${{{{ github.server_url }}}}/${{{{ github.repository }}}}/actions/runs/${{{{ github.run_id }}}}"
          }} > nova-worker-report/report.md

      - name: Upload NOVA worker report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: nova-worker-report
          path: nova-worker-report/
"""


def status() -> dict:
    c = cfg()
    gh = shutil.which("gh")
    exists = False
    error = ""
    if gh and c["repo"]:
        try:
            exists = workflow_exists(c["repo"], c["workflow"], c["base_branch"])
        except Exception as exc:
            error = str(exc)
    return {
        "generated_at": utc(),
        "repo": c["repo"],
        "workflow": c["workflow"],
        "workflow_path": workflow_path(c["workflow"]),
        "base_branch": c["base_branch"],
        "gh_available": bool(gh),
        "workflow_exists": exists,
        "auto_provision": c["auto_provision"],
        "provision_mode": c["provision_mode"],
        "provision_branch": c["provision_branch"],
        "branch_policy": c.get("branch_policy", branch_cfg()),
        "error": error,
    }


def clone_repo(repo: str, base: str, workdir: Path) -> Path:
    require_tool("gh")
    cp = run(["gh", "repo", "clone", repo, str(workdir), "--", "--no-tags"], timeout=180)
    if cp.returncode != 0:
        raise RuntimeError(cp.stderr or cp.stdout or "gh repo clone failed")
    run(["git", "fetch", "origin", base], cwd=workdir, timeout=120)
    cp = run(["git", "checkout", "-B", base, f"origin/{base}"], cwd=workdir, timeout=60)
    if cp.returncode != 0:
        # Some repositories use a different default branch; fall back to current default.
        run(["git", "checkout", base], cwd=workdir, timeout=60, check=False)
    return workdir


def ensure_workflow() -> dict:
    c = cfg()
    if not c["repo"]:
        return {"ok": False, "status": "missing-repo", "detail": "set NOVA_GITHUB_REPO or NOVA_GH_REPO"}
    require_tool("gh")
    require_tool("git")
    branch_policy_result = {"ok": True, "status": "not-run"}
    if os.environ.get("NOVA_BRANCH_POLICY_AUTOPROVISION", "1").strip().lower() in {"1", "true", "yes", "on"}:
        branch_policy_result = branch_policy("ensure", timeout=180)
    exists = workflow_exists(c["repo"], c["workflow"], c["base_branch"])
    if exists and not c["force_update"]:
        return {"ok": True, "status": "exists", "workflow": c["workflow"], "repo": c["repo"], "branch_policy": branch_policy_result}
    if not c["auto_provision"] or c["provision_mode"] == "none":
        return {"ok": False, "status": "missing-disabled", "detail": "workflow missing and auto-provision is disabled"}

    with tempfile.TemporaryDirectory(prefix="nova-gh-worker-") as td:
        repo_dir = clone_repo(c["repo"], c["base_branch"], Path(td) / "repo")
        target_file = repo_dir / workflow_path(c["workflow"])
        target_file.parent.mkdir(parents=True, exist_ok=True)
        old = target_file.read_text(encoding="utf-8") if target_file.exists() else ""
        new = render_workflow()
        if old == new and exists:
            return {"ok": True, "status": "exists-current", "workflow": c["workflow"], "repo": c["repo"]}
        target_file.write_text(new, encoding="utf-8")
        run(["git", "config", "user.name", os.environ.get("NOVA_GIT_AUTHOR_NAME", "nova-factory")], cwd=repo_dir, timeout=20)
        run(["git", "config", "user.email", os.environ.get("NOVA_GIT_AUTHOR_EMAIL", "nova-factory@users.noreply.github.com")], cwd=repo_dir, timeout=20)
        cp = run(["git", "status", "--porcelain", "--", workflow_path(c["workflow"])], cwd=repo_dir, timeout=20)
        if not cp.stdout.strip():
            return {"ok": True, "status": "no-change", "workflow": c["workflow"], "repo": c["repo"]}
        if c["provision_mode"] == "commit":
            run(["git", "add", workflow_path(c["workflow"])], cwd=repo_dir, timeout=20, check=True)
            run(["git", "commit", "-m", "ci: provision nova worker workflow"], cwd=repo_dir, timeout=60, check=True)
            run(["git", "push", "origin", f"HEAD:{c['base_branch']}"], cwd=repo_dir, timeout=180, check=True)
            return {"ok": True, "status": "committed", "repo": c["repo"], "workflow": c["workflow"], "branch": c["base_branch"]}

        branch = c["provision_branch"]
        run(["git", "checkout", "-B", branch], cwd=repo_dir, timeout=30, check=True)
        run(["git", "add", workflow_path(c["workflow"])], cwd=repo_dir, timeout=20, check=True)
        run(["git", "commit", "-m", "ci: provision nova worker workflow"], cwd=repo_dir, timeout=60, check=True)
        run(["git", "push", "-u", "origin", f"HEAD:{branch}", "--force-with-lease"], cwd=repo_dir, timeout=180, check=True)
        pr_url = ""
        if c["create_pr"]:
            pr = run([
                "gh", "pr", "create",
                "--repo", c["repo"],
                "--base", c["base_branch"],
                "--head", branch,
                "--title", "ci: provision NOVA worker workflow",
                "--body", "Adds the GitHub Actions workflow used by NOVA as a remote worker. Generated by nova-github-actions-worker.py.",
            ], cwd=repo_dir, timeout=120)
            if pr.returncode == 0:
                pr_url = pr.stdout.strip()
            else:
                # Existing PR is fine; keep the branch updated.
                pr_url = (pr.stderr or pr.stdout).strip()[:1000]
        return {"ok": True, "status": "pr-opened", "repo": c["repo"], "workflow": c["workflow"], "branch": branch, "pr": pr_url, "dispatchable": False}


def job_from_file(path: str | None) -> dict:
    if not path:
        return {}
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"invalid job json: {exc}")


def dispatch(args) -> dict:
    c = cfg()
    if not c["repo"]:
        return {"ok": False, "status": "missing-repo", "detail": "set NOVA_GITHUB_REPO or NOVA_GH_REPO"}
    ensure = ensure_workflow()
    if not ensure.get("ok"):
        return {"ok": False, "status": "workflow-unavailable", "ensure": ensure}
    if ensure.get("status") == "pr-opened" and not ensure.get("dispatchable", False):
        return {"ok": False, "retryable": True, "status": "workflow-pr-pending", "ensure": ensure, "detail": "merge the provisioning PR or set NOVA_GITHUB_WORKER_PROVISION_MODE=commit"}

    job = job_from_file(args.job_json)
    job_id = str(job.get("id") or args.job_id or "manual")
    title = str(job.get("title") or args.task or "Analyze repository and report issues")
    kind = str(job.get("kind") or args.mode or "analyze")
    payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
    mode = str(payload.get("mode") or kind)
    if mode == "release":
        mode = "release-check"
    allowed_modes = {"analyze", "fix", "develop", "improve", "ci-repair", "release-check"}
    if mode not in allowed_modes:
        mode = "analyze"
    branch = str(payload.get("target_branch") or args.target_branch or "")
    release_channel = str(job.get("release_channel") or payload.get("release_channel") or "")
    if branch in {"alpha", "beta", "stable"}:
        release_channel = branch
        branch = ""
    branch = safe_target_branch(branch, "release-check" if release_channel == "stable" else mode)

    cp = run([
        "gh", "workflow", "run", c["workflow"],
        "--repo", c["repo"],
        "--ref", branch,
        "-f", f"job_id={job_id}",
        "-f", f"task={title}",
        "-f", f"mode={mode}",
        "-f", f"target_branch={branch}",
    ], timeout=90)
    ok = cp.returncode == 0
    return {
        "ok": ok,
        "status": "dispatched" if ok else "dispatch-failed",
        "repo": c["repo"],
        "workflow": c["workflow"],
        "job_id": job_id,
        "mode": mode,
        "target_branch": branch,
        "stdout": cp.stdout.strip(),
        "stderr": cp.stderr.strip(),
        "retryable": not ok,
    }


def print_json(data: dict) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA GitHub Actions worker bootstrap/dispatcher")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("render-workflow")
    sub.add_parser("ensure-workflow")
    dp = sub.add_parser("dispatch")
    dp.add_argument("job_json", nargs="?")
    dp.add_argument("--job-id", default="")
    dp.add_argument("--task", default="Analyze repository and report issues")
    dp.add_argument("--mode", default="analyze")
    dp.add_argument("--target-branch", default="")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "status":
            return print_json(status())
        if args.cmd == "render-workflow":
            print(render_workflow())
            return 0
        if args.cmd == "ensure-workflow":
            data = ensure_workflow(); print_json(data); return 0 if data.get("ok") else 1
        if args.cmd == "dispatch":
            data = dispatch(args); print_json(data)
            if data.get("ok"):
                return 0
            return RETRYABLE if data.get("retryable") else 1
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({"ok": False, "status": "error", "error": str(exc)}, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
