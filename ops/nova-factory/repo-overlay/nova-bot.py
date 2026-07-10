#!/usr/bin/env python3
"""
NOVA Telegram Interface v4.1.
"""
import asyncio
import json
import os
import re
import sys
import time
import signal
import shlex
import subprocess
import traceback
import contextvars
import uuid
from datetime import datetime, timezone
from pathlib import Path

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, ReplyKeyboardRemove
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
from telegram.constants import ParseMode

# Config
BOT_TOKEN = os.environ.get("NOVA_BOT_TOKEN", "")
TELEGRAM_API_ID = os.environ.get("NOVA_API_ID", "")
TELEGRAM_API_HASH = os.environ.get("NOVA_API_HASH", "")

DEFAULT_HOME = Path(os.environ.get("HOME") or str(Path.home()))
PROJECT_DIR = Path(os.environ.get("NOVA_PROJECT_DIR", str(DEFAULT_HOME / "NOVA"))).resolve()
VAR_DIR = Path(os.environ.get("NOVA_VAR_DIR", "/var/lib/nova")).resolve()
LOG_DIR = Path(os.environ.get("NOVA_LOG_DIR", "/var/log/nova")).resolve()
BRANCH = os.environ.get("NOVA_BRANCH") or os.environ.get("NOVA_DEVELOP_BRANCH", "develop")
GH_REPO = os.environ.get("NOVA_GH_REPO", "Alaa91H/NOVADownloadManager")
MODEL = os.environ.get("NOVA_AGENT_MODEL", "opencode/big-pickle")
AGENT_SERVICE = os.environ.get("NOVA_AGENT_SERVICE", "nova-dev-agent.service")
LOG_FILE = Path(os.environ.get("NOVA_AGENT_LOG", str(LOG_DIR / "nova-dev-agent.log")))
# Live controller state and lifecycle event journal (written by the controller).
STATE_FILE = VAR_DIR / ".agent-state.json"
EVENTS_FILE = VAR_DIR / "events.jsonl"
NOTIF_CURSOR = VAR_DIR / ".notif-cursor.json"
_STARTED_AT = int(time.time())  # notifications older than startup are not replayed
OPENCODE_BIN = os.environ.get("NOVA_OPENCODE", str(DEFAULT_HOME / ".opencode" / "bin" / "opencode"))
CHATS_FILE = Path(os.environ.get("NOVA_CHATS_FILE", str(VAR_DIR / "bot-chats.json")))
LEGACY_CHATS_FILE = PROJECT_DIR / ".bot-chats.json"
NOTIF_FILE = Path(os.environ.get("NOVA_NOTIF_FILE", str(VAR_DIR / "notif-prefs.json")))
LEGACY_NOTIF_FILE = PROJECT_DIR / ".notif-prefs.json"
SCRIPTS_DIR = PROJECT_DIR / "scripts" / "agent"
MAX_OUTPUT_LENGTH = 3800

SELF_PATH = Path(os.environ.get("NOVA_BOT_PATH", str(PROJECT_DIR / "nova-bot.py")))
BOT_LOG = Path(os.environ.get("NOVA_BOT_LOG", str(LOG_DIR / "nova-bot.log")))
BOT_PID = os.getpid()
BOT_VERSION = "6.1.0-autonomous-orchestrator-complete"
OWNER_USER_IDS = {int(x) for x in re.split(r"[,\s]+", os.environ.get("NOVA_OWNER_IDS", "").strip()) if x.isdigit()}
OPERATOR_USER_IDS = {int(x) for x in re.split(r"[,\s]+", os.environ.get("NOVA_OPERATOR_IDS", "").strip()) if x.isdigit()}
VIEWER_USER_IDS = {int(x) for x in re.split(r"[,\s]+", os.environ.get("NOVA_VIEWER_IDS", "").strip()) if x.isdigit()}
ROLE_ORDER = {"viewer": 1, "operator": 2, "owner": 3}
EXEC_ENABLED = os.environ.get("NOVA_ENABLE_EXEC", "0").strip().lower() in {"1", "true", "yes", "on"}
EXEC_ALLOWLIST = {x.strip() for x in re.split(r"[,\s]+", os.environ.get("NOVA_EXEC_ALLOWLIST", "git,gh,rg,grep,ls,pwd").strip()) if x.strip()}
ADMIN_BIN = os.environ.get("NOVA_ADMIN_BIN", "/usr/local/lib/nova/nova-admin.py")

running_execs: dict[int, asyncio.subprocess.Process] = {}
pending_confirm: dict[int, tuple[str, str, dict]] = {}  # chat_id -> (action, prompt, context)
CURRENT_ACTOR = contextvars.ContextVar("CURRENT_ACTOR", default="telegram:unknown")
CURRENT_CORRELATION_ID = contextvars.ContextVar("CURRENT_CORRELATION_ID", default="")

# Notification types
NOTIF_TYPES = [
    "cycle_start", "cycle_done", "ci_result", "ci_fail",
    "error", "maintenance", "analysis", "daily_summary", "system",
]

NOTIF_LABELS = {
    "cycle_start": "بدء دورة العمل",
    "cycle_done": "اكتمال دورة العمل",
    "ci_result": "نتيجة CI",
    "ci_fail": "فشل CI",
    "error": "خطأ",
    "maintenance": "صيانة",
    "analysis": "تحليل",
    "daily_summary": "الملخص اليومي",
    "system": "النظام",
}

# Presentation maps for controller state and lifecycle events.
KIND_LABELS = {
    "analysis": "🔍 تحليل",
    "fix": "🛠️ إصلاح",
    "develop": "🧩 تطوير",
    "improve": "✨ تحسين",
    "build": "⚙️ تنفيذ",
    "release": "🚀 إصدار",
    "ci": "🔧 معالجة CI",
    "system": "🖥️ النظام",
}
STREAM_AR = {"FIX": "إصلاح", "DEVELOP": "تطوير", "IMPROVE": "تحسين"}
PHASE_AR = {
    "cycle-start": "بدء الدورة",
    "deep-plan-generation": "توليد خطة العمل",
    "periodic-audit": "تحليل دوري",
    "opencode:plan-generation": "توليد خطة العمل",
    "opencode:audit": "تحليل دوري",
    "opencode:task": "تنفيذ المهمة",
    "cycle-complete": "اكتملت الدورة",
    "idle": "خمول",
    "signal": "إيقاف",
    "missing-opencode": "خطأ في المحرك",
}
STATUS_AR = {
    "running": "قيد العمل",
    "finished": "أنهى الخطوة",
    "sleeping": "بانتظار الدورة التالية",
    "error": "خطأ",
    "stopping": "يتوقف",
}

def _phase_ar(phase: str) -> str:
    if phase.startswith("opencode:ci-repair"):
        return "إصلاح فحوصات CI"
    return PHASE_AR.get(phase, phase or "—")

