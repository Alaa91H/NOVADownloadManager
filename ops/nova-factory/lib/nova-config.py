#!/usr/bin/env python3
"""NOVA configuration validator and safe printer.

This tool parses /etc/nova/nova.env without evaluating shell code, validates the
operational contract, and prints redacted configuration for diagnostics.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from datetime import datetime, timezone

ENV_FILE = Path(os.environ.get("NOVA_ENV_FILE", "/etc/nova/nova.env"))
TEMPLATE_FILE = Path(__file__).resolve().parent / "factory-source" / "config" / "nova.env.example"
SECRET_RE = re.compile(r"(TOKEN|SECRET|PASSWORD|PASS|AUTH|COOKIE|KEY|HASH)", re.I)
ID_LIST_RE = re.compile(r"^\s*\d+(?:[\s,]+\d+)*\s*$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

REQUIRED = {
    "NOVA_BOT_TOKEN": "Telegram bot token used by nova-bot.service",
    "NOVA_OWNER_IDS": "numeric Telegram user IDs allowed to register/administer chats",
    "NOVA_PROJECT_DIR": "absolute path to the managed repository",
    "NOVA_TARGET_USER": "local Unix user that owns the managed repository",
    "NOVA_GH_REPO": "GitHub repository in owner/name form",
}

RECOMMENDED = {
    "NOVA_BRANCH": "managed development branch, usually develop",
    "NOVA_STABLE_BRANCH": "stable release branch, usually main",
    "NOVA_DEVELOP_BRANCH": "continuous development branch, usually develop",
    "NOVA_UPDATE_CHANNEL": "stable/candidate/dev release channel",
    "NOVA_SELF_UPDATE_ENABLED": "1/0 toggle for automatic self-update timer",
    "NOVA_UPDATE_STRATEGY": "ff-only/rebase/reset update strategy",
    "NOVA_FACTORY_SOURCE_DIR": "path inside repo to ops/nova-factory if present",
}

DEFAULTS = {
    "NOVA_BRANCH": "develop",
    "NOVA_STABLE_BRANCH": "main",
    "NOVA_DEVELOP_BRANCH": "develop",
    "NOVA_BRANCH_POLICY_ENFORCE": "1",
    "NOVA_UPDATE_CHANNEL": "stable",
    "NOVA_SELF_UPDATE_ENABLED": "1",
    "NOVA_UPDATE_STRATEGY": "ff-only",
    "NOVA_FACTORY_SOURCE_DIR": "ops/nova-factory",
    "NOVA_VAR_DIR": "/var/lib/nova",
    "NOVA_LOG_DIR": "/var/log/nova",
    "NOVA_BACKUP_DIR": "/var/backups/nova",
}

VALID_CHANNELS = {"stable", "candidate", "dev"}
VALID_BOOL = {"0", "1", "true", "false", "yes", "no", "on", "off"}
VALID_STRATEGIES = {"ff-only", "rebase", "reset"}


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_env(path: Path) -> tuple[dict[str, str], list[str]]:
    env: dict[str, str] = {}
    warnings: list[str] = []
    if not path.exists():
        return env, [f"env file does not exist: {path}"]
    for lineno, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            warnings.append(f"line {lineno}: ignored non-assignment")
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            warnings.append(f"line {lineno}: invalid key {key!r}")
            continue
        if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
            value = value[1:-1]
        env[key] = value
    return env, warnings


def redacted(key: str, value: str) -> str:
    if SECRET_RE.search(key):
        if not value:
            return ""
        if len(value) <= 8:
            return "***"
        return value[:3] + "***" + value[-3:]
    return value


def as_bool(value: str) -> bool | None:
    v = value.strip().lower()
    if v in {"1", "true", "yes", "on"}:
        return True
    if v in {"0", "false", "no", "off"}:
        return False
    return None


def validate(path: Path = ENV_FILE) -> dict:
    env, parse_warnings = parse_env(path)
    errors: list[str] = []
    warnings: list[str] = list(parse_warnings)

    for key, why in REQUIRED.items():
        value = env.get(key, "")
        if not value:
            errors.append(f"missing required {key}: {why}")
        elif value.startswith("REPLACE_") or value in {"OWNER/REPO", "CHANGE_ME", "TODO"}:
            errors.append(f"placeholder value for required {key}: {why}")

    if env.get("NOVA_OWNER_IDS") and not ID_LIST_RE.fullmatch(env["NOVA_OWNER_IDS"]):
        errors.append("NOVA_OWNER_IDS must be numeric Telegram IDs separated by comma or whitespace")

    if env.get("NOVA_OPERATOR_IDS") and not ID_LIST_RE.fullmatch(env["NOVA_OPERATOR_IDS"]):
        errors.append("NOVA_OPERATOR_IDS must be numeric Telegram IDs separated by comma or whitespace")

    if env.get("NOVA_VIEWER_IDS") and not ID_LIST_RE.fullmatch(env["NOVA_VIEWER_IDS"]):
        errors.append("NOVA_VIEWER_IDS must be numeric Telegram IDs separated by comma or whitespace")

    if env.get("NOVA_GH_REPO") and not REPO_RE.fullmatch(env["NOVA_GH_REPO"]):
        errors.append("NOVA_GH_REPO must be in owner/repo form")

    project = env.get("NOVA_PROJECT_DIR")
    if project:
        p = Path(project)
        if not p.is_absolute():
            errors.append("NOVA_PROJECT_DIR must be an absolute path")
        elif not p.exists():
            warnings.append(f"NOVA_PROJECT_DIR does not exist yet: {p}")
        elif not (p / ".git").exists():
            warnings.append(f"NOVA_PROJECT_DIR is not a git checkout: {p}")

    target_user = env.get("NOVA_TARGET_USER")
    if target_user:
        passwd = Path("/etc/passwd").read_text(errors="ignore") if Path("/etc/passwd").exists() else ""
        if f"{target_user}:" not in passwd:
            warnings.append(f"NOVA_TARGET_USER does not currently exist: {target_user}")

    channel = env.get("NOVA_UPDATE_CHANNEL", DEFAULTS["NOVA_UPDATE_CHANNEL"]).lower()
    if channel not in VALID_CHANNELS:
        errors.append(f"NOVA_UPDATE_CHANNEL must be one of {sorted(VALID_CHANNELS)}")

    strategy = env.get("NOVA_UPDATE_STRATEGY", DEFAULTS["NOVA_UPDATE_STRATEGY"]).lower()
    if strategy not in VALID_STRATEGIES:
        errors.append(f"NOVA_UPDATE_STRATEGY must be one of {sorted(VALID_STRATEGIES)}")

    for key in ["NOVA_SELF_UPDATE_ENABLED", "NOVA_ENABLE_EXEC", "NOVA_LOCAL_BUILD_ENABLED"]:
        if key in env and env[key].strip().lower() not in VALID_BOOL:
            errors.append(f"{key} must be boolean-like: {sorted(VALID_BOOL)}")

    token = env.get("NOVA_BOT_TOKEN", "")
    if token and not re.match(r"^\d+:[A-Za-z0-9_-]{20,}$", token):
        warnings.append("NOVA_BOT_TOKEN does not look like a standard Telegram bot token")

    for key, why in RECOMMENDED.items():
        if not env.get(key):
            warnings.append(f"recommended {key} not set: {why}; default={DEFAULTS.get(key, 'none')}")

    dangerous = []
    if as_bool(env.get("NOVA_ENABLE_EXEC", "0")):
        dangerous.append("NOVA_ENABLE_EXEC is enabled; keep allowlist strict and owner-only")
    if env.get("NOVA_UPDATE_STRATEGY", "ff-only").lower() == "reset":
        dangerous.append("NOVA_UPDATE_STRATEGY=reset can discard local changes")
    if as_bool(env.get("NOVA_LOCAL_BUILD_ENABLED", "0")):
        dangerous.append("NOVA_LOCAL_BUILD_ENABLED is enabled; this node is no longer orchestrator-only")

    return {
        "checked_at": utc(),
        "env_file": str(path),
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "dangerous_settings": dangerous,
        "required": sorted(REQUIRED),
        "recommended": sorted(RECOMMENDED),
        "effective_defaults": DEFAULTS,
    }


def safe_config(path: Path = ENV_FILE) -> dict:
    env, warnings = parse_env(path)
    merged = dict(DEFAULTS)
    merged.update(env)
    return {
        "generated_at": utc(),
        "env_file": str(path),
        "warnings": warnings,
        "config": {k: redacted(k, v) for k, v in sorted(merged.items())},
    }


def diff_template(path: Path = ENV_FILE, template: Path = TEMPLATE_FILE) -> dict:
    current, cw = parse_env(path)
    tmpl, tw = parse_env(template)
    current_keys = set(current)
    tmpl_keys = set(tmpl)
    return {
        "generated_at": utc(),
        "env_file": str(path),
        "template_file": str(template),
        "warnings": cw + tw,
        "missing_from_env": sorted(tmpl_keys - current_keys),
        "extra_in_env": sorted(current_keys - tmpl_keys),
        "common": sorted(current_keys & tmpl_keys),
    }


def print_json(data: dict) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NOVA config validation")
    parser.add_argument("--env", default=str(ENV_FILE), help="path to nova.env")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate")
    sub.add_parser("safe")
    p = sub.add_parser("diff")
    p.add_argument("--template", default=str(TEMPLATE_FILE))
    args = parser.parse_args(argv)
    env_path = Path(args.env)
    if args.cmd == "validate":
        data = validate(env_path)
        print_json(data)
        return 0 if data["valid"] else 2
    if args.cmd == "safe":
        print_json(safe_config(env_path))
        return 0
    if args.cmd == "diff":
        print_json(diff_template(env_path, Path(args.template)))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
