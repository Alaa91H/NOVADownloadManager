#!/usr/bin/env python3
"""Emergency process watchdog fallback.

The primary watchdog is systemd-based (`/usr/local/lib/nova/scripts/watchdog.sh`).
This file remains in the repository overlay only as a conservative fallback for
manual use. It is environment-driven and avoids shell=True.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(os.environ.get("NOVA_PROJECT_DIR", Path.home() / "NOVA")).resolve()
LOG_DIR = Path(os.environ.get("NOVA_LOG_DIR", "/var/log/nova")).resolve()
BACKUP_SOURCE = Path(os.environ.get("NOVA_BACKUP_SOURCE", str(PROJECT_DIR))).resolve()
BACKUP_DEST = Path(os.environ.get("NOVA_BACKUP_DEST", "/mnt/nova_backup/S")).resolve()
CHECK_INTERVAL = int(os.environ.get("NOVA_FALLBACK_WATCHDOG_INTERVAL", "60"))

SERVICES = {
    "nova-bot": ["python3", str(PROJECT_DIR / "nova-bot.py")],
    "nova-agent": ["/usr/local/lib/nova/agent.sh"],
}

LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    filename=str(LOG_DIR / "nova-watchdog-fallback.log"),
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)


def is_process_running(cmd_part: str) -> bool:
    try:
        output = subprocess.check_output(["ps", "aux"], text=True)
        return cmd_part in output
    except Exception:
        return False


def check_services() -> None:
    for name, argv in SERVICES.items():
        signature = " ".join(argv)
        if is_process_running(signature):
            continue
        logging.warning("Service %s (%s) is not running. Restarting...", name, signature)
        try:
            log_file = LOG_DIR / f"{name}.fallback.log"
            with log_file.open("ab") as fh:
                subprocess.Popen(argv, cwd=str(PROJECT_DIR), stdout=fh, stderr=subprocess.STDOUT)
            logging.info("Service %s restarted.", name)
        except Exception as exc:
            logging.error("Failed to restart %s: %s", name, exc)


def maybe_backup() -> None:
    if datetime.now().minute != 0:
        return
    try:
        BACKUP_DEST.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "rsync",
                "-az",
                "--exclude",
                "node_modules",
                "--exclude",
                ".git",
                f"{BACKUP_SOURCE}/",
                str(BACKUP_DEST),
            ],
            check=True,
            timeout=600,
        )
        logging.info("Automated backup completed.")
    except Exception as exc:
        logging.error("Automated backup failed: %s", exc)


if __name__ == "__main__":
    logging.info("Fallback watchdog started.")
    check_services()
    while True:
        check_services()
        maybe_backup()
        time.sleep(CHECK_INTERVAL)