def read_agent_state() -> dict:
    """Read the live controller state written by the development controller."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}

def fmt_duration(sec) -> str:
    try:
        sec = int(sec)
    except Exception:
        return "—"
    if sec < 60:
        return f"{sec} ثانية"
    if sec < 3600:
        return f"{sec // 60} د {sec % 60} ث"
    return f"{sec // 3600} س {(sec % 3600) // 60} د"

def fmt_ago(epoch) -> str:
    try:
        delta = int(time.time()) - int(epoch)
    except Exception:
        return "—"
    if delta < 0:
        delta = 0
    return f"منذ {fmt_duration(delta)}"

def format_state_short(s: dict) -> str:
    """One-line summary of the live controller state."""
    if not s:
        return "غير متوفرة"
    cycle = s.get("cycle", "—")
    phase = _phase_ar(s.get("phase", ""))
    status = STATUS_AR.get(s.get("status", ""), s.get("status", ""))
    return f"{cycle} · {phase} · {status} ({fmt_ago(s.get('epoch', 0))})"

# Notification frequency levels
FREQ_LEVELS = ["normal", "important", "minimal", "off"]
FREQ_LABELS = {
    "normal": "عادي",
    "important": "المهم فقط",
    "minimal": "الأخطاء فقط",
    "off": "إيقاف",
}
# Which types are allowed per frequency level
FREQ_FILTER = {
    "normal": set(NOTIF_TYPES),
    "important": {"cycle_start", "cycle_done", "error", "ci_fail", "daily_summary"},
    "minimal": {"error", "ci_fail", "daily_summary"},
    "off": set(),
}

# Auth
def _read_json_file(path: Path, fallback):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback
    return fallback

def load_chats() -> list[int]:
    data = _read_json_file(CHATS_FILE, None)
    if data is None and LEGACY_CHATS_FILE != CHATS_FILE:
        data = _read_json_file(LEGACY_CHATS_FILE, [])
    if isinstance(data, dict):
        data = list(data.keys())
    try:
        return [int(x) for x in (data or [])]
    except Exception:
        return []

def save_chats(chats: list[int]):
    CHATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CHATS_FILE.write_text(json.dumps(sorted(set(int(x) for x in chats)), indent=2), encoding="utf-8")

def load_notif_prefs() -> dict:
    data = _read_json_file(NOTIF_FILE, None)
    if data is None and LEGACY_NOTIF_FILE != NOTIF_FILE:
        data = _read_json_file(LEGACY_NOTIF_FILE, {})
    return data if isinstance(data, dict) else {}

def save_notif_prefs(prefs: dict):
    NOTIF_FILE.parent.mkdir(parents=True, exist_ok=True)
    NOTIF_FILE.write_text(json.dumps(prefs, indent=2, ensure_ascii=False), encoding="utf-8")

def get_chat_prefs(chat_id: int) -> dict:
    prefs = load_notif_prefs()
    defaults = {"freq": "normal"} | {t: True for t in NOTIF_TYPES}
    return defaults | prefs.get(str(chat_id), {})

def set_chat_pref(chat_id: int, notif_type: str, enabled: bool):
    prefs = load_notif_prefs()
    cid = str(chat_id)
    if cid not in prefs:
        prefs[cid] = {"freq": "normal"} | {t: True for t in NOTIF_TYPES}
    prefs[cid][notif_type] = enabled
    save_notif_prefs(prefs)

def set_chat_freq(chat_id: int, freq: str):
    """Set frequency level and toggle individual types accordingly."""
    if freq not in FREQ_LEVELS:
        return
    prefs = load_notif_prefs()
    cid = str(chat_id)
    entry = prefs.get(cid, {})
    entry["freq"] = freq
    allowed = FREQ_FILTER[freq]
    for t in NOTIF_TYPES:
        entry[t] = t in allowed
    prefs[cid] = entry
    save_notif_prefs(prefs)

def user_role(user_id: int | None) -> str | None:
    if user_id is None:
        return None
    if user_id in OWNER_USER_IDS:
        return "owner"
    if user_id in OPERATOR_USER_IDS:
        return "operator"
    if user_id in VIEWER_USER_IDS:
        return "viewer"
    return None

def has_role(user_id: int | None, required: str) -> bool:
    role = user_role(user_id)
    return role is not None and ROLE_ORDER.get(role, 0) >= ROLE_ORDER.get(required, 999)

def role_label(user_id: int | None) -> str:
    return user_role(user_id) or "unregistered"

def role_required(required: str):
    def deco(func):
        async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE, *args, **kwargs):
            user_id = update.effective_user.id if update and update.effective_user else None
            if not has_role(user_id, required):
                msg = f"غير مصرح: هذا الأمر يتطلب صلاحية {required}. صلاحيتك الحالية: {role_label(user_id)}."
                if update.callback_query:
                    await update.callback_query.answer(msg, show_alert=True)
                elif update.message:
                    await update.message.reply_text(msg)
                return
            return await func(update, context, *args, **kwargs)
        return wrapper
    return deco

def callback_required_role(data: str) -> str | None:
    owner_prefixes = ("update_apply", "update_rollback", "backup_restore", "config_reload")
    operator_prefixes = ("agent_start", "agent_stop", "agent_restart", "clean", "update_check", "doctor")
    if data in {"update_apply", "update_apply_confirm", "update_rollback", "update_rollback_confirm"} or data.startswith(owner_prefixes):
        return "owner"
    if data in {"agent_start", "agent_stop", "agent_stop_confirm", "agent_restart", "agent_restart_confirm", "clean", "update_check", "doctor"} or data.startswith(operator_prefixes):
        return "operator"
    return None

def restricted(func):
    async def wrapper(self_or_update, context, *args, **kwargs):
        if isinstance(self_or_update, Update):
            update = self_or_update
        else:
            update = args[0] if args else None
        if not update or not update.effective_user:
            return
        chat_id = update.effective_chat.id if update.effective_chat else None
        allowed_chats = load_chats()
        # Determine if it's a message or callback
        if update.callback_query:
            text = update.callback_query.data or ""
        else:
            text = update.message.text.split()[0] if update.message and update.message.text else ""
        if text in ("/start", "/register", "/myid", "menu_main"):
            return await func(self_or_update, context, *args, **kwargs)
        if chat_id not in allowed_chats:
            if update.callback_query:
                await update.callback_query.answer("غير مصرح", show_alert=True)
            else:
                await update.message.reply_text("غير مصرح لهذه المحادثة. يجب أن يسجلها مالك مصرح عبر /register.")
            return
        user_id = update.effective_user.id if update.effective_user else None
        role = user_role(user_id)
        if role is None:
            if update.callback_query:
                await update.callback_query.answer("غير مصرح لهذا المستخدم", show_alert=True)
            else:
                await update.message.reply_text("غير مصرح لهذا المستخدم. أضفه إلى NOVA_OWNER_IDS أو NOVA_OPERATOR_IDS أو NOVA_VIEWER_IDS.")
            return
        actor_token = CURRENT_ACTOR.set(f"telegram:{user_id}:{role}")
        corr_ctx = CURRENT_CORRELATION_ID.set(str(uuid.uuid4()))
        try:
            return await func(self_or_update, context, *args, **kwargs)
        finally:
            CURRENT_ACTOR.reset(actor_token)
            CURRENT_CORRELATION_ID.reset(corr_ctx)
    return wrapper

# Helpers
SHELL_META_RE = re.compile(r"[|&;<>()$`\n\r{}\[\]*?~]")

async def run_cmd(cmd: str, timeout: int = 30, cwd: str | None = None) -> tuple[int, str, str]:
    """Compatibility wrapper that deliberately does not invoke a shell.

    Production Telegram paths should use run_argv or run_admin. This wrapper only
    accepts simple argv-style commands and rejects shell metacharacters.
    """
    if SHELL_META_RE.search(cmd):
        return 126, "", "shell syntax is disabled in the production Telegram surface"
    try:
        argv = shlex.split(cmd)
    except ValueError as exc:
        return 126, "", f"invalid argv syntax: {exc}"
    if not argv:
        return 0, "", ""
    return await run_argv(argv, timeout=timeout, cwd=cwd)

async def run_argv(argv: list[str], timeout: int = 30, cwd: str | None = None, env: dict[str, str] | None = None) -> tuple[int, str, str]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=cwd or str(PROJECT_DIR), env=child_env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")
    except asyncio.TimeoutError:
        proc.kill(); await proc.wait()
        return -1, "", f"انتهت مهلة التنفيذ ({timeout}s)"

async def run_admin(args: list[str], timeout: int = 120) -> tuple[int, str, str]:
    """Run a privileged NOVA admin action through the root-owned allowlisted boundary."""
    actor = CURRENT_ACTOR.get() or "telegram:unknown"
    corr = CURRENT_CORRELATION_ID.get() or str(uuid.uuid4())
    return await run_argv(["sudo", "-n", ADMIN_BIN, "--actor", actor, "--correlation-id", corr, *args], timeout=timeout, cwd=str(PROJECT_DIR))

async def admin_json(args: list[str], timeout: int = 120) -> tuple[int, dict, str]:
    code, out, err = await run_admin(args, timeout=timeout)
    try:
        data = json.loads(out or "{}")
        return code, data if isinstance(data, dict) else {"value": data}, err
    except Exception:
        return code, {}, err or out

def human_bytes(value) -> str:
    try:
        n = float(value)
    except Exception:
        return "N/A"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024
    return "N/A"

def svc_status(snapshot: dict, name: str) -> str:
    state = (snapshot.get("services") or {}).get(name, {})
    return str(state.get("active") or "unknown")

def first_net(snapshot: dict) -> tuple[str, str]:
    interfaces = (((snapshot.get("system") or {}).get("network") or {}).get("interfaces") or [])
    if not interfaces:
        return "N/A", "N/A"
    total_rx = sum(int(x.get("rx_bytes") or 0) for x in interfaces)
    total_tx = sum(int(x.get("tx_bytes") or 0) for x in interfaces)
    return human_bytes(total_rx), human_bytes(total_tx)

def trim_output(text: str, max_len: int = MAX_OUTPUT_LENGTH) -> str:
    if len(text) <= max_len: return text
    return text[:max_len] + f"\n\n... (تم اختصار المخرجات؛ الطول الكامل {len(text)} حرف)"

def format_status(status: str) -> str:
    labels = {
        "active": "يعمل",
        "inactive": "متوقف",
        "failed": "فشل",
        "activating": "قيد التشغيل",
        "deactivating": "قيد الإيقاف",
    }
    return f"{labels.get(status, 'غير معروف')} ({status})"

def format_snapshot_status(data: dict) -> str:
    system = data.get("system") or {}
    mem = system.get("memory") or {}
    disk = ((system.get("disk") or {}).get("root") or {})
    git = data.get("git") or {}
    cpu = system.get("cpu_percent")
    last_cycle = "N/A"
    st = read_agent_state()
    if st:
        last_cycle = format_state_short(st)
    return (
        f"**حالة السيرفر**\n"
        f"- CPU: `{cpu if cpu is not None else 'N/A'}%`\n"
        f"- RAM: `{human_bytes(mem.get('used'))}/{human_bytes(mem.get('total'))} ({mem.get('used_percent', 'N/A')}%)`\n"
        f"- Disk: `{human_bytes(disk.get('used'))}/{human_bytes(disk.get('total'))} ({disk.get('used_percent', 'N/A')}%)`\n\n"
        f"**الخدمات**\n"
        f"- Controller: {format_status(svc_status(data, 'nova-dev-agent.service'))}\n"
        f"- Telegram: {format_status(svc_status(data, 'nova-bot.service'))}\n"
        f"- Monitor: {format_status(svc_status(data, 'nova-monitor.service'))}\n"
        f"- آخر دورة: `{last_cycle}`\n\n"
        f"**Git**\n"
        f"- Branch: `{git.get('branch') or '?'}`\n"
        f"- Dirty paths: `{git.get('dirty_paths', '?')}`\n"
        f"- Ahead/Behind: `{git.get('ahead_remote_count', 0)}/{git.get('behind_remote_count', 0)}`"
    )

def format_disk_snapshot(data: dict) -> str:
    system = data.get("system") or {}
    disks = system.get("disk") or {}
    dirs = system.get("directories") or {}
    lines = ["**استخدام المساحة**", "```"]
    for key, item in disks.items():
        if not isinstance(item, dict):
            continue
        lines.append(f"{key:<10} {human_bytes(item.get('used'))}/{human_bytes(item.get('total'))} ({item.get('used_percent', 'N/A')}%) path={item.get('path', '?')}")
    lines.append("```")
    lines.append(f"**node_modules:** `{human_bytes((dirs.get('node_modules') or {}).get('bytes'))}`")
    lines.append(f"**target:** `{human_bytes((dirs.get('tauri_target') or {}).get('bytes'))}`")
    return "\n".join(lines)

def format_process_snapshot(data: dict, sort: str = "cpu") -> str:
    rows = ((data.get("processes") or {}).get(sort) or (data.get("processes") or {}).get("cpu") or [])
    text = "\n".join(rows[:15]) or "N/A"
    return f"**العمليات حسب {sort}**\n```\n{trim_output(text, 3500)}\n```"

def format_report_snapshot(data: dict) -> str:
    system = data.get("system") or {}
    mem = system.get("memory") or {}
    disk = ((system.get("disk") or {}).get("root") or {})
    git = data.get("git") or {}
    rx, tx = first_net(data)
    task = "N/A"
    plan_file = PROJECT_DIR / "Plan.md"
    if plan_file.exists():
        try:
            m = re.search(r"### (.+?)\n.*?Status:.*?IN_PROGRESS", plan_file.read_text(encoding="utf-8", errors="replace"), re.DOTALL)
            if m:
                task = m.group(1).strip()
        except Exception:
            pass
    st = read_agent_state()
    last_cycle = format_state_short(st) if st else "N/A"
    return (
        f"**تقرير NOVA**\n\n"
        f"**النظام**\n- CPU: `{system.get('cpu_percent', '?')}%`\n"
        f"- RAM: `{human_bytes(mem.get('used'))}/{human_bytes(mem.get('total'))} ({mem.get('used_percent', '?')}%)`\n"
        f"- Disk: `{human_bytes(disk.get('used'))}/{human_bytes(disk.get('total'))} ({disk.get('used_percent', '?')}%)`\n"
        f"- Network RX/TX: `{rx}` / `{tx}`\n\n"
        f"**الخدمات**\n- Controller: {format_status(svc_status(data, 'nova-dev-agent.service'))}\n"
        f"- Telegram: {format_status(svc_status(data, 'nova-bot.service'))}\n"
        f"- آخر دورة: `{last_cycle}`\n\n"
        f"**المهمة النشطة**\n`{task}`\n\n"
        f"**Git**\n- Branch: `{git.get('branch') or '?'}`\n- HEAD: `{git.get('head') or '?'}`\n- Recent:\n```\n{chr(10).join((git.get('recent') or [])[:3])[:500]}\n```"
    )

def shlex_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"

async def broadcast_message(text: str, notif_type: str = "system", bot=None):
    """Send to all chats that have this notification type enabled."""
    chats = load_chats()
    if not chats: return
    if bot is None:
        from telegram import Bot
        bot = Bot(token=BOT_TOKEN)
    for chat_id in chats:
        prefs = get_chat_prefs(chat_id)
        if not prefs.get(notif_type, True):
            continue
        try:
            await bot.send_message(chat_id=chat_id, text=text, parse_mode=ParseMode.MARKDOWN)
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Lifecycle notifications: the controller appends structured events to
# EVENTS_FILE; this watcher tails new events and delivers a professional,
# per-subscriber notification for each one.
# ---------------------------------------------------------------------------
def _safe(s: str) -> str:
    """Neutralise legacy-Markdown control characters in dynamic text so a task
    title can never break Telegram entity parsing."""
    return re.sub(r"[_*\[\]`]", "", s or "").strip()

def format_event(ev: dict) -> tuple[str, str]:
    """Return (message_text, notif_type) for a controller lifecycle event."""
    etype = ev.get("type", "system")
    title = _safe((ev.get("title") or "").strip())
    kind = ev.get("kind", "")
    stream = (ev.get("stream") or "").upper()
    rc = ev.get("rc", 0)
    dur = ev.get("dur", 0)
    summary = _safe((ev.get("summary") or "").strip())
    klabel = KIND_LABELS.get(kind, "")
    slabel = STREAM_AR.get(stream, "")

    if etype == "cycle_start":
        line = "🚀 *بدء مهمة جديدة*\n"
        line += f"*النوع:* {klabel or 'تنفيذ'}\n"
        line += f"*المهمة:* {title}"
        if summary:
            line += f"\n*ماذا سيفعل:* {summary}"
        return line, "cycle_start"
    if etype == "cycle_done":
        ok = (str(rc) == "0")
        head = "✅ *اكتملت المهمة*" if ok else "⚠️ *انتهت المهمة مع ملاحظات*"
        line = f"{head}\n*النوع:* {klabel or 'تنفيذ'}\n*المهمة:* {title}\n*المدة:* {fmt_duration(dur)}"
        if summary:
            line += f"\n*ماذا تغيّر:* {summary}"
        if not ok:
            line += "\n*النتيجة:* ستتم إعادة المحاولة في الدورة التالية."
        return line, "cycle_done"
    if etype == "analysis":
        return f"🔍 *تحليل المشروع*\n{title}", "analysis"
    if etype == "ci_fail":
        return f"🔴 *فشل في فحوصات CI*\n{title}", "ci_fail"
    if etype == "ci_result":
        ok = (str(rc) == "0")
        head = "🟢 *فحوصات CI ناجحة*" if ok else "🔴 *فحوصات CI فاشلة*"
        return f"{head}\n{title}", "ci_result"
    if etype == "error":
        return f"⛔ *تنبيه خطأ*\n{title}", "error"
    if etype == "maintenance":
        return f"🧹 *صيانة*\n{title}", "maintenance"
    if etype == "daily_summary":
        return (summary or title), "daily_summary"
    return f"ℹ️ {title}" if title else "", "system"

def _read_cursor():
    """Return (offset, last_ts) or None on first run."""
    if NOTIF_CURSOR.exists():
        try:
            d = json.loads(NOTIF_CURSOR.read_text())
            return int(d.get("offset", 0)), int(d.get("last_ts", 0))
        except Exception:
            return 0, 0
    return None

def _write_cursor(offset: int, last_ts: int):
    try:
        NOTIF_CURSOR.write_text(json.dumps({"offset": offset, "last_ts": last_ts}))
    except Exception:
        pass

async def process_events(bot):
    """Tail the controller event journal once and deliver new events."""
    if not EVENTS_FILE.exists():
        return
    try:
        size = EVENTS_FILE.stat().st_size
    except Exception:
        return
    cur = _read_cursor()
    if cur is None:
        # First run: read from the start but only deliver events newer than
        # process startup, so existing history is never replayed.
        offset, last_ts = 0, _STARTED_AT
    else:
        offset, last_ts = cur
    if size < offset:
        offset = 0  # journal was rotated/truncated
    try:
        with EVENTS_FILE.open("r", encoding="utf-8", errors="replace") as f:
            f.seek(offset)
            lines = f.readlines()
            new_offset = f.tell()
    except Exception:
        return
    max_ts = last_ts
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        ev_ts = int(ev.get("ts", 0) or 0)
        if ev_ts <= last_ts:
            continue
        max_ts = max(max_ts, ev_ts)
        text, ntype = format_event(ev)
        if text:
            try:
                await broadcast_message(text, ntype, bot=bot)
            except Exception:
                pass
    _write_cursor(new_offset, max_ts)

async def notif_loop(app):
    """Background loop that delivers controller lifecycle notifications.
    Uses a plain asyncio task so no optional JobQueue dependency is required."""
    await asyncio.sleep(6)
    while True:
        try:
            await process_events(app.bot)
        except Exception:
            pass
        await asyncio.sleep(12)

# ---------------------------------------------------------------------------
# Roadmap view: parse Plan.md into a structured task list with progress.
# ---------------------------------------------------------------------------
PLAN_STATUS_KEYS = ["[/] IN_PROGRESS", "[ ] PLANNED", "[!] BLOCKED", "[x] COMPLETED"]

def parse_plan_tasks() -> list[dict]:
    plan = PROJECT_DIR / "Plan.md"
    if not plan.exists():
        return []
    lines = plan.read_text(encoding="utf-8", errors="replace").split("\n")
    heads = [i for i, ln in enumerate(lines)
             if ln.strip().startswith("### ") and not ln.strip().startswith("####")]
    tasks = []
    for idx, start in enumerate(heads):
        end = heads[idx + 1] if idx + 1 < len(heads) else len(lines)
        block = "\n".join(lines[start:end])
        status = next((k for k in PLAN_STATUS_KEYS if k in block), "")
        sm = re.search(r"Stream:\s*`?\s*(FIX|DEVELOP|IMPROVE)", block, re.I)
        pm = re.search(r"Priority:\s*`?\s*(P[0-3])", block, re.I)
        tasks.append({
            "title": _safe(lines[start].strip()[4:]),
            "status": status,
            "stream": (sm.group(1).upper() if sm else ""),
            "priority": (pm.group(1).upper() if pm else ""),
        })
    return tasks

def build_tasks_view() -> str:
    tasks = parse_plan_tasks()
    state = read_agent_state()
    if not tasks:
        head = "📋 *قائمة المهام*\n\nلا توجد مهام مسجّلة في خطة العمل حالياً."
        if state:
            head += f"\n\n*حالة المتحكم:* {format_state_short(state)}"
        return head

    in_prog = [t for t in tasks if t["status"] == "[/] IN_PROGRESS"]
    planned = [t for t in tasks if t["status"] == "[ ] PLANNED"]
    blocked = [t for t in tasks if t["status"] == "[!] BLOCKED"]
    done = [t for t in tasks if t["status"] == "[x] COMPLETED"]
    planned.sort(key=lambda t: t["priority"] or "P9")

    out = ["📋 *قائمة المهام*", ""]
    if state:
        out.append(f"⚙️ *المرحلة الحالية:* {_phase_ar(state.get('phase', ''))}"
                   f" — {STATUS_AR.get(state.get('status', ''), state.get('status', ''))}")
        out.append(f"🕒 *آخر تحديث:* {fmt_ago(state.get('epoch', 0))}")
        out.append("")

    if in_prog:
        out.append("▶️ *قيد التنفيذ الآن:*")
        for t in in_prog:
            meta = " · ".join(x for x in [STREAM_AR.get(t["stream"], ""), t["priority"]] if x)
            out.append(f"• {t['title']}" + (f"  _({meta})_" if meta else ""))
        out.append("")

    if planned:
        out.append(f"⏳ *مهام مخطّطة ({len(planned)}):*")
        for t in planned[:12]:
            tag = " · ".join(x for x in [t["priority"], STREAM_AR.get(t["stream"], "")] if x)
            out.append(f"• {('[' + tag + '] ') if tag else ''}{t['title']}")
        if len(planned) > 12:
            out.append(f"… و{len(planned) - 12} مهمة أخرى")
        out.append("")

    if blocked:
        out.append(f"⛔ *مهام محظورة ({len(blocked)}):*")
        for t in blocked[:6]:
            out.append(f"• {t['title']}")
        out.append("")

    out.append(f"✅ *مكتملة:* {len(done)}  |  *الإجمالي:* {len(tasks)}")
    text = "\n".join(out)
    return text[:3900]

# Inline menu system
def main_menu_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\U0001f5a5 النظام", callback_data="menu_system"),
         InlineKeyboardButton("\U0001f6e0 المتحكم", callback_data="menu_agent")],
        [InlineKeyboardButton("\U0001f4cb الخطة", callback_data="menu_plan"),
         InlineKeyboardButton("\U0001f50d الفحص", callback_data="menu_research")],
        [InlineKeyboardButton("\U0001f4ca التقارير", callback_data="menu_reports"),
         InlineKeyboardButton("\u2699 الإعدادات", callback_data="menu_settings")],
    ])

def system_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\U0001f5a5 حالة السيرفر", callback_data="server"),
         InlineKeyboardButton("\U0001f4ca حالة سريعة", callback_data="status")],
        [InlineKeyboardButton("\U0001f504 التحديث الذاتي", callback_data="menu_update"),
         InlineKeyboardButton("\U0001f9f9 صيانة", callback_data="clean")],
        [InlineKeyboardButton("\U0001f4dd آخر السجل", callback_data="log_30"),
         InlineKeyboardButton("\U0001f4be المساحة", callback_data="disk_info")],
        [InlineKeyboardButton("\u2699 العمليات", callback_data="proc_info")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_main")],
    ])

def update_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\U0001f4ca حالة التحديث", callback_data="update_status"),
         InlineKeyboardButton("\U0001f50d فحص تحديث", callback_data="update_check")],
        [InlineKeyboardButton("\U0001f680 تطبيق تحديث", callback_data="update_apply_confirm"),
         InlineKeyboardButton("\U0001f501 Rollback", callback_data="update_rollback_confirm")],
        [InlineKeyboardButton("\U0001fa7a Doctor", callback_data="doctor"),
         InlineKeyboardButton("❤️ Health", callback_data="health")],
        [InlineKeyboardButton("⚙️ Config", callback_data="config_validate"),
         InlineKeyboardButton("💾 Backup", callback_data="backup_list")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_system")],
    ])

def server_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\U0001f504 تحديث الحالة", callback_data="server"),
         InlineKeyboardButton("\U0001f4ca حالة سريعة", callback_data="status")],
        [InlineKeyboardButton("\U0001f4dd آخر السجل", callback_data="log_30")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_system")],
    ])

def agent_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\u25b6 تشغيل", callback_data="agent_start"),
         InlineKeyboardButton("\u23f9 إيقاف", callback_data="agent_stop"),
         InlineKeyboardButton("\U0001f504 إعادة تشغيل", callback_data="agent_restart")],
        [InlineKeyboardButton("\u2705 حالة CI", callback_data="quality"),
         InlineKeyboardButton("\U0001f50d تحليل", callback_data="analyze")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_main")],
    ])

def plan_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\\U0001f4cb قائمة المهام", callback_data="tasks_list")],
        [InlineKeyboardButton("\U0001f4cb عرض الخطة", callback_data="plan"),
         InlineKeyboardButton("\u2705 إنهاء المهمة", callback_data="plan_done")],
        [InlineKeyboardButton("\U0001f680 بدء أول مهمة", callback_data="plan_start_first"),
         InlineKeyboardButton("\u2139 المهمة النشطة", callback_data="plan_info_active")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_main")],
    ])

def research_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\U0001f50d تحليل المشروع", callback_data="analyze"),
         InlineKeyboardButton("\U0001f4cb تدقيق CI", callback_data="audit")],
        [InlineKeyboardButton("\U0001f4e6 التبعيات", callback_data="deps"),
         InlineKeyboardButton("\U0001f4ca التغطية", callback_data="coverage")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_main")],
    ])

def reports_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\U0001f4ca تقرير عام", callback_data="report"),
         InlineKeyboardButton("\U0001f4cb سجل CI", callback_data="ci_history")],
        [InlineKeyboardButton("\U0001f4c8 المؤشرات", callback_data="metrics"),
         InlineKeyboardButton("\U0001f4ca التغطية", callback_data="coverage")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_main")],
    ])

def settings_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("\U0001f514 إعدادات التنبيهات", callback_data="notif_menu")],
        [InlineKeyboardButton("\U0001f4ca حالة سريعة", callback_data="status")],
        [InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_main")],
    ])

def notif_menu_keyboard(chat_id: int):
    prefs = get_chat_prefs(chat_id)
    current_freq = prefs.get("freq", "normal")
    buttons = []

    # Frequency level row
    freq_row = []
    for f in FREQ_LEVELS:
        marker = "✅" if f == current_freq else "⚪"
        label = FREQ_LABELS.get(f, f)
        freq_row.append(InlineKeyboardButton(f"{marker} {label}", callback_data=f"notif_freq_{f}"))
    buttons.append(freq_row)

    # Individual toggles
    for nt in NOTIF_TYPES:
        status = "\U0001f514" if prefs.get(nt, True) else "\U0001f515"
        label = NOTIF_LABELS.get(nt, nt)
        buttons.append([InlineKeyboardButton(f"{status} {label}", callback_data=f"notif_toggle_{nt}")])
    buttons.append([InlineKeyboardButton("✅ تفعيل الكل", callback_data="notif_all_on"),
                    InlineKeyboardButton("\U0001f515 إيقاف الكل", callback_data="notif_all_off")])
    buttons.append([InlineKeyboardButton("\U0001f519 رجوع", callback_data="menu_settings")])
    return InlineKeyboardMarkup(buttons)

# Persistent reply keyboard
def main_reply_keyboard():
    return ReplyKeyboardMarkup([
        ["المهام"],
        ["النظام", "المتحكم"],
        ["الخطة", "الفحص"],
        ["التقارير", "الإعدادات"],
        ["التنبيهات", "السجلات"],
        ["التحديث", "Doctor"],
        ["المساحة", "العمليات"],
    ], resize_keyboard=True, is_persistent=True)

# Map keyboard button texts to callback data actions
REPLY_ACTIONS = {
    "النظام": "menu_system",
    "المتحكم": "menu_agent",
    "الخطة": "menu_plan",
    "الفحص": "menu_research",
    "التقارير": "menu_reports",
    "الإعدادات": "menu_settings",
    "التنبيهات": "notif_menu",
    "التحديث": "menu_update",
    "Doctor": "doctor",
}

REPLY_DIRECT = {
    "السجلات": ("آخر 30 سطرا من السجل:", "log_30"),
    "المساحة": ("جلب معلومات المساحة...", "disk_info"),
    "العمليات": ("جلب قائمة العمليات...", "proc_info"),
}

async def send_menu(update: Update, text: str = "**لوحة تحكم NOVA**"):
    inline_kb = main_menu_keyboard()
    if update.callback_query:
        await update.callback_query.edit_message_text(text, reply_markup=inline_kb, parse_mode=ParseMode.MARKDOWN)
    else:
        await update.message.reply_text(text, reply_markup=inline_kb, parse_mode=ParseMode.MARKDOWN)
    # Ensure reply keyboard is always visible
    try:
        await update.effective_chat.send_action(action="typing")
    except:
        pass

# Callback handler
@restricted
async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    chat_id = update.effective_chat.id
    required_role = callback_required_role(data or "")
    if required_role and not has_role(update.effective_user.id if update.effective_user else None, required_role):
        return await query.answer(f"غير مصرح: يتطلب {required_role}", show_alert=True)
    await query.answer()

    # Menu navigation
    if data == "menu_main":
        return await send_menu(update)
    elif data == "menu_system":
        return await query.edit_message_text("**النظام** - اختر إجراء:", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_agent":
        return await query.edit_message_text("**المتحكم** - أوامر التشغيل:", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_plan":
        return await query.edit_message_text("**الخطة** - إدارة Plan.md:", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_research":
        return await query.edit_message_text("**الفحص والتحليل**:", reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_reports":
        return await query.edit_message_text("**التقارير**:", reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_settings":
        return await query.edit_message_text("**الإعدادات**:", reply_markup=settings_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_update":
        return await query.edit_message_text("**التحديث الذاتي** — فحص، تطبيق، أو رجوع آمن.", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "notif_menu":
        return await query.edit_message_text("**إعدادات التنبيهات** - اختر المستوى ونوع التنبيه:", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data.startswith("notif_toggle_"):
        nt = data.replace("notif_toggle_", "")
        if nt in NOTIF_TYPES:
            prefs = get_chat_prefs(chat_id)
            new_val = not prefs.get(nt, True)
            set_chat_pref(chat_id, nt, new_val)
            state = "تفعيل" if new_val else "إيقاف"
            return await query.edit_message_text(f"تم {state} التنبيه: {NOTIF_LABELS.get(nt, nt)}", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data == "notif_all_on":
        for nt in NOTIF_TYPES:
            set_chat_pref(chat_id, nt, True)
        return await query.edit_message_text("تم تفعيل كل التنبيهات", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data == "notif_all_off":
        for nt in NOTIF_TYPES:
            set_chat_pref(chat_id, nt, False)
        return await query.edit_message_text("تم إيقاف كل التنبيهات", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data.startswith("notif_freq_"):
        freq = data.replace("notif_freq_", "")
        set_chat_freq(chat_id, freq)
        label = FREQ_LABELS.get(freq, freq)
        return await query.edit_message_text(f"تم ضبط مستوى التنبيهات: {label}", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)

    # Controller control
    if data == "agent_start":
        r = await run_admin(["service", "start", AGENT_SERVICE])
        return await query.edit_message_text(f"تم تشغيل المتحكم:\n`{(r[1]+r[2]).strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "agent_stop":
        # Inline confirmation
        return await query.edit_message_text(
            "تأكيد إيقاف المتحكم مطلوب.\n\n"
            "سيؤدي هذا إلى إيقاف دورة الصيانة المستمرة حتى يتم تشغيلها من جديد.",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("⏹ تأكيد الإيقاف", callback_data="agent_stop_confirm"),
                 InlineKeyboardButton("❌ إلغاء", callback_data="menu_agent")],
            ]),
            parse_mode=ParseMode.MARKDOWN,
        )
    elif data == "agent_stop_confirm":
        r = await run_admin(["service", "stop", AGENT_SERVICE])
        return await query.edit_message_text(f"تم إيقاف المتحكم:\n`{(r[1]+r[2]).strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "agent_restart":
        return await query.edit_message_text(
            "تأكيد إعادة تشغيل المتحكم",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔄 تأكيد إعادة التشغيل", callback_data="agent_restart_confirm"),
                 InlineKeyboardButton("❌ إلغاء", callback_data="menu_agent")],
            ]),
            parse_mode=ParseMode.MARKDOWN,
        )
    elif data == "agent_restart_confirm":
        r = await run_admin(["service", "restart", AGENT_SERVICE])
        return await query.edit_message_text(f"تمت إعادة تشغيل المتحكم:\n`{(r[1]+r[2]).strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # Self-update / doctor
    elif data == "update_status":
        code, out, err = await run_admin(["update", "status"], timeout=60)
        output = trim_output((out or err).strip() or "لا توجد حالة مسجلة", 3500)
        return await query.edit_message_text(f"**حالة التحديث** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "update_check":
        await query.edit_message_text("جار فحص التحديثات...")
        code, out, err = await run_admin(["update", "check"], timeout=120)
        output = trim_output((out or err).strip() or "لا توجد مخرجات", 3500)
        return await query.edit_message_text(f"**فحص التحديث** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "update_apply_confirm":
        return await query.edit_message_text(
            "تأكيد تطبيق التحديث الذاتي. سيتم أخذ نسخة احتياطية، التحقق من الصياغة، تطبيق الملفات، ثم إعادة تشغيل الخدمات عند الحاجة.",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🚀 تأكيد التحديث", callback_data="update_apply"),
                 InlineKeyboardButton("❌ إلغاء", callback_data="menu_update")],
            ]),
            parse_mode=ParseMode.MARKDOWN,
        )

    elif data == "update_apply":
        await query.edit_message_text("جار تطبيق التحديث الذاتي...")
        code, out, err = await run_admin(["update", "apply"], timeout=700)
        output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
        return await query.edit_message_text(f"**نتيجة التحديث** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "update_rollback_confirm":
        return await query.edit_message_text(
            "تأكيد الرجوع إلى آخر نسخة احتياطية للتحديث الذاتي.",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("↩️ تأكيد Rollback", callback_data="update_rollback"),
                 InlineKeyboardButton("❌ إلغاء", callback_data="menu_update")],
            ]),
            parse_mode=ParseMode.MARKDOWN,
        )

    elif data == "update_rollback":
        await query.edit_message_text("جار الرجوع إلى آخر نسخة احتياطية...")
        code, out, err = await run_admin(["update", "rollback"], timeout=700)
        output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
        return await query.edit_message_text(f"**نتيجة Rollback** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "doctor":
        await query.edit_message_text("جار تشغيل Doctor...")
        code, out, err = await run_admin(["doctor"], timeout=240)
        output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
        return await query.edit_message_text(f"**NOVA Doctor** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "health":
        await query.edit_message_text("جار توليد Health snapshot...")
        code, out, err = await run_admin(["health", "--write"], timeout=160)
        output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
        return await query.edit_message_text(f"**NOVA Health** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "config_validate":
        code, out, err = await run_admin(["config", "validate"], timeout=160)
        output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
        return await query.edit_message_text(f"**Config validate** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "backup_list":
        code, out, err = await run_admin(["backup", "list"], timeout=160)
        output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
        return await query.edit_message_text(f"**Backups** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # Quality / analyze
    elif data == "quality":
        await query.edit_message_text("Checking GitHub Actions status. Local build/test/lint is disabled on this server.", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_admin(["ci", "status", "--limit", "10"], timeout=60)
        output = trim_output((out or err).strip() or "No CI runs found.", 3500)
        text = (
            "**CI-backed quality status**\n"
            "Server mode: orchestrator-only. No local pnpm/npm/npx/vitest/tsc/eslint/build commands are run here.\n\n"
            f"```\n{output}\n```"
        )
        await query.edit_message_text(text, reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "analyze":
        script = SCRIPTS_DIR / "analyze.sh"
        if not script.exists():
            return await query.edit_message_text("ملف analyze.sh غير موجود.", reply_markup=research_keyboard())
        await query.edit_message_text("جار تشغيل تحليل المشروع...", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_argv(["bash", str(script)], timeout=120)
        output = out.strip()[:3500] or "لا توجد مخرجات للتحليل"
        await query.edit_message_text(f"**تحليل الكود**\n```\n{output}\n```", reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "audit":
        await query.edit_message_text("Checking CI audit/build runs. Local dependency audit is disabled on this server.", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_admin(["ci", "failed", "--limit", "10"], timeout=60)
        output = trim_output((out or err).strip() or "No failed CI runs found.", 3500)
        text = (
            "**CI audit/build status**\n"
            "Local pnpm audit/outdated is disabled on this server.\n"
            f"```\n{output}\n```"
        )
        await query.edit_message_text(text, reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "deps":
        await query.edit_message_text("Checking dependency-related CI status. Local pnpm commands are disabled.", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_admin(["ci", "status", "--limit", "10"], timeout=60)
        output = trim_output((out or err).strip() or "No CI runs found.", 3500)
        text = (
            "**Dependency CI status**\n"
            "Local dependency checks are delegated to GitHub Actions.\n"
            f"```\n{output}\n```"
        )
        await query.edit_message_text(text, reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # Status / log / server
    elif data == "server":
        await query.edit_message_text("جار جمع حالة السيرفر...")
        text = await build_server_status()
        await query.edit_message_text(text, reply_markup=server_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "status":
        code, snap, err = await admin_json(["system", "--format", "json"], timeout=120)
        if code != 0 and not snap:
            return await query.edit_message_text(f"تعذر جمع الحالة: `{trim_output(err, 1000)}`", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)
        await query.edit_message_text(format_snapshot_status(snap), reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "log_30":
        code, out, err = await run_admin(["logs", "controller", "30"], timeout=60)
        output = trim_output((out or err).strip() or "لا توجد مخرجات")
        await query.edit_message_text(f"**آخر 30 سطرا من السجل:**\n```\n{output}\n```", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "disk_info":
        _code, snap, err = await admin_json(["system", "--format", "json"], timeout=120)
        text = format_disk_snapshot(snap) if snap else f"تعذر جمع المساحة: `{trim_output(err, 1000)}`"
        return await query.edit_message_text(text, reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "proc_info":
        _code, snap, err = await admin_json(["system", "--format", "json", "--sort", "cpu"], timeout=120)
        text = format_process_snapshot(snap, "cpu") if snap else f"تعذر جمع العمليات: `{trim_output(err, 1000)}`"
        return await query.edit_message_text(text, reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "clean":
        await query.edit_message_text("جار تشغيل الصيانة...", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_admin(["maintenance"], timeout=700)
        output = trim_output(out.strip() or err.strip() or "تمت الصيانة", 3500)
        await query.edit_message_text(f"**اكتملت الصيانة** (exit: {code})\n```\n{output}\n```", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "tasks_list":
        return await query.edit_message_text(build_tasks_view(), reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # Plan
    elif data == "plan":
        plan_file = PROJECT_DIR / "Plan.md"
        if not plan_file.exists():
            return await query.edit_message_text("ملف Plan.md غير موجود.", reply_markup=plan_keyboard())
        content = plan_file.read_text()
        lines = content.split("\n")
        active_section, planned_section = [], []
        cur = None
        for line in lines:
            if "## Active Task" in line: cur = "active"; continue
            elif "## Planned Tasks" in line: cur = "planned"; continue
            elif line.startswith("## ") and cur: cur = None; continue
            if cur == "active": active_section.append(line)
            elif cur == "planned": planned_section.append(line)
        active_text = "\n".join(active_section).strip()[:1500] or "لا توجد مهمة نشطة"
        planned_text = "\n".join(planned_section).strip()[:1500] or "لا توجد مهام مخططة"
        text = f"**ملخص الخطة**\n\n**النشط:**\n```\n{active_text}\n```\n\n**المخطط:**\n```\n{planned_text}\n```"
        await query.edit_message_text(text, reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "plan_done":
        content = _plan_read()
        if not content:
            return await query.edit_message_text("ملف Plan.md غير موجود.", reply_markup=plan_keyboard())
        match = re.search(r"### (.+?)\n.*?Status:\s*`\[/\] IN_PROGRESS`", content, re.DOTALL)
        if not match:
            return await query.edit_message_text("لا توجد مهمة نشطة حاليا.", reply_markup=plan_keyboard())
        title = match.group(1).strip()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        content = re.sub(r"(Status:\s*`)\[/\] IN_PROGRESS(`)", r"\1[x] COMPLETED\2", content, count=1)
        content = re.sub(r"(- Completed: )pending", rf"\1{today}", content, count=1)
        _plan_write(content)
        await query.edit_message_text(f"تم إنهاء المهمة: **{title}**", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "plan_start_first":
        content = _plan_read()
        if not content:
            return await query.edit_message_text("ملف Plan.md غير موجود.", reply_markup=plan_keyboard())
        found = _plan_find_first_planned(content)
        if not found:
            return await query.edit_message_text("لا توجد مهمة مخططة.", reply_markup=plan_keyboard())
        start, end, block = found
        if "[ ] PLANNED" not in block:
            return await query.edit_message_text("المهمة المختارة ليست بحالة PLANNED.", reply_markup=plan_keyboard())
        new_block = block.replace("- Status: `[ ] PLANNED`", "- Status: `[/] IN_PROGRESS`")
        new_block = new_block.replace("- Started: pending", f"- Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
        lines = content.split("\n")
        lines = lines[:start] + new_block.split("\n") + lines[end:]
        _plan_write("\n".join(lines))
        title = block.split("\n")[0].strip()
        await query.edit_message_text(f"بدأت المهمة: **{title}**", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "plan_info_active":
        content = _plan_read()
        if not content:
            return await query.edit_message_text("ملف Plan.md غير موجود.", reply_markup=plan_keyboard())
        match = re.search(r"### (.+?)\n.*?Status:\s*`\[/\] IN_PROGRESS`", content, re.DOTALL)
        if not match:
            return await query.edit_message_text("لا توجد مهمة نشطة حاليا.", reply_markup=plan_keyboard())
        # Find full block of active task
        lines = content.split("\n")
        task_start = None
        for i, line in enumerate(lines):
            if line.strip().startswith("### ") and "Status:" in content[i:].split("\n")[1] if i+1 < len(lines) else "":
                if task_start is None and f"Status:" in lines[i]:
                    # Check next few lines for IN_PROGRESS
                    for j in range(i, min(i+10, len(lines))):
                        if "IN_PROGRESS" in lines[j]:
                            task_start = i
                            break
                if task_start is None:
                    continue
        if task_start is None:
            return await query.edit_message_text("تعذر تحديد كتلة المهمة النشطة.", reply_markup=plan_keyboard())
        # Find end of block
        task_starts = [i for i, line in enumerate(lines) if line.strip().startswith("### ") and not line.strip().startswith("####")]
        current_idx = task_starts.index(task_start)
        end = task_starts[current_idx + 1] if current_idx + 1 < len(task_starts) else len(lines)
        block = "\n".join(lines[task_start:end])
        await query.edit_message_text(f"**المهمة النشطة**\n```\n{block.strip()[:3000]}\n```", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # Reports
    elif data == "report":
        await query.edit_message_text("جار إعداد التقرير...", parse_mode=ParseMode.MARKDOWN)
        _code, snap, err = await admin_json(["system", "--format", "json"], timeout=120)
        text = format_report_snapshot(snap) if snap else f"تعذر إعداد التقرير: `{trim_output(err, 1000)}`"
        await query.edit_message_text(text, reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "ci_history":
        await query.edit_message_text("جار جلب سجل CI...", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_admin(["ci", "status", "--limit", "10"], timeout=60)
        output = trim_output((out or err).strip() or "لا توجد مخرجات", 3500)
        await query.edit_message_text(f"**سجل CI - آخر 10**\n```\n{output}\n```", reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "metrics":
        metrics_file = PROJECT_DIR / ".metrics.json"
        if not metrics_file.exists():
            return await query.edit_message_text("ملف metrics غير موجود.", reply_markup=reports_keyboard())
        try:
            data = json.loads(metrics_file.read_text())
            snaps = data.get("snapshots", [])
            if len(snaps) < 2:
                return await query.edit_message_text(f"نحتاج إلى لقطتين على الأقل. الموجود: {len(snaps)}", reply_markup=reports_keyboard())
            recent = snaps[-10:]
            lines = [f"**اتجاه المؤشرات - آخر {len(recent)} لقطات**\n"]
            lines.append(f"{'Time':<20} {'Cov%':<8} {'TS':<6} {'Tests':<8} {'Files':<6}")
            lines.append("-" * 50)
            for s in recent:
                t = s.get("timestamp", "?")[11:19]
                cov = s.get("coverage", "?")
                ts = s.get("ts_errors", "?")
                tests = f"{s.get('tests_pass',0)}/{s.get('test_count','?')}"
                files = s.get("file_count", "?")
                cov_s = f"{cov:.1f}" if isinstance(cov, float) else str(cov)
                lines.append(f"{t:<20} {cov_s:<8} {str(ts):<6} {tests:<8} {str(files):<6}")
            text = "```\n" + "\n".join(lines) + "\n```"
            await query.edit_message_text(text, reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)
        except Exception as e:
            await query.edit_message_text(f"خطأ: {e}", reply_markup=reports_keyboard())

    elif data == "coverage":
        metrics_file = PROJECT_DIR / ".metrics.json"
        if not metrics_file.exists():
            return await query.edit_message_text("ملف metrics غير موجود.", reply_markup=reports_keyboard())
        try:
            data = json.loads(metrics_file.read_text())
            snaps = data.get("snapshots", [])
            if not snaps:
                return await query.edit_message_text("لا توجد لقطات مؤشرات.", reply_markup=reports_keyboard())
            last = snaps[-1]
            text = (
                f"**التغطية والمؤشرات**\n\n"
                f"- Coverage: `{last.get('coverage','N/A')}%`\n"
                f"- TS Errors: `{last.get('ts_errors','?')}`\n"
                f"- ESLint: `{last.get('eslint_count','?')}`\n"
                f"- Tests: `{last.get('test_count','?')}` ({last.get('tests_pass',0)} نجح/{last.get('tests_fail',0)} فشل)\n"
                f"- Files: `{last.get('file_count','?')}`\n"
                f"- Dependencies: `{last.get('dependency_count','?')}`\n"
                f"- Snapshots: `{len(snaps)}`\n"
            )
            if len(snaps) >= 2:
                first = snaps[0]
                cov_diff = (last.get("coverage") or 0) - (first.get("coverage") or 0)
                text += f"- Trend: `{first.get('coverage','N/A')}%` إلى `{last.get('coverage','N/A')}%` ({'+' if cov_diff>=0 else ''}{cov_diff:.1f}%)\n"
            await query.edit_message_text(text, reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)
        except Exception as e:
            await query.edit_message_text(f"خطأ: {e}", reply_markup=reports_keyboard())

# Plan helpers
PLAN_FILE = PROJECT_DIR / "Plan.md"

def _plan_read() -> str:
    return PLAN_FILE.read_text() if PLAN_FILE.exists() else ""

def _plan_write(content: str):
    PLAN_FILE.write_text(content)

def _plan_find_task(content: str, title_keyword: str) -> tuple[int, int, str] | None:
    lines = content.split("\n")
    task_starts = [i for i, line in enumerate(lines) if line.strip().startswith("### ") and not line.strip().startswith("####")]
    for idx, start in enumerate(task_starts):
        title = lines[start].strip()
        if title_keyword.lower() in title.lower():
            end = task_starts[idx + 1] if idx + 1 < len(task_starts) else len(lines)
            while end > start and not lines[end - 1].strip(): end -= 1
            block = "\n".join(lines[start:end])
            return start, end, block
    return None

def _plan_find_first_planned(content: str) -> tuple[int, int, str] | None:
    lines = content.split("\n")
    in_planned = False
    task_start = None
    for i, line in enumerate(lines):
        if "## Planned Tasks" in line:
            in_planned = True
            continue
        if in_planned and line.strip().startswith("### "):
            task_start = i
            break
    if task_start is None:
        return None
    task_starts = [i for i, line in enumerate(lines) if line.strip().startswith("### ")]
    current_idx = task_starts.index(task_start)
    end = task_starts[current_idx + 1] if current_idx + 1 < len(task_starts) else len(lines)
    while end > task_start and not lines[end - 1].strip(): end -= 1
    block = "\n".join(lines[task_start:end])
    return task_start, end, block

# Command handlers
@restricted
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    text = (
        f"مرحبا {user.first_name}!\n"
        f"**NOVA Download Manager** لوحة تحكم الصيانة المستمرة.\n\n"
        f"صلاحيتك: `{role_label(update.effective_user.id if update.effective_user else None)}`\n"
        f"استخدم /register لتسجيل هذه المحادثة.\n"
        f"استخدم /server لعرض حالة السيرفر والخدمات.\n"
        f"اكتب أي رسالة بدون / لإرسالها إلى متحكم المشروع.\n\n"
        f"الأزرار السريعة ظاهرة أسفل المحادثة."
    )
    await update.message.reply_text(text, reply_markup=main_reply_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_register(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id
    if not OWNER_USER_IDS:
        await update.message.reply_text(
            "التسجيل معطل حتى تضبط NOVA_OWNER_IDS في /etc/nova/nova.env. "
            "استخدم /myid لمعرفة رقم المستخدم ثم أعد تشغيل nova-bot.service."
        )
        return
    if user_id not in OWNER_USER_IDS:
        await update.message.reply_text("غير مصرح: هذا المستخدم ليس ضمن NOVA_OWNER_IDS.")
        return
    chats = load_chats()
    if chat_id not in chats:
        chats.append(chat_id)
        save_chats(chats)
    await update.message.reply_text("تم تسجيل هذه المحادثة. الأزرار السريعة جاهزة:", reply_markup=main_reply_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_unregister(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    chats = load_chats()
    if chat_id in chats:
        chats.remove(chat_id)
        save_chats(chats)
    await update.message.reply_text("تم إلغاء التسجيل.")

@restricted
async def cmd_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_menu(update)

@restricted
async def cmd_myid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await update.message.reply_text(
        f"**المعرّف**\nالاسم: `{user.first_name}`\nرقم المستخدم: `{user.id}`\nاسم المستخدم: @{user.username or 'غير متوفر'}",
        parse_mode=ParseMode.MARKDOWN,
    )

@restricted
async def cmd_notif(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show notification settings."""
    chat_id = update.effective_chat.id
    await update.message.reply_text("**التنبيهات** - اختر الإعدادات:", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)

