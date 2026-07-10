#!/usr/bin/env python3
"""NOVA Factory acceptance matrix runner."""
from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(name: str, argv: list[str], timeout: int = 180) -> dict:
    try:
        cp = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return {"name": name, "ok": cp.returncode == 0, "returncode": cp.returncode, "stdout": cp.stdout[-4000:], "stderr": cp.stderr[-4000:]}
    except Exception as exc:
        return {"name": name, "ok": False, "returncode": 127, "stdout": "", "stderr": str(exc)}


def acceptance(root: Path) -> dict:
    root = root.resolve()
    checks = []
    checks.append(run("bash-syntax", ["bash", "-c", f"cd {str(root)!r} && find . -type f -name '*.sh' -print0 | xargs -0 -r -n1 bash -n"], 180))
    checks.append(run("python-syntax", ["python3", "-c", "import ast,pathlib,sys; root=pathlib.Path(sys.argv[1]); [ast.parse(p.read_text(encoding='utf-8'), filename=str(p)) for p in root.rglob('*.py')]", str(root)], 180))
    pkg = root / "lib" / "scripts" / "package-validate.sh"
    if pkg.exists():
        checks.append(run("package-validate", [str(pkg), str(root)], 240))
    rel = root / "lib" / "nova-release.py"
    if rel.exists():
        checks.append(run("release-validate", [str(rel), "validate", "--path", str(root)], 240))
    tests = root / "tests"
    if tests.exists():
        checks.append(run("unit-tests", ["bash", "-c", f"PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s {str(tests)!r}"], 240))
    required = [
        "lib/nova-admin.py", "lib/nova-updater.py", "lib/nova-release.py", "lib/nova-ci.py",
        "lib/nova-acceptance.py", "lib/nova-system.py", "lib/nova-runtime-certify.py",
        "lib/nova-lease.py", "lib/nova-job-queue.py", "lib/nova-dispatcher.py",
        "lib/nova-github-actions-worker.py", "lib/nova-branch-policy.py", "lib/nova-release-train.py", "lib/nova-emergency.py", "lib/nova-roadmap.py", "lib/nova-orchestrator.py", "lib/nova-state.py",
        "repo-overlay/nova-bot.py", "systemd/nova-bot.service", "systemd/nova-orchestrator.timer",
    ]
    missing = [x for x in required if not (root / x).exists()]
    checks.append({"name": "required-files", "ok": not missing, "returncode": 0 if not missing else 2, "stdout": json.dumps({"missing": missing}), "stderr": ""})
    ok = all(c["ok"] for c in checks)
    return {"generated_at": utc(), "path": str(root), "ok": ok, "checks": checks}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA acceptance matrix")
    parser.add_argument("--path", default=".")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    data = acceptance(Path(args.path))
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        for c in data["checks"]:
            print(f"{'OK' if c['ok'] else 'FAIL'} {c['name']} rc={c['returncode']}")
        print("OK: acceptance passed" if data["ok"] else "FAIL: acceptance failed")
    return 0 if data["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
