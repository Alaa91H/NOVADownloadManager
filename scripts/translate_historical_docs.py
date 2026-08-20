#!/usr/bin/env python3
"""Translate legacy NOVA Markdown records to English without altering technical facts."""

from __future__ import annotations

import argparse
import os
import pathlib
import sys
import time

import requests

API_BASE = os.environ["OPENAI_API_BASE"].rstrip("/")
API_KEY = os.environ["OPENAI_API_KEY"]
MODEL = "gpt-5-mini"

SYSTEM_PROMPT = """You are a meticulous technical translator for a software repository.
Translate the supplied Markdown document from Arabic to professional English.
Return ONLY the complete translated Markdown document; do not wrap it in a code fence.
Preserve every factual claim, chronology, numerical value, file path, URL, command,
identifier, code block, table structure, and heading level. Preserve external URLs,
file paths, commands, and links to other files. For a local Markdown anchor fragment
that refers to a translated heading, translate the anchor fragment so it matches the
English heading; do not leave Arabic anchors pointing to English headings.
Do not add new findings, tests, builds, releases, or status claims. Do not resolve
historical observations or rewrite them as current state. Keep product and proper names
unchanged. Translate prose inside headings, tables, block quotes, comments, and captions.
Use concise, natural technical English while retaining the source document's level of detail."""


def translate(source: str) -> str:
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": source},
        ],
        "max_completion_tokens": 30000,
    }
    response = requests.post(
        f"{API_BASE}/chat/completions",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json=payload,
        timeout=600,
    )
    response.raise_for_status()
    body = response.json()
    content = body["choices"][0]["message"].get("content")
    if not content or not content.strip():
        raise RuntimeError(f"empty translation response: {body}")
    return content.rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", type=pathlib.Path)
    parser.add_argument("--suffix", default=".english.tmp")
    args = parser.parse_args()

    for path in args.files:
        if not path.is_file():
            raise FileNotFoundError(path)
        source = path.read_text(encoding="utf-8")
        print(f"Translating {path} ({len(source)} characters)...", flush=True)
        for attempt in range(1, 4):
            try:
                translated = translate(source)
                target = path.with_name(path.name + args.suffix)
                target.write_text(translated, encoding="utf-8")
                print(f"Wrote {target} ({len(translated)} characters)", flush=True)
                break
            except Exception as exc:
                if attempt == 3:
                    raise
                print(f"Attempt {attempt} failed for {path}: {exc}; retrying...", file=sys.stderr)
                time.sleep(attempt * 3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