@restricted
@role_required("owner")
async def cmd_exec(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not EXEC_ENABLED:
        await update.message.reply_text(
            "أمر /exec معطل افتراضياً لأسباب أمنية. "
            "فعّله فقط عند الحاجة عبر NOVA_ENABLE_EXEC=1 وحدد NOVA_EXEC_ALLOWLIST."
        )
        return
    if not context.args:
        await update.message.reply_text("الاستخدام: /exec <command>")
        return
    command = " ".join(context.args)
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        await update.message.reply_text(f"صياغة الأمر غير صالحة: {exc}")
        return
    if not argv:
        await update.message.reply_text("الاستخدام: /exec <command>")
        return
    program = Path(argv[0]).name
    if program not in EXEC_ALLOWLIST:
        await update.message.reply_text(f"الأمر `{program}` غير مسموح في NOVA_EXEC_ALLOWLIST.", parse_mode=ParseMode.MARKDOWN)
        return
    msg = await update.message.reply_text(f"جار التنفيذ:\n`{command}`", parse_mode=ParseMode.MARKDOWN)
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(PROJECT_DIR))
    chat_id = update.effective_chat.id
    running_execs[chat_id] = proc
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        out = stdout.decode(errors="replace")
        err = stderr.decode(errors="replace")
        output = out + ("\nخطأ:\n" + err if err else "")
        output = trim_output(output.strip() or "تم التنفيذ بدون مخرجات")
        await msg.edit_text(f"**exit code:** {proc.returncode}\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)
    except asyncio.TimeoutError:
        proc.kill(); await proc.wait()
        await msg.edit_text("انتهت مهلة التنفيذ (120s)")
    finally:
        running_execs.pop(chat_id, None)

@restricted
async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    if chat_id in running_execs:
        running_execs[chat_id].kill()
        await update.message.reply_text("تم إلغاء التنفيذ.")
    else:
        await update.message.reply_text("لا يوجد تنفيذ نشط حاليا.")

@restricted
async def cmd_plan_add(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args) if context.args else ""
    if not text or "|" not in text:
        return await update.message.reply_text("الاستخدام: `/plan_add Title | Description | priority`", parse_mode=ParseMode.MARKDOWN)
    parts = [p.strip() for p in text.split("|")]
    title = parts[0]
    desc = parts[1] if len(parts) > 1 else "مهمة"
    priority = parts[2] if len(parts) > 2 else "medium"
    task_id = title.lower().replace(" ", "-")[:30]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    new_task = f"""
### {title}

- Status: `[ ] PLANNED`
- Priority: {priority}
- Type: task
- Source branch: `develop`
- Work branch: `codex/{task_id}`
- Target branch: `develop`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - install: pending
  - lint: pending
  - typecheck: pending
  - test: pending
  - build: pending
  - audit: pending
- Objective:
  - {desc}
- Plan:
  1. {desc}
- Notes:
  - Added via Telegram interface on {today}
"""
    content = _plan_read()
    if not content:
        return await update.message.reply_text("ملف Plan.md غير موجود.")
    insert_before = "## Completed Tasks"
    replace_with = f"## Planned Tasks\n\n{new_task.strip()}\n\n## Completed Tasks"
    if insert_before in content:
        content = content.replace(insert_before, replace_with, 1)
    else:
        planned_marker = "## Planned Tasks"
        if planned_marker in content:
            content = content.replace(planned_marker, f"{planned_marker}\n\n{new_task.strip()}", 1)
        else:
            content += f"\n\n## Planned Tasks\n\n{new_task.strip()}\n"
    _plan_write(content)
    await update.message.reply_text(f"تمت إضافة المهمة: **{title}**", reply_markup=main_menu_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_plan_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("الاستخدام: `/plan_start keyword`", parse_mode=ParseMode.MARKDOWN)
    keyword = " ".join(context.args)
    content = _plan_read()
    if not content:
        return await update.message.reply_text("ملف Plan.md غير موجود.")
    found = _plan_find_task(content, keyword)
    if not found:
        return await update.message.reply_text(f"لم أجد مهمة تطابق `{keyword}`", parse_mode=ParseMode.MARKDOWN)
    start, end, block = found
    if "[ ] PLANNED" not in block:
        return await update.message.reply_text("المهمة ليست بحالة PLANNED.")
    new_block = block.replace("- Status: `[ ] PLANNED`", "- Status: `[/] IN_PROGRESS`")
    new_block = new_block.replace("- Started: pending", f"- Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
    lines = content.split("\n")
    lines = lines[:start] + new_block.split("\n") + lines[end:]
    _plan_write("\n".join(lines))
    await update.message.reply_text(f"بدأت المهمة:\n`{block.split(chr(10))[0].strip()}`", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_plan_block(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args) if context.args else ""
    if not text:
        return await update.message.reply_text("الاستخدام: `/plan_block keyword | reason`", parse_mode=ParseMode.MARKDOWN)
    parts = [p.strip() for p in text.split("|", 1)]
    keyword = parts[0]
    reason = parts[1] if len(parts) > 1 else "blocked"
    content = _plan_read()
    if not content:
        return await update.message.reply_text("ملف Plan.md غير موجود.")
    found = _plan_find_task(content, keyword)
    if not found:
        return await update.message.reply_text(f"لم أجد مهمة تطابق `{keyword}`", parse_mode=ParseMode.MARKDOWN)
    start, end, block = found
    new_block = re.sub(r"Status:\s*`\[/?\]\s*\w+`", "- Status: `[!] BLOCKED`", block)
    if "Notes:" in new_block:
        new_block = new_block.replace("Notes:", f"Notes:\n  - Blocked: {reason}")
    else:
        new_block += f"\n- Notes:\n  - Blocked: {reason}"
    lines = content.split("\n")
    lines = lines[:start] + new_block.split("\n") + lines[end:]
    _plan_write("\n".join(lines))
    await update.message.reply_text(f"تم حظر المهمة: **{keyword.strip('#')}**\nالسبب: {reason}", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_plan_delete(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("الاستخدام: /plan_delete <keyword>")
    keyword = " ".join(context.args)
    content = _plan_read()
    if not content:
        return await update.message.reply_text("ملف Plan.md غير موجود.")
    found = _plan_find_task(content, keyword)
    if not found:
        return await update.message.reply_text(f"لم أجد مهمة تطابق `{keyword}`", parse_mode=ParseMode.MARKDOWN)
    start, end, block = found
    lines = content.split("\n")
    new_lines = lines[:start] + lines[end:]
    _plan_write("\n".join(new_lines))
    await update.message.reply_text(f"تم حذف المهمة:\n`{block.split(chr(10))[0].strip()}`", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_git(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("الاستخدام: /git <status|log|diff|show|branch|rev-parse|remote|ls-files|grep> [args]")
    subcommand = context.args[0]
    allowed = {"status", "log", "diff", "show", "branch", "rev-parse", "remote", "ls-files", "grep"}
    if subcommand not in allowed or subcommand.startswith("-"):
        return await update.message.reply_text("هذا الأمر غير مسموح عبر /git. استخدم أوامر Git القراءة فقط.")
    result = await run_argv(["git", *context.args], timeout=30)
    output = result[1] + ("\nخطأ:\n" + result[2] if result[2] else "")
    output = trim_output(output.strip() or "لا توجد مخرجات")
    await update.message.reply_text(f"```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
@role_required("operator")
async def cmd_opencode(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("الاستخدام: /opencode <prompt>")
    prompt = " ".join(context.args)
    msg = await update.message.reply_text(f"جار إرسال الطلب إلى محرك الصيانة...\n\n`{prompt[:200]}{'...' if len(prompt)>200 else ''}`", parse_mode=ParseMode.MARKDOWN)
    try:
        code, out, err = await run_argv([OPENCODE_BIN, "run", "--model", MODEL, "--auto", prompt], timeout=600, cwd=str(PROJECT_DIR))
        output = (out.strip() or err.strip())[:3000] or "لا توجد مخرجات"
        await msg.edit_text(f"**نتيجة opencode** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)
    except Exception as e:
        await msg.edit_text(f"خطأ: {e}")

# Server status
# Logs viewer
@restricted
async def cmd_logs(update: Update, context: ContextTypes.DEFAULT_TYPE):
    n = 30
    if context.args and context.args[0].isdigit():
        n = min(int(context.args[0]), 200)
    sources = {
        "controller": str(LOG_DIR / "nova-dev-agent.log"),
        "telegram": str(LOG_DIR / "nova-bot.log"),
        "watchdog": str(LOG_DIR / "nova-watchdog.log"),
        "maintenance": str(LOG_DIR / "nova-maintenance.log"),
    }
    source = "controller"
    if context.args and context.args[-1] in sources:
        source = context.args[-1]
        if context.args[0].isdigit() and len(context.args) > 1:
            n = min(int(context.args[0]), 200)
    code, out, err = await run_admin(["logs", source, str(n)], timeout=60)
    text = trim_output((out or err).strip() or "لا توجد مخرجات", 3500)
    await update.message.reply_text(f"**سجل {source} - آخر {n}**\n```\n{text}\n```", parse_mode=ParseMode.MARKDOWN)

# Service manager
@restricted
async def cmd_svc(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Manage NOVA services through the root-owned allowlisted admin boundary."""
    if not context.args:
        code, out, err = await run_admin(["services"], timeout=90)
        text = trim_output((out or err).strip() or "لا توجد مخرجات", 3500)
        return await update.message.reply_text(f"**خدمات NOVA** (exit: {code})\n```\n{text}\n```", parse_mode=ParseMode.MARKDOWN)
    name = context.args[0]
    action = context.args[1] if len(context.args) > 1 else "status"
    required = "operator" if action in {"start", "stop", "restart", "enable", "disable"} else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: إجراء service {action} يتطلب {required}.")
    code, out, err = await run_admin(["service", action, name], timeout=90)
    text = trim_output((out or err).strip() or "لا توجد مخرجات", 3500)
    await update.message.reply_text(f"**{action} {name}** (exit: {code})\n```\n{text}\n```", parse_mode=ParseMode.MARKDOWN)

# Disk usage
@restricted
async def cmd_disk(update: Update, context: ContextTypes.DEFAULT_TYPE):
    _code, snap, err = await admin_json(["system", "--format", "json"], timeout=120)
    text = format_disk_snapshot(snap) if snap else f"تعذر جمع المساحة: `{trim_output(err, 1000)}`"
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)

# Process list
@restricted
async def cmd_proc(update: Update, context: ContextTypes.DEFAULT_TYPE):
    sort = context.args[0] if context.args and context.args[0] in ("cpu", "mem", "pid") else "cpu"
    _code, snap, err = await admin_json(["system", "--format", "json", "--sort", sort], timeout=120)
    text = format_process_snapshot(snap, sort) if snap else f"تعذر جمع العمليات: `{trim_output(err, 1000)}`"
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)

# Controlled reload/update
@restricted
@role_required("owner")
async def cmd_reload(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Apply the controlled self-update path instead of raw git pull/restart."""
    msg = await update.message.reply_text("جار تطبيق التحديث الذاتي المراقب...")
    code, out, err = await run_admin(["update", "apply"], timeout=700)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**نتيجة التحديث/إعادة التحميل** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

async def build_server_status() -> str:
    """Build comprehensive server status report through nova-admin/nova-system."""
    code, snap, err = await admin_json(["system", "--format", "json"], timeout=120)
    if code != 0 and not snap:
        return f"**حالة السيرفر**\nتعذر جمع الحالة: `{trim_output(err, 1000)}`"
    system = snap.get("system") or {}
    mem = system.get("memory") or {}
    disk = ((system.get("disk") or {}).get("root") or {})
    load = system.get("load") or {}
    uptime = system.get("uptime") or {}
    rx, tx = first_net(snap)
    git = snap.get("git") or {}
    top_cpu = "\n".join(((snap.get("processes") or {}).get("cpu") or [])[:6]) or "N/A"
    top_mem = "\n".join(((snap.get("processes") or {}).get("mem") or [])[:6]) or "N/A"
    st = read_agent_state()
    last_cycle = st.get("cycle", "N/A") if st else "N/A"
    cycle_duration = ""
    if st:
        cycle_duration = f" · {_phase_ar(st.get('phase', ''))} · {STATUS_AR.get(st.get('status', ''), st.get('status', ''))}"
    return (
        f"**حالة السيرفر**\n\n"
        f"**CPU**\n"
        f"- Usage: `{system.get('cpu_percent', '?')}%`\n"
        f"- Load: `{load.get('1m', '?')}/{load.get('5m', '?')}/{load.get('15m', '?')}` | Procs: `{load.get('processes', '?')}`\n\n"
        f"**Memory**\n"
        f"- RAM: `{human_bytes(mem.get('used'))}` / `{human_bytes(mem.get('total'))}` ({mem.get('used_percent', '?')}%)\n"
        f"- Avail: `{human_bytes(mem.get('available'))}` | Swap: `{human_bytes(mem.get('swap_used'))}` / `{human_bytes(mem.get('swap_total'))}` ({mem.get('swap_used_percent', '?')}%)\n\n"
        f"**Disk**\n"
        f"- `/`: `{human_bytes(disk.get('used'))}` / `{human_bytes(disk.get('total'))}` ({disk.get('used_percent', '?')}%) | Free: `{human_bytes(disk.get('free'))}`\n\n"
        f"**System**\n"
        f"- Uptime: `{uptime.get('label', '?')}`\n"
        f"- Net RX: `{rx}` | TX: `{tx}`\n"
        f"- pnpm: `disabled on server`\n\n"
        f"**خدمات NOVA**\n"
        f"- Controller: {format_status(svc_status(snap, 'nova-dev-agent.service'))}\n"
        f"- Telegram: {format_status(svc_status(snap, 'nova-bot.service'))}\n"
        f"- Maintenance: {format_status(svc_status(snap, 'nova-maintenance.timer'))}\n"
        f"- Watchdog: {format_status(svc_status(snap, 'nova-watchdog.timer'))}\n\n"
        f"**دورة المتحكم**\n"
        f"- Last: `{last_cycle}`{cycle_duration}\n\n"
        f"**Git**\n"
        f"- Branch: `{git.get('branch') or '?'}`\n"
        f"- HEAD: `{git.get('head') or '?'}`\n"
        f"- Ahead: `{git.get('ahead_remote_count', 0)}` | Behind: `{git.get('behind_remote_count', 0)}` | Dirty: `{git.get('dirty_paths', '?')}`\n\n"
        f"**أعلى CPU**\n```\n{trim_output(top_cpu, 500)}\n```\n"
        f"**أعلى MEM**\n```\n{trim_output(top_mem, 500)}\n```"
    )

@restricted
async def cmd_server(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("جار جمع حالة السيرفر...")
    text = await build_server_status()
    await msg.edit_text(text, reply_markup=server_keyboard(), parse_mode=ParseMode.MARKDOWN)

# Direct chat with project controller
# Any non-command message is sent directly to the maintenance engine.
CHAT_CONTEXT: dict[int, list[dict]] = {}  # chat_id -> [{"role","content"}]

@restricted
async def cmd_chat(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "**الدردشة المباشرة**: اكتب أي رسالة بدون / لإرسالها إلى متحكم المشروع.\n"
        "استخدم `/menu` لإظهار القوائم.\n"
        "استخدم `/reset` لمسح سياق المحادثة.",
        parse_mode=ParseMode.MARKDOWN,
    )

@restricted
async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    CHAT_CONTEXT.pop(chat_id, None)
    await update.message.reply_text("تم مسح سياق المحادثة. يمكنك البدء من جديد.")

async def run_opencode_prompt(prompt: str, chat_history: list[dict] | None = None) -> str:
    """Run opencode with a prompt and return the output."""
    context_prompt = prompt
    if chat_history:
        # Build context summary from last few exchanges
        recent = chat_history[-6:]
        context_lines = ["Here is our conversation so far (recent history):"]
        for msg in recent:
            role = "User" if msg["role"] == "user" else "Project"
            content = msg["content"][:200]
            context_lines.append(f"{role}: {content}")
        context_lines.append("")
        context_lines.append(f"Current user message: {prompt}")
        context_prompt = "\n".join(context_lines)

    full_prompt = (
        "You are the continuous development and release manager for the NOVA Download Manager project.\n"
        "You are talking directly with the user via Telegram. Respond helpfully and concisely.\n"
        "This server is orchestrator-only: read/write files, use git and gh, inspect CI logs, and make changes.\n"
        f"Project directory: {PROJECT_DIR}\n"
        "Allowed local command families: git, gh CLI, rg/grep/sed/awk, file inspection, and lightweight shell utilities.\n"
        "FORBIDDEN locally on this server: pnpm, npm, npx, yarn, vitest, eslint, tsc, vite build, tauri, cargo build/test/check, "
        "Playwright, coverage, release, bundle, packaging, or any build/test/lint/install command.\n"
        "Validation must be done through GitHub Actions. Use gh to inspect runs/logs, then fix and push.\n\n"
        "Use neutral project-maintenance language. Do not describe the maintainer identity in commits, PRs, issues, comments, release notes, documentation, logs, or generated files.\n\n"
        "IMPORTANT: Keep responses under 3000 characters. "
        "When you make code changes, commit and push them. "
        "Update Plan.md status as needed.\n\n"
        f"User message: {context_prompt}"
    )

    try:
        code, out, err = await run_argv(
            [OPENCODE_BIN, "run", "--model", MODEL, "--auto", full_prompt],
            timeout=300,
            cwd=str(PROJECT_DIR),
            env={"PATH": f"{Path(OPENCODE_BIN).parent}:{os.environ.get('PATH', '')}"},
        )
        output = out.strip()[:3000] or "تم التنفيذ بدون مخرجات"
        if err:
            output += f"\nخطأ:\n{err.strip()[:500]}"
        return output
    except asyncio.TimeoutError:
        return "انتهت مهلة معالجة الطلب (300s). حاول تقسيم الطلب أو إعادة الإرسال."
    except Exception as e:
        return f"خطأ: {e}"

async def handle_direct_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle non-command text: reply keyboard navigation or direct chat."""
    if not update.message or not update.message.text:
        return

    chat_id = update.effective_chat.id
    user_text = update.message.text.strip()

    # Auth check
    allowed = load_chats()
    if allowed and chat_id not in allowed:
        await update.message.reply_text("غير مصرح لهذه المحادثة. استخدم /register للتسجيل.")
        return

    if not user_text:
        return

    # Roadmap shortcut from the reply keyboard.
    if user_text in ("المهام", "قائمة المهام"):
        await update.message.reply_text(build_tasks_view(), reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)
        return

    # Check pending confirmation.
    if chat_id in pending_confirm:
        action, prompt, ctx = pending_confirm.pop(chat_id)
        if user_text.lower() in ["تأكيد", "yes", "y", "نعم", "ok"]:
            await handle_confirmed_action(update, context, action, ctx)
        else:
            await update.message.reply_text("تم إلغاء العملية.", reply_markup=main_reply_keyboard())
        return

    # Check reply keyboard navigation.
    if user_text in REPLY_ACTIONS:
        data = REPLY_ACTIONS[user_text]
        menu_texts = {
            "menu_system": ("**النظام** - اختر إجراء:", system_keyboard()),
            "menu_agent": ("**المتحكم** - أوامر التشغيل:", agent_keyboard()),
            "menu_plan": ("**الخطة** - إدارة Plan.md:", plan_keyboard()),
            "menu_research": ("**الفحص والتحليل**:", research_keyboard()),
            "menu_reports": ("**التقارير**:", reports_keyboard()),
            "menu_settings": ("**الإعدادات**:", settings_keyboard()),
            "menu_update": ("**التحديث الذاتي** — فحص، تطبيق، أو رجوع آمن.", update_keyboard()),
            "notif_menu": ("**إعدادات التنبيهات** - اختر المستوى ونوع التنبيه:", notif_menu_keyboard(chat_id)),
        }
        if data == "menu_main":
            await send_menu(update)
        elif data in menu_texts:
            text, kb = menu_texts[data]
            await update.message.reply_text(text, reply_markup=kb, parse_mode=ParseMode.MARKDOWN)
        elif data == "doctor":
            if not has_role(update.effective_user.id, "operator"):
                return await update.message.reply_text("غير مصرح: Doctor يتطلب operator.")
            code, out, err = await run_admin(["doctor"], timeout=240)
            output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
            await update.message.reply_text(f"**NOVA Doctor** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)
        return

    # Check direct action buttons.
    if user_text in REPLY_DIRECT:
        label, action = REPLY_DIRECT[user_text]
        if action == "log_30":
            code, out, err = await run_admin(["logs", "controller", "30"], timeout=60)
            text = trim_output((out or err).strip() or "لا توجد مخرجات", 3500)
            await update.message.reply_text(f"**آخر 30 سطرا من السجل**\n```\n{text}\n```", parse_mode=ParseMode.MARKDOWN)
        elif action == "disk_info":
            _code, snap, err = await admin_json(["system", "--format", "json"], timeout=120)
            text = format_disk_snapshot(snap) if snap else f"تعذر جمع المساحة: `{trim_output(err, 1000)}`"
            await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)
        elif action == "proc_info":
            _code, snap, err = await admin_json(["system", "--format", "json", "--sort", "cpu"], timeout=120)
            text = format_process_snapshot(snap, "cpu") if snap else f"تعذر جمع العمليات: `{trim_output(err, 1000)}`"
            await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)
        return

    # Otherwise: send to controller. This can cause repository changes through the
    # development engine, so it requires operator privileges.
    if not has_role(update.effective_user.id, "operator"):
        return await update.message.reply_text("غير مصرح: إرسال طلبات مباشرة إلى المتحكم يتطلب صلاحية operator.")

    if chat_id not in CHAT_CONTEXT:
        CHAT_CONTEXT[chat_id] = []

    CHAT_CONTEXT[chat_id].append({"role": "user", "content": user_text})

    msg = await update.message.reply_text(
        f"**NOVA** استلمت الطلب:\n`{user_text[:200]}{'...' if len(user_text) > 200 else ''}`\n\nجار المعالجة...",
        parse_mode=ParseMode.MARKDOWN,
    )

    try:
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")
    except Exception:
        pass

    output = await run_opencode_prompt(user_text, CHAT_CONTEXT[chat_id])

    CHAT_CONTEXT[chat_id].append({"role": "project", "content": output})
    if len(CHAT_CONTEXT[chat_id]) > 20:
        CHAT_CONTEXT[chat_id] = CHAT_CONTEXT[chat_id][-20:]

    is_code = any(m in output for m in ["```", "exit:", "خطأ", "Traceback", "Exception"])
    full = f"**NOVA:**\n```\n{output}\n```" if is_code else f"**NOVA:**\n{output}"

    try:
        await msg.edit_text(full)
    except Exception:
        await update.message.reply_text(full)

# Confirmation system
async def confirm_action(update: Update, action: str, prompt: str, ctx: dict):
    """Ask user to confirm a destructive action."""
    chat_id = update.effective_chat.id
    pending_confirm[chat_id] = (action, prompt, ctx)
    await update.message.reply_text(
        f"تأكيد مطلوب: {prompt}\n\nاكتب `تأكيد` للمتابعة أو أي نص آخر للإلغاء.",
        reply_markup=main_reply_keyboard(),
        parse_mode=ParseMode.MARKDOWN,
    )

async def handle_confirmed_action(update: Update, context: ContextTypes.DEFAULT_TYPE, action: str, ctx: dict):
    """Execute a confirmed action."""
    msg = await update.message.reply_text("جار تنفيذ العملية...")
    if action == "agent_stop":
        r = await run_admin(["service", "stop", AGENT_SERVICE])
        await msg.edit_text(f"Controller: `{r[1].strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif action == "agent_restart":
        r = await run_admin(["service", "restart", AGENT_SERVICE])
        await msg.edit_text(f"Controller: `{r[1].strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif action == "plan_delete":
        keyword = ctx.get("keyword", "")
        content = _plan_read()
        found = _plan_find_task(content, keyword)
        if found:
            start, end, block = found
            lines = content.split("\n")
            new = lines[:start] + lines[end:]
            _plan_write("\n".join(new))
            title = block.split("\n")[0].strip()
            await msg.edit_text(f"تم حذف المهمة: `{title}`", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)
        else:
            await msg.edit_text("لم يتم العثور على المهمة.", reply_markup=plan_keyboard())
    elif action == "git_reset":
        await msg.edit_text("إجراء git_reset الخام معطل. استخدم /update apply عبر nova-admin.", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)
    else:
        await msg.edit_text("إجراء غير معروف.", reply_markup=main_menu_keyboard())

# /set_freq command
@restricted
async def set_freq_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    if not context.args:
        opts = " | ".join(f"{f}={FREQ_LABELS[f]}" for f in FREQ_LEVELS)
        return await update.message.reply_text(f"**مستوى التنبيهات**\nالخيارات:\n{opts}\n\nمثال: `/set_freq important`", parse_mode=ParseMode.MARKDOWN)
    freq = context.args[0].lower()
    if freq not in FREQ_LEVELS:
        return await update.message.reply_text(f"مستوى غير معروف. الخيارات: {', '.join(FREQ_LEVELS)}")
    set_chat_freq(chat_id, freq)
    await update.message.reply_text(f"تم ضبط مستوى التنبيهات: {FREQ_LABELS[freq]}")

# Broadcast command
@restricted
@role_required("owner")
async def cmd_broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("الاستخدام: /broadcast <message>\nأو /broadcast <type> <message>")
    notif_type = "system"
    msg_parts = " ".join(context.args)
    if context.args[0] in NOTIF_TYPES:
        notif_type = context.args[0]
        msg_parts = " ".join(context.args[1:]) if len(context.args) > 1 else ""
    if not msg_parts:
        return await update.message.reply_text("نص الرسالة مطلوب")
    await broadcast_message(f"**تنبيه**: {msg_parts}", notif_type)
    await update.message.reply_text(f"تم إرسال البث (type: {notif_type})")

@restricted
async def cmd_update(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "check", "apply", "rollback", "history"}:
        return await update.message.reply_text("الاستخدام: /update [status|check|history|apply|rollback]")
    required = "owner" if action in {"apply", "rollback"} else "operator" if action == "check" else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: update {action} يتطلب {required}.")
    msg = await update.message.reply_text(f"جار تنفيذ update {action}...")
    code, out, err = await run_admin(["update", action], timeout=700)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**update {action}** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
@role_required("owner")
async def cmd_rollback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("جار تنفيذ rollback إلى آخر نسخة احتياطية...")
    code, out, err = await run_admin(["update", "rollback"], timeout=700)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**rollback** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
@role_required("operator")
async def cmd_doctor(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("جار تشغيل Doctor...")
    code, out, err = await run_admin(["doctor"], timeout=240)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**NOVA Doctor** (exit: {code})\n```\n{output}\n```", reply_markup=update_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_health(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("جار توليد health snapshot...")
    code, out, err = await run_admin(["health", "--write"], timeout=160)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**NOVA Health** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_config(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "validate"
    if action not in {"validate", "safe", "diff"}:
        return await update.message.reply_text("الاستخدام: /config [validate|safe|diff]")
    required = "owner" if action == "diff" else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: config {action} يتطلب {required}.")
    msg = await update.message.reply_text(f"جار تنفيذ config {action}...")
    code, out, err = await run_admin(["config", action], timeout=160)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**config {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_backup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "list"
    if action not in {"create", "list", "inspect", "restore", "prune"}:
        return await update.message.reply_text("الاستخدام: /backup [create|list|inspect|restore|prune] [backup]")
    required = "owner" if action in {"create", "restore", "prune"} else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: backup {action} يتطلب {required}.")
    cmd = ["backup", action]
    if len(context.args) > 1:
        cmd.append(" ".join(context.args[1:]))
    msg = await update.message.reply_text(f"جار تنفيذ backup {action}...")
    code, out, err = await run_admin(cmd, timeout=900)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**backup {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_ci(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "failed", "prs", "release"}:
        return await update.message.reply_text("الاستخدام: /ci [status|failed|prs|release]")
    msg = await update.message.reply_text(f"جار تنفيذ ci {action}...")
    code, out, err = await run_admin(["ci", action], timeout=160)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**ci {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_release(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "validate"
    if action not in {"validate", "manifest", "package", "checksum", "changelog"}:
        return await update.message.reply_text("الاستخدام: /release [validate|manifest|package|checksum|changelog]")
    required = "owner" if action in {"manifest", "package", "changelog"} else "operator"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: release {action} يتطلب {required}.")
    msg = await update.message.reply_text(f"جار تنفيذ release {action}...")
    code, out, err = await run_admin(["release", action], timeout=900)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**release {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)


@restricted
@role_required("operator")
async def cmd_certify(update: Update, context: ContextTypes.DEFAULT_TYPE):
    include_backup = bool(context.args and context.args[0] in {"--include-backup", "backup"})
    args = ["certify", "--json"]
    if include_backup:
        if not has_role(update.effective_user.id, "owner"):
            return await update.message.reply_text("غير مصرح: runtime certification مع backup يتطلب owner.")
        args.append("--include-backup")
    msg = await update.message.reply_text("جار تشغيل runtime certification...")
    code, out, err = await run_admin(args, timeout=520)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**runtime certification** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
@role_required("operator")
async def cmd_acceptance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("جار تنفيذ acceptance matrix...")
    code, out, err = await run_admin(["acceptance", "--json"], timeout=900)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**acceptance** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)


@restricted
async def cmd_queue(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "list"
    if action not in {"list", "stats", "next", "show", "cancel", "requeue", "reap-stale"}:
        return await update.message.reply_text("الاستخدام: /queue [list|stats|next|show|cancel|requeue|reap-stale] [job_id]")
    required = "operator" if action in {"cancel", "requeue", "reap-stale"} else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: queue {action} يتطلب {required}.")
    args = ["queue", action]
    if action in {"show", "cancel", "requeue"}:
        if len(context.args) < 2:
            return await update.message.reply_text("يلزم job_id.")
        args.append(context.args[1])
    msg = await update.message.reply_text(f"جار تنفيذ queue {action}...")
    code, out, err = await run_admin(args, timeout=180)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**queue {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_lease(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "due", "clean", "release"}:
        return await update.message.reply_text("الاستخدام: /lease [status|due|clean|release] [lease_id]")
    required = "operator" if action in {"clean", "release"} else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: lease {action} يتطلب {required}.")
    args = ["lease", action]
    if action == "release":
        if len(context.args) < 2:
            return await update.message.reply_text("يلزم lease_id.")
        args.append(context.args[1])
    msg = await update.message.reply_text(f"جار تنفيذ lease {action}...")
    code, out, err = await run_admin(args, timeout=120)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**lease {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
@role_required("operator")
async def cmd_dispatcher(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "dispatch-one", "dispatch-loop"}:
        return await update.message.reply_text("الاستخدام: /dispatcher [status|dispatch-one|dispatch-loop]")
    args = ["dispatcher", action]
    if action == "dispatch-loop":
        args.extend(["--limit", "3"])
    msg = await update.message.reply_text(f"جار تنفيذ dispatcher {action}...")
    code, out, err = await run_admin(args, timeout=900)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**dispatcher {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)


@restricted
async def cmd_branch_policy(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "ensure", "validate-branch", "guard-push", "target-for", "branch-name"}:
        return await update.message.reply_text("الاستخدام: /branch_policy [status|ensure|validate-branch|guard-push|target-for|branch-name] ...")
    required = "owner" if action == "ensure" else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: branch-policy {action} يتطلب {required}.")
    args = ["branch-policy", action]
    if action in {"validate-branch", "guard-push", "target-for"}:
        if len(context.args) < 2:
            return await update.message.reply_text("يلزم اسم الفرع أو نوع المهمة.")
        args.append(context.args[1])
    elif action == "branch-name":
        title = " ".join(context.args[1:]) if len(context.args) > 1 else "task"
        args.extend(["--title", title])
    msg = await update.message.reply_text(f"جار تنفيذ branch-policy {action}...")
    code, out, err = await run_admin(args, timeout=240)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**branch-policy {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
@role_required("operator")
async def cmd_github_worker(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "ensure-workflow", "dispatch"}:
        return await update.message.reply_text("الاستخدام: /github_worker [status|ensure-workflow|dispatch]")
    required = "owner" if action in {"ensure-workflow", "dispatch"} else "operator"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: github-worker {action} يتطلب {required}.")
    args = ["github-worker", action]
    if action == "dispatch" and len(context.args) > 1:
        args.extend(["--task", " ".join(context.args[1:])])
    msg = await update.message.reply_text(f"جار تنفيذ github-worker {action}...")
    code, out, err = await run_admin(args, timeout=900)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**github-worker {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_train(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "cut", "promote", "rollback", "freeze", "unfreeze"}:
        return await update.message.reply_text("الاستخدام: /train [status|cut|promote|rollback|freeze|unfreeze] ...")
    required = "owner" if action in {"cut", "promote", "rollback", "freeze", "unfreeze"} else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: release train {action} يتطلب {required}.")
    args = ["release-train", action]
    if action in {"cut", "promote"}:
        if len(context.args) < 3:
            return await update.message.reply_text("الاستخدام: /train cut alpha 1.2.3 أو /train promote beta 1.2.3")
        args.extend([context.args[1], context.args[2]])
    elif action == "rollback":
        if len(context.args) < 2:
            return await update.message.reply_text("الاستخدام: /train rollback stable")
        args.append(context.args[1])
    msg = await update.message.reply_text(f"جار تنفيذ release train {action}...")
    code, out, err = await run_admin(args, timeout=300)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**release train {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_emergency(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "check", "restart-unhealthy"}:
        return await update.message.reply_text("الاستخدام: /emergency [status|check|restart-unhealthy]")
    required = "operator" if action != "status" else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: emergency {action} يتطلب {required}.")
    args = ["emergency", action]
    if action == "check" and "--reboot" in context.args:
        if not has_role(update.effective_user.id, "owner"):
            return await update.message.reply_text("غير مصرح: emergency reboot يتطلب owner.")
        args.append("--reboot")
    msg = await update.message.reply_text(f"جار تنفيذ emergency {action}...")
    code, out, err = await run_admin(args, timeout=180)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**emergency {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_roadmap(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "ideas"
    if action not in {"ideas", "enqueue"}:
        return await update.message.reply_text("الاستخدام: /roadmap [ideas|enqueue]")
    required = "operator" if action == "enqueue" else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: roadmap {action} يتطلب {required}.")
    args = ["roadmap", action, "--limit", "5"]
    msg = await update.message.reply_text(f"جار تنفيذ roadmap {action}...")
    code, out, err = await run_admin(args, timeout=180)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**roadmap {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_orchestrator(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "status"
    if action not in {"status", "cycle"}:
        return await update.message.reply_text("الاستخدام: /orchestrator [status|cycle]")
    required = "operator" if action == "cycle" else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: orchestrator {action} يتطلب {required}.")
    args = ["orchestrator", action]
    if action == "cycle":
        args.extend(["--dispatch-limit", "2", "--deferred-limit", "5"])
        if "--roadmap" in context.args or "roadmap" in context.args:
            args.append("--roadmap")
    msg = await update.message.reply_text(f"جار تنفيذ orchestrator {action}...")
    code, out, err = await run_admin(args, timeout=900)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**orchestrator {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_state(update: Update, context: ContextTypes.DEFAULT_TYPE):
    action = context.args[0].lower() if context.args else "summary"
    if action not in {"summary", "audit", "repair"}:
        return await update.message.reply_text("الاستخدام: /state [summary|audit|repair]")
    required = "operator" if action == "repair" else "viewer"
    if not has_role(update.effective_user.id, required):
        return await update.message.reply_text(f"غير مصرح: state {action} يتطلب {required}.")
    msg = await update.message.reply_text(f"جار تنفيذ state {action}...")
    code, out, err = await run_admin(["state", action], timeout=180)
    output = trim_output((out + "\n" + err).strip() or "لا توجد مخرجات", 3500)
    await msg.edit_text(f"**state {action}** (exit: {code})\n```\n{output}\n```", parse_mode=ParseMode.MARKDOWN)


# Error handler
async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    err = context.error
    tb = "".join(traceback.format_exception(type(err), err, err.__traceback__)) if err else ""
    print(f"[bot-error] {err}\n{tb}", file=sys.stderr, flush=True)
    # Keep the interface responsive: never let a handler error leave a button spinning
    # or the user without feedback.
    try:
        if isinstance(update, Update):
            if update.callback_query:
                try:
                    await update.callback_query.answer("حدث خطأ، جرّب مرة أخرى", show_alert=False)
                except Exception:
                    pass
            elif update.effective_chat:
                await context.bot.send_message(
                    update.effective_chat.id,
                    "⚠️ حدث خطأ مؤقت، تمت معالجته. أعد المحاولة.",
                )
    except Exception:
        pass

@restricted
async def cmd_tasks(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show the current roadmap: what is in progress, planned, blocked, done."""
    await update.message.reply_text(
        build_tasks_view(), reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN
    )

# Main
def main():
    async def on_start(app):
        # Launch the lifecycle-notification watcher as a background task.
        app.bot_data["notif_task"] = asyncio.create_task(notif_loop(app))
        await broadcast_message("🟢 واجهة NOVA متصلة — نظام التنبيهات اللحظية مفعّل", "system")

    app = Application.builder().token(BOT_TOKEN).post_init(on_start).build()

    # Callback query handler must be first to catch all.
    app.add_handler(CallbackQueryHandler(callback_handler))

    # Command handlers
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("register", cmd_register))
    app.add_handler(CommandHandler("unregister", cmd_unregister))
    app.add_handler(CommandHandler("menu", cmd_menu))
    app.add_handler(CommandHandler("myid", cmd_myid))
    app.add_handler(CommandHandler("notif", cmd_notif))
    app.add_handler(CommandHandler("tasks", cmd_tasks))
    app.add_handler(CommandHandler("exec", cmd_exec))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CommandHandler("plan_add", cmd_plan_add))
    app.add_handler(CommandHandler("plan_start", cmd_plan_start))
    app.add_handler(CommandHandler("plan_block", cmd_plan_block))
    app.add_handler(CommandHandler("plan_delete", cmd_plan_delete))
    app.add_handler(CommandHandler("git", cmd_git))
    app.add_handler(CommandHandler("opencode", cmd_opencode))
    app.add_handler(CommandHandler("chat", cmd_chat))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("server", cmd_server))
    app.add_handler(CommandHandler("broadcast", cmd_broadcast))
    app.add_handler(CommandHandler("notif_freq", set_freq_command))
    app.add_handler(CommandHandler("reload", cmd_reload))
    app.add_handler(CommandHandler("restart", cmd_reload))
    app.add_handler(CommandHandler("logs", cmd_logs))
    app.add_handler(CommandHandler("svc", cmd_svc))
    app.add_handler(CommandHandler("disk", cmd_disk))
    app.add_handler(CommandHandler("proc", cmd_proc))
    app.add_handler(CommandHandler("update", cmd_update))
    app.add_handler(CommandHandler("rollback", cmd_rollback))
    app.add_handler(CommandHandler("doctor", cmd_doctor))
    app.add_handler(CommandHandler("health", cmd_health))
    app.add_handler(CommandHandler("config", cmd_config))
    app.add_handler(CommandHandler("backup", cmd_backup))
    app.add_handler(CommandHandler("ci", cmd_ci))
    app.add_handler(CommandHandler("release", cmd_release))
    app.add_handler(CommandHandler("acceptance", cmd_acceptance))
    app.add_handler(CommandHandler("certify", cmd_certify))
    app.add_handler(CommandHandler("queue", cmd_queue))
    app.add_handler(CommandHandler("lease", cmd_lease))
    app.add_handler(CommandHandler("dispatcher", cmd_dispatcher))
    app.add_handler(CommandHandler("github_worker", cmd_github_worker))
    app.add_handler(CommandHandler("branch_policy", cmd_branch_policy))
    app.add_handler(CommandHandler("train", cmd_train))
    app.add_handler(CommandHandler("emergency", cmd_emergency))
    app.add_handler(CommandHandler("roadmap", cmd_roadmap))
    app.add_handler(CommandHandler("orchestrator", cmd_orchestrator))
    app.add_handler(CommandHandler("state", cmd_state))

    # Catch all non-command text messages for reply keyboard navigation or direct chat.
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_direct_message))

    app.add_error_handler(error_handler)

    print(f"NOVA Telegram Interface v{BOT_VERSION} ready with server controls, reply keyboard, and confirmation dialogs.", flush=True)
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)

if __name__ == "__main__":
    main()
