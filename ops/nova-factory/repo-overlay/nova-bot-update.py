#!/usr/bin/env python3
"""Compatibility wrapper for older NOVA deployments.

The production update path is /usr/local/lib/nova/nova-admin.py update <action>.
This wrapper keeps old references functional without reintroducing raw git-pull
or unrestricted shell update behavior.
"""
from __future__ import annotations

import subprocess
import sys

ADMIN = "/usr/local/lib/nova/nova-admin.py"


def main(argv: list[str] | None = None) -> int:
    args = list(argv or sys.argv[1:] or ["status"])
    if args[0] not in {"status", "check", "apply", "rollback"}:
        print("usage: nova-bot-update.py [status|check|apply|rollback]", file=sys.stderr)
        return 2
    cp = subprocess.run(["sudo", "-n", ADMIN, "update", *args], text=True)
    return cp.returncode


if __name__ == "__main__":
    raise SystemExit(main())
