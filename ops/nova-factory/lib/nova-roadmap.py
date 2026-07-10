#!/usr/bin/env python3
"""NOVA evidence-based roadmap and idea scoring."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

QUEUE = Path(os.environ.get("NOVA_QUEUE_BIN", "/usr/local/lib/nova/nova-job-queue.py"))
PROJECT_DIR = Path(os.environ.get("NOVA_PROJECT_DIR", os.getcwd()))


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(argv: list[str], cwd: Path | None = None, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=str(cwd or PROJECT_DIR), text=True, capture_output=True, timeout=timeout)


def has(path: str) -> bool:
    return (PROJECT_DIR / path).exists()


def count(pattern: str) -> int:
    return len(list(PROJECT_DIR.rglob(pattern))) if PROJECT_DIR.exists() else 0


def git_status() -> dict:
    cp = run(["git", "status", "--porcelain"], timeout=30)
    return {"available": cp.returncode == 0, "dirty_paths": len([l for l in cp.stdout.splitlines() if l.strip()])}


def discover() -> list[dict]:
    ideas = []
    files_ts = count("*.ts") + count("*.tsx")
    files_py = count("*.py")
    tests = count("*.test.ts") + count("*.spec.ts") + count("test_*.py")
    docs = ["README.md", "ARCHITECTURE.md", "SECURITY.md", "RELEASE.md", "CONTRIBUTING.md"]
    missing_docs = [d for d in docs if not has(d)]

    if missing_docs:
        ideas.append({"kind": "improve", "priority": "P2", "title": "Complete missing operational documentation", "evidence": f"missing: {', '.join(missing_docs)}", "impact": 55})
    if files_ts and tests < max(3, files_ts // 8):
        ideas.append({"kind": "improve", "priority": "P1", "title": "Increase test coverage for high-value TypeScript paths", "evidence": f"ts_files={files_ts}, tests={tests}", "impact": 72})
    if has("package.json") and not has(".github/workflows"):
        ideas.append({"kind": "fix", "priority": "P1", "title": "Add GitHub Actions gate for package validation", "evidence": "package.json exists without .github/workflows", "impact": 80})
    if has("Plan.md"):
        text = (PROJECT_DIR / "Plan.md").read_text(encoding="utf-8", errors="replace")[:200_000]
        blocked = text.count("BLOCKED")
        if blocked:
            ideas.append({"kind": "fix", "priority": "P1", "title": "Resolve blocked roadmap items", "evidence": f"blocked_items={blocked}", "impact": 76})
        if "P0" in text:
            ideas.append({"kind": "fix", "priority": "P0", "title": "Prioritize outstanding P0 roadmap work", "evidence": "Plan.md contains P0 markers", "impact": 95})
    if files_py and not has("pyproject.toml") and not has("requirements.txt"):
        ideas.append({"kind": "improve", "priority": "P3", "title": "Formalize Python tooling metadata", "evidence": f"python_files={files_py} without pyproject/requirements", "impact": 42})
    status = git_status()
    if status.get("dirty_paths", 0) > 20:
        ideas.append({"kind": "fix", "priority": "P1", "title": "Reduce accumulated uncommitted change surface", "evidence": f"dirty_paths={status['dirty_paths']}", "impact": 68})

    for idea in ideas:
        idea.setdefault("acceptance", "Task is recorded in Plan.md with objective validation gate and linked CI evidence.")
        idea.setdefault("validation", "GitHub Actions / relevant project CI")
        idea["score"] = idea["impact"] + {"P0": 30, "P1": 20, "P2": 10, "P3": 0}.get(idea["priority"], 0)
    ideas.sort(key=lambda x: x["score"], reverse=True)
    return ideas


def enqueue(limit: int) -> dict:
    ideas = discover()[:limit]
    created = []
    for idea in ideas:
        if not QUEUE.exists():
            created.append({"ok": False, "idea": idea, "error": "queue not installed"})
            continue
        cp = run([
            str(QUEUE), "enqueue", "--kind", idea["kind"], "--priority", idea["priority"], "--source", "roadmap",
            "--title", idea["title"], "--description", idea["evidence"], "--acceptance", idea["acceptance"], "--validation", idea["validation"],
            "--payload", json.dumps(idea, ensure_ascii=False),
        ], timeout=60)
        try:
            created.append(json.loads(cp.stdout or "{}"))
        except Exception:
            created.append({"ok": cp.returncode == 0, "stdout": cp.stdout, "stderr": cp.stderr})
    return {"generated_at": utc(), "created": created}


def print_json(data) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="NOVA roadmap scorer")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("ideas")
    sp.add_argument("--limit", type=int, default=20)
    sp = sub.add_parser("enqueue")
    sp.add_argument("--limit", type=int, default=5)
    args = p.parse_args(argv)
    if args.cmd == "ideas":
        return print_json({"generated_at": utc(), "project_dir": str(PROJECT_DIR), "ideas": discover()[: args.limit]})
    if args.cmd == "enqueue":
        return print_json(enqueue(args.limit))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
