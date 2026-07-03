#!/usr/bin/env python3
"""Send a Telegram notification after a successful pushed tag release."""
from __future__ import annotations

import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

TELEGRAM_LIMIT = 3900
DEFAULT_PARSE_MODE = "HTML"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def read_text_file(name: str) -> str:
    path = env(name)
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError as exc:
        print(f"Telegram notification warning: cannot read {name}={path}: {exc}", file=sys.stderr)
        return ""


def truncate_message(message: str) -> str:
    if len(message) <= TELEGRAM_LIMIT:
        return message
    suffix = "\n\n… Open the GitHub Release for the full changelog and downloads."
    budget = TELEGRAM_LIMIT - len(suffix)
    kept: list[str] = []
    used = 0
    for line in message.splitlines():
        next_used = used + len(line) + 1
        if next_used > budget:
            break
        kept.append(line)
        used = next_used
    if not kept:
        return message[:budget] + suffix
    return "\n".join(kept).rstrip() + suffix


def html_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def build_message() -> str:
    prepared = read_text_file("RELEASE_NOTIFICATION_FILE")
    if prepared:
        return truncate_message(prepared)

    tag = env("RELEASE_TAG", "unknown")
    url = env("RELEASE_URL") or env("GITHUB_RUN_URL")
    repository = env("RELEASE_REPOSITORY", env("GITHUB_REPOSITORY", "unknown"))
    actor = env("RELEASE_ACTOR", env("GITHUB_ACTOR", "unknown"))
    version = env("RELEASE_VERSION", "unknown")
    assets = env("RELEASE_ASSET_LINKS")
    changelog = read_text_file("RELEASE_CHANGELOG_FILE")

    parts = [
        "✅ <b>APEX Download Manager Extension</b>",
        "",
        "🚀 <b>tag release published</b>",
        f"🏷 <b>Tag:</b> <code>{html_escape(tag)}</code>",
        f"📦 <b>Repository:</b> <code>{html_escape(repository)}</code>",
        f"👤 <b>Actor:</b> {html_escape(actor)}",
        f'🔗 <a href="{html_escape(url)}">Open GitHub Release</a>' if url else "",
    ]
    if assets:
        parts.extend(["", "⬇️ <b>Downloads:</b>", html_escape(assets)])
    if changelog:
        parts.extend(["", "📝 <b>Change log:</b>", html_escape(changelog)])
    return truncate_message("\n".join(part for part in parts if part))


def main() -> int:
    token = env("TELEGRAM_BOT_TOKEN")
    chat_id = env("TELEGRAM_CHAT_ID")

    if not token or not chat_id:
        print("Telegram release notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured.")
        return 0

    payload_fields = {
        "chat_id": chat_id,
        "text": build_message(),
        "disable_web_page_preview": "true",
    }
    parse_mode = env("TELEGRAM_PARSE_MODE", DEFAULT_PARSE_MODE)
    if parse_mode:
        payload_fields["parse_mode"] = parse_mode

    payload = urllib.parse.urlencode(payload_fields).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status >= 400:
                print(f"Telegram notification failed with HTTP {response.status}.", file=sys.stderr)
                return 1
    except Exception as exc:
        print(f"Telegram notification failed: {exc}", file=sys.stderr)
        return 1

    print("Telegram release notification sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
