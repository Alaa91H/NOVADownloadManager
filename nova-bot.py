#!/usr/bin/env python3
"""
NOVA Telegram Bot v3.0 — Inline menus + notification control.
"""
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
from telegram.constants import ParseMode

# ── Config ──────────────────────────────────────────────
BOT_TOKEN = os.environ.get("NOVA_BOT_TOKEN", "8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY")
TELEGRAM_API_ID = os.environ.get("NOVA_API_ID", "38089413")
TELEGRAM_API_HASH = os.environ.get("NOVA_API_HASH", "4a45cef09ce00b27c7487830ffaa5f44")

PROJECT_DIR = Path("/home/ubuntu/NOVA")
LOG_FILE = Path("/var/log/nova-dev-agent.log")
AGENT_SERVICE = "nova-dev-agent.service"
STATE_FILE = PROJECT_DIR / ".agent-state.json"
OPENCODE_BIN = "/home/ubuntu/.opencode/bin/opencode"
CHATS_FILE = PROJECT_DIR / ".bot-chats.json"
NOTIF_FILE = PROJECT_DIR / ".notif-prefs.json"
SCRIPTS_DIR = PROJECT_DIR / "scripts" / "agent"
MAX_OUTPUT_LENGTH = 3800

running_execs: dict[int, asyncio.subprocess.Process] = {}

# ── Notification types ─────────────────────────────────
NOTIF_TYPES = [
    "cycle_start", "cycle_done", "ci_result", "ci_fail",
    "error", "maintenance", "analysis", "system",
]

NOTIF_LABELS = {
    "cycle_start": "🔄 بدء دورة",
    "cycle_done": "✅ انتهاء دورة",
    "ci_result": "📊 نتيجة CI",
    "ci_fail": "❌ فشل CI",
    "error": "🚨 أخطاء",
    "maintenance": "🛠️ صيانة",
    "analysis": "📈 تحليل",
    "system": "🖥️ نظام",
}

# ── Notification frequency levels ─────────────────────
FREQ_LEVELS = ["normal", "important", "minimal", "off"]
FREQ_LABELS = {
    "normal": "🔔 عادي (الكل)",
    "important": "⭐ مهم فقط",
    "minimal": "🔕 أخطاء فقط",
    "off": "🔇 إيقاف",
}
# Which types are allowed per frequency level
FREQ_FILTER = {
    "normal": set(NOTIF_TYPES),
    "important": {"cycle_start", "cycle_done", "error", "ci_fail"},
    "minimal": {"error", "ci_fail"},
    "off": set(),
}

# ── Auth ────────────────────────────────────────────────
def load_chats() -> list[int]:
    if CHATS_FILE.exists():
        try: return json.loads(CHATS_FILE.read_text())
        except Exception: return []
    return []

def save_chats(chats: list[int]):
    CHATS_FILE.write_text(json.dumps(chats, indent=2))

def load_notif_prefs() -> dict:
    if NOTIF_FILE.exists():
        try: return json.loads(NOTIF_FILE.read_text())
        except Exception: return {}
    return {}

def save_notif_prefs(prefs: dict):
    NOTIF_FILE.write_text(json.dumps(prefs, indent=2))

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

def restricted(func):
    async def wrapper(self_or_update, context, *args, **kwargs):
        if isinstance(self_or_update, Update):
            update = self_or_update
        else:
            update = args[0] if args else None
        if not update or not update.effective_user:
            return
        user_id = update.effective_user.id
        allowed = load_chats()
        # Determine if it's a message or callback
        if update.callback_query:
            text = update.callback_query.data or ""
        else:
            text = update.message.text.split()[0] if update.message and update.message.text else ""
        if text in ("/start", "/register", "/myid", "menu_main") or not allowed:
            return await func(self_or_update, context, *args, **kwargs)
        if user_id not in allowed:
            if update.callback_query:
                await update.callback_query.answer("⛔ غير مصرح", show_alert=True)
            else:
                await update.message.reply_text("⛔ هذا البوت خاص. أرسل /register للتسجيل.")
            return
        return await func(self_or_update, context, *args, **kwargs)
    return wrapper

# ── Helpers ─────────────────────────────────────────────
async def run_cmd(cmd: str, timeout: int = 30, cwd: str | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_shell(
        cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=cwd or str(PROJECT_DIR),
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")
    except asyncio.TimeoutError:
        proc.kill(); await proc.wait()
        return -1, "", f"⏱️ تجاوز المهلة ({timeout}s)"

def trim_output(text: str, max_len: int = MAX_OUTPUT_LENGTH) -> str:
    if len(text) <= max_len: return text
    return text[:max_len] + f"\n\n... (مقتطع، إجمالي {len(text)} حرف)"

def format_status(status: str) -> str:
    icons = {"active": "🟢", "inactive": "🔴", "failed": "🔴", "activating": "🟡", "deactivating": "🟡"}
    return f"{icons.get(status, '⚪')} {status}"

def shlex_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"

async def broadcast_message(text: str, notif_type: str = "system"):
    """Send to all chats that have this notification type enabled."""
    chats = load_chats()
    if not chats: return
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

# ── Inline Menu System ─────────────────────────────────
def main_menu_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🖥️ النظام", callback_data="menu_system"),
         InlineKeyboardButton("🤖 الوكيل", callback_data="menu_agent")],
        [InlineKeyboardButton("📋 الخطة", callback_data="menu_plan"),
         InlineKeyboardButton("🔍 البحث", callback_data="menu_research")],
        [InlineKeyboardButton("📊 التقارير", callback_data="menu_reports"),
         InlineKeyboardButton("⚙️ الإعدادات", callback_data="menu_settings")],
    ])

def system_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🖥️ حالة السيرفر", callback_data="server"),
         InlineKeyboardButton("📊 حالة الوكيل", callback_data="status")],
        [InlineKeyboardButton("📋 آخر سجل", callback_data="log_30"),
         InlineKeyboardButton("🧹 تنظيف", callback_data="clean")],
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="menu_main")],
    ])

def server_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔄 تحديث", callback_data="server"),
         InlineKeyboardButton("📊 حالة الوكيل", callback_data="status")],
        [InlineKeyboardButton("📋 آخر سجل", callback_data="log_30")],
        [InlineKeyboardButton("🔙 النظام", callback_data="menu_system")],
    ])

def agent_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🟢 تشغيل", callback_data="agent_start"),
         InlineKeyboardButton("🔴 إيقاف", callback_data="agent_stop"),
         InlineKeyboardButton("🔄 إعادة", callback_data="agent_restart")],
        [InlineKeyboardButton("✅ فحص الجودة", callback_data="quality"),
         InlineKeyboardButton("📊 تحليل", callback_data="analyze")],
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="menu_main")],
    ])

def plan_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📋 عرض الخطة", callback_data="plan"),
         InlineKeyboardButton("✅ إكمال نشطة", callback_data="plan_done")],
        [InlineKeyboardButton("▶️ بدء أول مهمة", callback_data="plan_start_first"),
         InlineKeyboardButton("ℹ️ تفاصيل نشطة", callback_data="plan_info_active")],
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="menu_main")],
    ])

def research_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔍 تحليل الكود", callback_data="analyze"),
         InlineKeyboardButton("🔐 تدقيق أمني", callback_data="audit")],
        [InlineKeyboardButton("📦 التبعيات", callback_data="deps"),
         InlineKeyboardButton("📈 التغطية", callback_data="coverage")],
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="menu_main")],
    ])

def reports_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📊 تقرير شامل", callback_data="report"),
         InlineKeyboardButton("📋 تاريخ CI", callback_data="ci_history")],
        [InlineKeyboardButton("📈 المقاييس", callback_data="metrics"),
         InlineKeyboardButton("📊 التغطية", callback_data="coverage")],
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="menu_main")],
    ])

def settings_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔔 الإشعارات", callback_data="notif_menu")],
        [InlineKeyboardButton("🔄 حالة الوكيل", callback_data="status")],
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="menu_main")],
    ])

def notif_menu_keyboard(chat_id: int):
    prefs = get_chat_prefs(chat_id)
    current_freq = prefs.get("freq", "normal")
    buttons = []

    # Frequency level row
    freq_row = []
    for f in FREQ_LEVELS:
        marker = "•" if f == current_freq else " "
        label = FREQ_LABELS.get(f, f)
        freq_row.append(InlineKeyboardButton(f"{marker} {label}", callback_data=f"notif_freq_{f}"))
    buttons.append(freq_row)

    # Individual toggles
    for nt in NOTIF_TYPES:
        status = "✅" if prefs.get(nt, True) else "⬜"
        label = NOTIF_LABELS.get(nt, nt)
        buttons.append([InlineKeyboardButton(f"{status} {label}", callback_data=f"notif_toggle_{nt}")])
    buttons.append([InlineKeyboardButton("✅ تشغيل الكل", callback_data="notif_all_on"),
                    InlineKeyboardButton("⬜ إيقاف الكل", callback_data="notif_all_off")])
    buttons.append([InlineKeyboardButton("🔙 الإعدادات", callback_data="menu_settings")])
    return InlineKeyboardMarkup(buttons)

async def send_menu(update: Update, text: str = "🤖 **NOVA Control Panel**"):
    if update.callback_query:
        await update.callback_query.edit_message_text(text, reply_markup=main_menu_keyboard(), parse_mode=ParseMode.MARKDOWN)
    else:
        await update.message.reply_text(text, reply_markup=main_menu_keyboard(), parse_mode=ParseMode.MARKDOWN)

# ── Callback Handler ───────────────────────────────────
@restricted
async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    chat_id = update.effective_chat.id
    await query.answer()

    # ── Menu navigation ──
    if data == "menu_main":
        return await send_menu(update)
    elif data == "menu_system":
        return await query.edit_message_text("🖥️ **النظام** — اختر أمراً:", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_agent":
        return await query.edit_message_text("🤖 **الوكيل** — التحكم بالعامل:", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_plan":
        return await query.edit_message_text("📋 **الخطة** — إدارة المهام:", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_research":
        return await query.edit_message_text("🔍 **البحث والتحليل**:", reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_reports":
        return await query.edit_message_text("📊 **التقارير**:", reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "menu_settings":
        return await query.edit_message_text("⚙️ **الإعدادات**:", reply_markup=settings_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "notif_menu":
        return await query.edit_message_text("🔔 **الإشعارات** — اختر الأنواع التي تريد استقبالها:", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data.startswith("notif_toggle_"):
        nt = data.replace("notif_toggle_", "")
        if nt in NOTIF_TYPES:
            prefs = get_chat_prefs(chat_id)
            new_val = not prefs.get(nt, True)
            set_chat_pref(chat_id, nt, new_val)
            return await query.edit_message_text(f"✅ تم {'تشغيل' if new_val else 'إيقاف'} إشعار: {NOTIF_LABELS.get(nt, nt)}", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data == "notif_all_on":
        for nt in NOTIF_TYPES:
            set_chat_pref(chat_id, nt, True)
        return await query.edit_message_text("✅ تم تشغيل كل الإشعارات", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data == "notif_all_off":
        for nt in NOTIF_TYPES:
            set_chat_pref(chat_id, nt, False)
        return await query.edit_message_text("⬜ تم إيقاف كل الإشعارات", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)
    elif data.startswith("notif_freq_"):
        freq = data.replace("notif_freq_", "")
        set_chat_freq(chat_id, freq)
        label = FREQ_LABELS.get(freq, freq)
        return await query.edit_message_text(f"✅ تم تعيين التكرار: {label}", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)

    # ── Agent control ──
    if data == "agent_start":
        r = await run_cmd(f"sudo systemctl start {AGENT_SERVICE}")
        return await query.edit_message_text(f"🟢 تشغيل العامل:\n`{(r[1]+r[2]).strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "agent_stop":
        r = await run_cmd(f"sudo systemctl stop {AGENT_SERVICE}")
        return await query.edit_message_text(f"🔴 إيقاف العامل:\n`{(r[1]+r[2]).strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)
    elif data == "agent_restart":
        r = await run_cmd(f"sudo systemctl restart {AGENT_SERVICE}")
        return await query.edit_message_text(f"🔄 إعادة تشغيل العامل:\n`{(r[1]+r[2]).strip() or 'OK'}`", reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # ── Quality / Analyze ──
    elif data == "quality":
        await query.edit_message_text("🔍 جاري فحوصات الجودة...", parse_mode=ParseMode.MARKDOWN)
        gates = [
            ("tsc --noEmit", "pnpm lint"),
            ("ESLint", "pnpm lint:eslint"),
            ("Format", "pnpm format:check"),
            ("Tests", "pnpm test"),
            ("Coverage", "pnpm test:coverage"),
            ("Build", "pnpm build"),
            ("Audit", "pnpm audit:final"),
        ]
        results = []
        all_pass = True
        for name, cmd in gates:
            code, out, err = await run_cmd(cmd, timeout=120)
            ok = code == 0
            all_pass = all_pass and ok
            results.append(f"{'✅' if ok else '❌'} **{name}** (exit: {code})")
        summary = "✅ **كل الفحوصات ناجحة!**" if all_pass else "⚠️ **بعض الفحوصات فشلت**"
        await query.edit_message_text(f"{summary}\n\n" + "\n".join(results), reply_markup=agent_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "analyze":
        script = SCRIPTS_DIR / "analyze.sh"
        if not script.exists():
            return await query.edit_message_text("❌ analyze.sh غير موجود.", reply_markup=research_keyboard())
        await query.edit_message_text("🔍 جاري تحليل الكود...", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_cmd(f"bash {script}", timeout=120)
        output = out.strip()[:3500] or "⚠️ لا توجد نتائج"
        await query.edit_message_text(f"**📊 Code Analysis**\n```\n{output}\n```", reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "audit":
        await query.edit_message_text("🔍 جاري التدقيق الأمني...", parse_mode=ParseMode.MARKDOWN)
        audit = await run_cmd("pnpm audit:final", timeout=60)
        outdated = await run_cmd("pnpm outdated --no-table 2>/dev/null || echo 'All up to date'", timeout=30)
        text = (
            f"**🔐 Security Audit**\n```\n{audit[1].strip()[:1500] or '✅ Clean'}\n```\n"
            f"**📦 Outdated Dependencies**\n```\n{outdated[1].strip()[:1500] or 'All up to date'}\n```"
        )
        await query.edit_message_text(text, reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "deps":
        await query.edit_message_text("🔍 جاري فحص التبعيات...", parse_mode=ParseMode.MARKDOWN)
        outdated = await run_cmd("pnpm outdated --no-table 2>/dev/null || echo 'All up to date'", timeout=30)
        audit = await run_cmd("pnpm audit:final", timeout=60)
        text = (
            f"**📦 Dependency Status**\n```\n{outdated[1].strip()[:1800] or 'All up to date'}\n```\n"
            f"**🔐 Audit**\n```\n{audit[1].strip()[:1500] or '✅ Clean'}\n```"
        )
        await query.edit_message_text(text, reply_markup=research_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # ── Status / Log / Server ──
    elif data == "server":
        await query.edit_message_text("🖥️ جاري جمع معلومات السيرفر...")
        text = await build_server_status()
        await query.edit_message_text(text, reply_markup=server_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "status":
        cpu = await run_cmd(r"top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'")
        mem = await run_cmd("free -m | awk 'NR==2{printf \"%s/%sMB (%.1f%%)\",$3,$2,$3*100/$2}'")
        disk = await run_cmd("df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'")
        svc = await run_cmd(f"systemctl is-active {AGENT_SERVICE}")
        bot_svc = await run_cmd("systemctl is-active nova-bot.service")
        branch = await run_cmd("git rev-parse --abbrev-ref HEAD")
        last_cycle = "N/A"
        if STATE_FILE.exists():
            try:
                s = json.loads(STATE_FILE.read_text())
                last_cycle = f"#{s.get('last_cycle','N/A')} ({s.get('duration_sec','?')}s)"
            except: pass
        text = (
            f"**🖥️ النظام**\n"
            f"• CPU: `{cpu[1].strip() or 'N/A'}%`\n"
            f"• RAM: `{mem[1].strip() or 'N/A'}`\n"
            f"• Disk: `{disk[1].strip() or 'N/A'}`\n\n"
            f"**🤖 الخدمات**\n"
            f"• Agent: {format_status(svc[1].strip())}\n"
            f"• Bot: {format_status(bot_svc[1].strip())}\n"
            f"• آخر دورة: `{last_cycle}`\n\n"
            f"**📦 Git**\n"
            f"• Branch: `{branch[1].strip()}`"
        )
        await query.edit_message_text(text, reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "log_30":
        if not LOG_FILE.exists():
            return await query.edit_message_text("❌ ملف السجل غير موجود.", reply_markup=system_keyboard())
        r = await run_cmd(f"tail -30 {LOG_FILE}")
        output = trim_output(r[1] or "⚠️ سجل فارغ")
        await query.edit_message_text(f"**📋 آخر 30 سطر:**\n```\n{output}\n```", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "clean":
        script = SCRIPTS_DIR / "maintenance.sh"
        if not script.exists():
            return await query.edit_message_text("❌ maintenance.sh غير موجود.", reply_markup=system_keyboard())
        await query.edit_message_text("🧹 جاري التنظيف...", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_cmd(f"bash {script}", timeout=120)
        output = out.strip()[:3500] or "✅ انتهى"
        await query.edit_message_text(f"**🧹 Maintenance Complete**\n```\n{output}\n```", reply_markup=system_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # ── Plan ──
    elif data == "plan":
        plan_file = PROJECT_DIR / "Plan.md"
        if not plan_file.exists():
            return await query.edit_message_text("❌ Plan.md غير موجود.", reply_markup=plan_keyboard())
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
        text = f"**📋 خطة العمل**\n\n**👉 النشطة:**\n```\n{active_text}\n```\n\n**📅 المخططة:**\n```\n{planned_text}\n```"
        await query.edit_message_text(text, reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "plan_done":
        content = _plan_read()
        if not content:
            return await query.edit_message_text("❌ Plan.md غير موجود.", reply_markup=plan_keyboard())
        match = re.search(r"### (.+?)\n.*?Status:\s*`\[/\] IN_PROGRESS`", content, re.DOTALL)
        if not match:
            return await query.edit_message_text("❌ لا توجد مهمة نشطة.", reply_markup=plan_keyboard())
        title = match.group(1).strip()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        content = re.sub(r"(Status:\s*`)\[/\] IN_PROGRESS(`)", r"\1[x] COMPLETED\2", content, count=1)
        content = re.sub(r"(- Completed: )pending", rf"\1{today}", content, count=1)
        _plan_write(content)
        await query.edit_message_text(f"✅ تم إكمال: **{title}**", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "plan_start_first":
        content = _plan_read()
        if not content:
            return await query.edit_message_text("❌ Plan.md غير موجود.", reply_markup=plan_keyboard())
        found = _plan_find_first_planned(content)
        if not found:
            return await query.edit_message_text("❌ لا توجد مهام مخططة.", reply_markup=plan_keyboard())
        start, end, block = found
        if "[ ] PLANNED" not in block:
            return await query.edit_message_text("❌ المهمة الأولى ليست PLANNED.", reply_markup=plan_keyboard())
        new_block = block.replace("- Status: `[ ] PLANNED`", "- Status: `[/] IN_PROGRESS`")
        new_block = new_block.replace("- Started: pending", f"- Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
        lines = content.split("\n")
        lines = lines[:start] + new_block.split("\n") + lines[end:]
        _plan_write("\n".join(lines))
        title = block.split("\n")[0].strip()
        await query.edit_message_text(f"✅ بدء المهمة: **{title}**", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "plan_info_active":
        content = _plan_read()
        if not content:
            return await query.edit_message_text("❌ Plan.md غير موجود.", reply_markup=plan_keyboard())
        match = re.search(r"### (.+?)\n.*?Status:\s*`\[/\] IN_PROGRESS`", content, re.DOTALL)
        if not match:
            return await query.edit_message_text("❌ لا توجد مهمة نشطة.", reply_markup=plan_keyboard())
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
            return await query.edit_message_text("❌ لم يتم العثور على تفاصيل المهمة.", reply_markup=plan_keyboard())
        # Find end of block
        task_starts = [i for i, line in enumerate(lines) if line.strip().startswith("### ") and not line.strip().startswith("####")]
        current_idx = task_starts.index(task_start)
        end = task_starts[current_idx + 1] if current_idx + 1 < len(task_starts) else len(lines)
        block = "\n".join(lines[task_start:end])
        await query.edit_message_text(f"**📋 تفاصيل المهمة النشطة**\n```\n{block.strip()[:3000]}\n```", reply_markup=plan_keyboard(), parse_mode=ParseMode.MARKDOWN)

    # ── Reports ──
    elif data == "report":
        await query.edit_message_text("📊 جاري إعداد التقرير...", parse_mode=ParseMode.MARKDOWN)
        cpu = await run_cmd(r"top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'")
        mem = await run_cmd("free -m | awk 'NR==2{printf \"%s/%sMB (%.1f%%)\",$3,$2,$3*100/$2}'")
        disk = await run_cmd("df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'")
        agent_svc = await run_cmd("systemctl is-active nova-dev-agent.service")
        branch = await run_cmd("git rev-parse --abbrev-ref HEAD")
        commits = await run_cmd("git log --oneline -3")
        last_cycle = "N/A"
        if STATE_FILE.exists():
            try:
                s = json.loads(STATE_FILE.read_text())
                last_cycle = f"#{s.get('last_cycle','N/A')} ({s.get('duration_sec','?')}s)"
            except: pass
        task = "N/A"
        plan_file = PROJECT_DIR / "Plan.md"
        if plan_file.exists():
            m = re.search(r"### (.+?)\n.*?Status:.*?IN_PROGRESS", plan_file.read_text(), re.DOTALL)
            if m: task = m.group(1).strip()
        text = (
            f"**📊 NOVA Report**\n\n"
            f"**🖥️ System**\n• CPU: `{cpu[1].strip() or '?'}%`\n• RAM: `{mem[1].strip() or '?'}`\n• Disk: `{disk[1].strip() or '?'}`\n\n"
            f"**🤖 Services**\n• Agent: {format_status(agent_svc[1].strip())}\n• آخر دورة: `{last_cycle}`\n\n"
            f"**📋 Active Task**\n`{task}`\n\n"
            f"**📦 Git**\n• Branch: `{branch[1].strip()}`\n• Recent:\n```\n{commits[1].strip()[:300]}\n```"
        )
        await query.edit_message_text(text, reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "ci_history":
        await query.edit_message_text("🔍 جاري جلب تاريخ CI...", parse_mode=ParseMode.MARKDOWN)
        code, out, err = await run_cmd(
            "gh run list --repo Alaa91H/NOVADownloadManager --limit 10 --json databaseId,conclusion,status,displayTitle,createdAt,headBranch --jq '.[] | \"\\(.createdAt[:19]) | \\(.status) | \\(.conclusion) | \\(.headBranch) | \\(.displayTitle[:50])\"'",
            timeout=15,
        )
        output = out.strip()[:3500] or "⚠️ لا توجد نتائج"
        await query.edit_message_text(f"**📋 CI History (last 10)**\n```\n{output}\n```", reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)

    elif data == "metrics":
        metrics_file = PROJECT_DIR / ".metrics.json"
        if not metrics_file.exists():
            return await query.edit_message_text("❌ لا توجد بيانات metrics بعد.", reply_markup=reports_keyboard())
        try:
            data = json.loads(metrics_file.read_text())
            snaps = data.get("snapshots", [])
            if len(snaps) < 2:
                return await query.edit_message_text(f"❌ تحتاج 2 snapshots. حالياً: {len(snaps)}", reply_markup=reports_keyboard())
            recent = snaps[-10:]
            lines = [f"📈 **Metrics Trends (last {len(recent)} snapshots)**\n"]
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
            await query.edit_message_text(f"❌ خطأ: {e}", reply_markup=reports_keyboard())

    elif data == "coverage":
        metrics_file = PROJECT_DIR / ".metrics.json"
        if not metrics_file.exists():
            return await query.edit_message_text("❌ لا توجد بيانات metrics بعد.", reply_markup=reports_keyboard())
        try:
            data = json.loads(metrics_file.read_text())
            snaps = data.get("snapshots", [])
            if not snaps:
                return await query.edit_message_text("❌ لا توجد snapshots بعد.", reply_markup=reports_keyboard())
            last = snaps[-1]
            text = (
                f"**📈 Coverage & Metrics**\n\n"
                f"• Coverage: `{last.get('coverage','N/A')}%`\n"
                f"• TS Errors: `{last.get('ts_errors','?')}`\n"
                f"• ESLint: `{last.get('eslint_count','?')}`\n"
                f"• Tests: `{last.get('test_count','?')}` ({last.get('tests_pass',0)} ✅/{last.get('tests_fail',0)} ❌)\n"
                f"• Files: `{last.get('file_count','?')}`\n"
                f"• Dependencies: `{last.get('dependency_count','?')}`\n"
                f"• Snapshots: `{len(snaps)}`\n"
            )
            if len(snaps) >= 2:
                first = snaps[0]
                cov_diff = (last.get("coverage") or 0) - (first.get("coverage") or 0)
                text += f"• Trend: `{first.get('coverage','N/A')}%` → `{last.get('coverage','N/A')}%` ({'+' if cov_diff>=0 else ''}{cov_diff:.1f}%)\n"
            await query.edit_message_text(text, reply_markup=reports_keyboard(), parse_mode=ParseMode.MARKDOWN)
        except Exception as e:
            await query.edit_message_text(f"❌ خطأ: {e}", reply_markup=reports_keyboard())

# ── Plan helpers ───────────────────────────────────────
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

# ── Command Handlers ───────────────────────────────────
@restricted
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    text = (
        f"🤖 مرحباً {user.first_name}!\n"
        f"**NOVA Download Manager** — بوت التحكم الشامل\n\n"
        f"⚠️ يجب أولاً إرسال /register لتسجيل الاشتراك.\n\n"
        f"🖥️ أرسل /server لحالة السيرفر الكاملة.\n"
        f"💬 **الوضع المباشر**: أي رسالة ترسلها (بدون /) تذهب مباشرةً للوكيل!\n"
        f"كأنك تتحدث معه عبر الطرفية — يأخذ أوامرك وينفذها.\n\n"
        f"استخدم الأزرار أدناه للتحكم السهل."
    )
    await update.message.reply_text(text, reply_markup=main_menu_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_register(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    chats = load_chats()
    if chat_id not in chats:
        chats.append(chat_id)
        save_chats(chats)
    await update.message.reply_text("✅ تم التسجيل! استخدم الأزرار أدناه:", reply_markup=main_menu_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_unregister(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    chats = load_chats()
    if chat_id in chats:
        chats.remove(chat_id)
        save_chats(chats)
    await update.message.reply_text("✅ تم إلغاء الاشتراك.")

@restricted
async def cmd_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_menu(update)

@restricted
async def cmd_myid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await update.message.reply_text(
        f"📋 **معلوماتك**\n• الاسم: `{user.first_name}`\n• المعرف: `{user.id}`\n• اليوزر: @{user.username or '—'}"
    )

@restricted
async def cmd_notif(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show notification settings."""
    chat_id = update.effective_chat.id
    await update.message.reply_text("🔔 **الإشعارات** — اختر الأنواع:", reply_markup=notif_menu_keyboard(chat_id), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_exec(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("📝 استعمال: /exec <command>")
        return
    command = " ".join(context.args)
    msg = await update.message.reply_text(f"⚡ تشغيل:\n`{command}`")
    proc = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(PROJECT_DIR))
    chat_id = update.effective_chat.id
    running_execs[chat_id] = proc
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        out = stdout.decode(errors="replace")
        err = stderr.decode(errors="replace")
        output = out + ("\n⚠️ " + err if err else "")
        output = trim_output(output.strip() or "✅ انتهى (بدون مخرجات)")
        await msg.edit_text(f"**✅ exit code:** {proc.returncode}\n```\n{output}\n```")
    except asyncio.TimeoutError:
        proc.kill(); await proc.wait()
        await msg.edit_text("⏱️ تجاوز المهلة (120s)")
    finally:
        running_execs.pop(chat_id, None)

@restricted
async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    if chat_id in running_execs:
        running_execs[chat_id].kill()
        await update.message.reply_text("🛑 تم الإلغاء.")
    else:
        await update.message.reply_text("لا يوجد أمر قيد التشغيل.")

@restricted
async def cmd_plan_add(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args) if context.args else ""
    if not text or "|" not in text:
        return await update.message.reply_text("📝 استعمال: `/plan_add Title | Description | priority`")
    parts = [p.strip() for p in text.split("|")]
    title = parts[0]
    desc = parts[1] if len(parts) > 1 else "وصف"
    priority = parts[2] if len(parts) > 2 else "medium"
    task_id = title.lower().replace(" ", "-")[:30]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    new_task = f"""
### {title}

- Status: `[ ] PLANNED`
- Priority: {priority}
- Type: task
- Source branch: `Dev`
- Work branch: `ai/{task_id}`
- Target branch: `Dev`
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
  - Added via Telegram bot on {today}
"""
    content = _plan_read()
    if not content:
        return await update.message.reply_text("❌ Plan.md غير موجود.")
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
    await update.message.reply_text(f"✅ تمت إضافة: **{title}**", reply_markup=main_menu_keyboard(), parse_mode=ParseMode.MARKDOWN)

@restricted
async def cmd_plan_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("📝 استعمال: `/plan_start keyword`")
    keyword = " ".join(context.args)
    content = _plan_read()
    if not content:
        return await update.message.reply_text("❌ Plan.md غير موجود.")
    found = _plan_find_task(content, keyword)
    if not found:
        return await update.message.reply_text(f"❌ لم يتم العثور على `{keyword}`")
    start, end, block = found
    if "[ ] PLANNED" not in block:
        return await update.message.reply_text("❌ المهمة ليست PLANNED.")
    new_block = block.replace("- Status: `[ ] PLANNED`", "- Status: `[/] IN_PROGRESS`")
    new_block = new_block.replace("- Started: pending", f"- Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
    lines = content.split("\n")
    lines = lines[:start] + new_block.split("\n") + lines[end:]
    _plan_write("\n".join(lines))
    await update.message.reply_text(f"✅ تم بدء المهمة:\n`{block.split(chr(10))[0].strip()}`")

@restricted
async def cmd_plan_block(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args) if context.args else ""
    if not text:
        return await update.message.reply_text("📝 استعمال: `/plan_block keyword | reason`")
    parts = [p.strip() for p in text.split("|", 1)]
    keyword = parts[0]
    reason = parts[1] if len(parts) > 1 else "blocked"
    content = _plan_read()
    if not content:
        return await update.message.reply_text("❌ Plan.md غير موجود.")
    found = _plan_find_task(content, keyword)
    if not found:
        return await update.message.reply_text(f"❌ لم يتم العثور على `{keyword}`")
    start, end, block = found
    new_block = re.sub(r"Status:\s*`\[/?\]\s*\w+`", "- Status: `[!] BLOCKED`", block)
    if "Notes:" in new_block:
        new_block = new_block.replace("Notes:", f"Notes:\n  - Blocked: {reason}")
    else:
        new_block += f"\n- Notes:\n  - Blocked: {reason}"
    lines = content.split("\n")
    lines = lines[:start] + new_block.split("\n") + lines[end:]
    _plan_write("\n".join(lines))
    await update.message.reply_text(f"⛔ تم تعطيل: **{keyword.strip('#')}**\nالسبب: {reason}")

@restricted
async def cmd_plan_delete(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("📝 استعمال: /plan_delete <keyword>")
    keyword = " ".join(context.args)
    content = _plan_read()
    if not content:
        return await update.message.reply_text("❌ Plan.md غير موجود.")
    found = _plan_find_task(content, keyword)
    if not found:
        return await update.message.reply_text(f"❌ لم يتم العثور على `{keyword}`")
    start, end, block = found
    lines = content.split("\n")
    new_lines = lines[:start] + lines[end:]
    _plan_write("\n".join(new_lines))
    await update.message.reply_text(f"🗑️ تم حذف:\n`{block.split(chr(10))[0].strip()}`")

@restricted
async def cmd_git(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("📝 استعمال: /git <args>")
    command = "git " + " ".join(context.args)
    result = await run_cmd(command)
    output = result[1] + ("\n⚠️ " + result[2] if result[2] else "")
    output = trim_output(output.strip() or "✅ انتهى")
    await update.message.reply_text(f"```\n{output}\n```")

@restricted
async def cmd_opencode(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        return await update.message.reply_text("📝 استعمال: /opencode <prompt>")
    prompt = " ".join(context.args)
    msg = await update.message.reply_text(f"🤖 جاري تشغيل opencode...\n\n`{prompt[:200]}{'...' if len(prompt)>200 else ''}`")
    cmd = f"cd {PROJECT_DIR} && PATH=\"/home/ubuntu/.opencode/bin:$PATH\" {OPENCODE_BIN} run --model \"opencode/big-pickle\" --auto {shlex_quote(prompt)}"
    try:
        code, out, err = await run_cmd(cmd, timeout=600)
        output = out.strip()[:3000] or "✅ انتهى"
        await msg.edit_text(f"**✅ opencode** (exit: {code})\n```\n{output}\n```")
    except Exception as e:
        await msg.edit_text(f"❌ خطأ: {e}")

# ── Server Status ─────────────────────────────────────
async def build_server_status() -> str:
    """Build comprehensive server status report."""
    # CPU
    cpu_user = await run_cmd(r"top -bn1 | grep 'Cpu(s)' | awk '{print $2}'")
    cpu_sys = await run_cmd(r"top -bn1 | grep 'Cpu(s)' | awk '{print $4}'")
    cpu_idle = await run_cmd(r"top -bn1 | grep 'Cpu(s)' | awk '{print $8}'")
    load = await run_cmd("cat /proc/loadavg | awk '{print \"1min=\"$1\" 5min=\"$2\" 15min=\"$3}'")
    procs = await run_cmd("cat /proc/loadavg | awk '{print $4}'")
    cpu_temp = await run_cmd("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{print $1/1000\"°C\"}' || echo 'N/A'")

    # Memory
    mem_total = await run_cmd("free -m | awk 'NR==2{print $2}'")
    mem_used = await run_cmd("free -m | awk 'NR==2{print $3}'")
    mem_avail = await run_cmd("free -m | awk 'NR==2{print $7}'")
    mem_pct = await run_cmd("free -m | awk 'NR==2{printf \"%.1f%%\", $3*100/$2}'")
    swap_total = await run_cmd("free -m | awk 'NR==3{print $2}'")
    swap_used = await run_cmd("free -m | awk 'NR==3{print $3}'")
    swap_pct = await run_cmd("free -m | awk 'NR==3{ if($2>0) printf \"%.1f%%\", $3*100/$2; else print \"0%\" }'")

    # Disk
    disk_total = await run_cmd("df -h / | awk 'NR==2{print $2}'")
    disk_used = await run_cmd("df -h / | awk 'NR==2{print $3}'")
    disk_avail = await run_cmd("df -h / | awk 'NR==2{print $4}'")
    disk_pct = await run_cmd("df -h / | awk 'NR==2{print $5}'")

    # Uptime
    uptime = await run_cmd("uptime -p | sed 's/up //'")
    uptime_since = await run_cmd("uptime -s | cut -d. -f1")

    # Network
    net_rx = await run_cmd("cat /proc/net/dev | grep eth0 | awk '{print $2}' || cat /proc/net/dev | grep ens | awk '{print $2}' | head -1")
    net_tx = await run_cmd("cat /proc/net/dev | grep eth0 | awk '{print $10}' || cat /proc/net/dev | grep ens | awk '{print $10}' | head -1")

    # All NOVA services
    services_data = {}
    for svc_name in ["nova-dev-agent", "nova-bot", "nova-maintenance.timer", "nova-watchdog.timer"]:
        r = await run_cmd(f"systemctl is-active {svc_name}")
        services_data[svc_name] = r[1].strip()

    # Top processes by CPU
    top_cpu = await run_cmd(r"ps aux --sort=-%cpu | head -6 | awk 'NR>1{printf \"%s %s %s%%\n\", $2, $11, $3}'")

    # Top processes by memory
    top_mem = await run_cmd(r"ps aux --sort=-%mem | head -6 | awk 'NR>1{printf \"%s %s %s%%\n\", $2, $11, $4}'")

    # Node version
    node_v = await run_cmd("node --version")
    pnpm_v = await run_cmd("pnpm --version")

    # Git
    branch = await run_cmd("git rev-parse --abbrev-ref HEAD")
    last_commit = await run_cmd("git log --oneline -1")
    ahead = await run_cmd("git rev-list --count HEAD..origin/Dev 2>/dev/null || echo 0")
    behind = await run_cmd("git rev-list --count origin/Dev..HEAD 2>/dev/null || echo 0")

    # Last cycle
    last_cycle = "N/A"
    cycle_duration = ""
    if STATE_FILE.exists():
        try:
            s = json.loads(STATE_FILE.read_text())
            last_cycle = s.get("last_cycle", "N/A")
            dur = s.get("duration_sec", 0)
            cycle_duration = f" ({dur // 60}m {dur % 60}s)"
        except: pass

    # Helper to format bytes
    def format_bytes(b: str) -> str:
        try:
            n = int(b)
            if n > 1_000_000_000: return f"{n/1_000_000_000:.1f}GB"
            if n > 1_000_000: return f"{n/1_000_000:.1f}MB"
            if n > 1_000: return f"{n/1_000:.1f}KB"
            return f"{n}B"
        except: return b

    text = (
        f"**🖥️ Server Status**\n\n"
        f"**⚡ CPU**\n"
        f"• Usage: `{cpu_user[1].strip() or '?'}%` user / `{cpu_sys[1].strip() or '?'}%` sys / `{cpu_idle[1].strip() or '?'}%` idle\n"
        f"• Load: `{load[1].strip() or '?'}`  |  Procs: `{procs[1].strip() or '?'}`\n"
        f"• Temp: `{cpu_temp[1].strip() or 'N/A'}`\n\n"
        f"**💾 Memory**\n"
        f"• RAM: `{mem_used[1].strip() or '?'}` / `{mem_total[1].strip() or '?'}MB` ({mem_pct[1].strip() or '?'})\n"
        f"• Avail: `{mem_avail[1].strip() or '?'}MB`  |  Swap: `{swap_used[1].strip() or '?'}` / `{swap_total[1].strip() or '?'}MB` ({swap_pct[1].strip() or '?'})\n\n"
        f"**💿 Disk**\n"
        f"• `/`: `{disk_used[1].strip() or '?'}` / `{disk_total[1].strip() or '?'}` ({disk_pct[1].strip() or '?'}) — Free: `{disk_avail[1].strip() or '?'}`\n\n"
        f"**⏱️ System**\n"
        f"• Uptime: `{uptime[1].strip() or '?'}`\n"
        f"• Since: `{uptime_since[1].strip() or '?'}`\n"
        f"• Net RX: `{format_bytes(net_rx[1].strip())}` | TX: `{format_bytes(net_tx[1].strip())}`\n"
        f"• Node: `{node_v[1].strip() or '?'}`  |  pnpm: `{pnpm_v[1].strip() or '?'}`\n\n"
        f"**🤖 NOVA Services**\n"
        f"• Agent: {format_status(services_data.get('nova-dev-agent', 'inactive'))}\n"
        f"• Bot: {format_status(services_data.get('nova-bot', 'inactive'))}\n"
        f"• Maintenance: {format_status(services_data.get('nova-maintenance.timer', 'inactive'))}\n"
        f"• Watchdog: {format_status(services_data.get('nova-watchdog.timer', 'inactive'))}\n\n"
        f"**🔁 Agent Cycle**\n"
        f"• Last: `{last_cycle}`{cycle_duration}\n\n"
        f"**📦 Git**\n"
        f"• Branch: `{branch[1].strip() or '?'}`\n"
        f"• HEAD: `{last_commit[1].strip() or '?'}`\n"
        f"• Ahead: `{ahead[1].strip() or '0'}` | Behind: `{behind[1].strip() or '0'}`\n\n"
        f"**🔥 Top CPU**\n```\n{top_cpu[1].strip()[:400] or 'N/A'}\n```\n"
        f"**📊 Top MEM**\n```\n{top_mem[1].strip()[:400] or 'N/A'}\n```"
    )
    return text

@restricted
async def cmd_server(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("🖥️ جاري جمع معلومات السيرفر...")
    text = await build_server_status()
    await msg.edit_text(text, reply_markup=server_keyboard(), parse_mode=ParseMode.MARKDOWN)

# ── Direct Chat with Agent ────────────────────────────
# Any non-command message is sent directly to opencode agent
CHAT_CONTEXT: dict[int, list[dict]] = {}  # chat_id -> [{"role","content"}]

@restricted
async def cmd_chat(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "💬 **الوضع المباشر** — أي رسالة ترسلها (بدون /) تذهب مباشرةً للوكيل.\n"
        "الوكيل سيفهم السياق ويتجاوب معك كأنك تتحدث معه عبر الطرفية.\n\n"
        "أرسل `/menu` للقائمة الرئيسية.\n"
        "أرسل `/reset` لمسح سياق المحادثة."
    )

@restricted
async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    CHAT_CONTEXT.pop(chat_id, None)
    await update.message.reply_text("🧹 تم مسح سياق المحادثة. يمكنك البدء من جديد.")

async def run_opencode_prompt(prompt: str, chat_history: list[dict] | None = None) -> str:
    """Run opencode with a prompt and return the output."""
    context_prompt = prompt
    if chat_history:
        # Build context summary from last few exchanges
        recent = chat_history[-6:]
        context_lines = ["Here is our conversation so far (recent history):"]
        for msg in recent:
            role = "User" if msg["role"] == "user" else "Assistant"
            content = msg["content"][:200]
            context_lines.append(f"{role}: {content}")
        context_lines.append("")
        context_lines.append(f"Current user message: {prompt}")
        context_prompt = "\n".join(context_lines)

    full_prompt = (
        "You are the NOVA autonomous development agent for the NOVA Download Manager project.\n"
        "You are talking directly with the user via Telegram. Respond helpfully and concisely.\n"
        "You can read/write files, run allowed commands (lint, test, git, gh), and make changes.\n"
        f"Project directory: {PROJECT_DIR}\n"
        "Allowed commands: pnpm lint, pnpm lint:eslint, pnpm format:check, pnpm test (unit only), "
        "pnpm audit:final, git, gh CLI\n"
        "FORBIDDEN: pnpm build, pnpm tauri:anything, pnpm test:coverage, pnpm release, pnpm bundle\n\n"
        "IMPORTANT: Keep responses under 3000 characters. "
        "When you make code changes, commit and push them. "
        "Update Plan.md status as needed.\n\n"
        f"User message: {context_prompt}"
    )

    cmd = (
        f"cd {PROJECT_DIR} && "
        f"PATH=\"/home/ubuntu/.opencode/bin:$PATH\" "
        f"{OPENCODE_BIN} run --model \"opencode/big-pickle\" --auto {shlex_quote(full_prompt)}"
    )

    try:
        code, out, err = await run_cmd(cmd, timeout=300)
        output = out.strip()[:3000] or "✅ Done (no output)"
        if err:
            output += f"\n⚠️ {err.strip()[:500]}"
        return output
    except asyncio.TimeoutError:
        return "⏱️ تجاوزت المهلة (300s). حاول تبسيط الطلب."
    except Exception as e:
        return f"❌ خطأ: {e}"

async def handle_direct_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle any non-command text message as a direct prompt to the agent."""
    if not update.message or not update.message.text:
        return

    chat_id = update.effective_chat.id
    user_text = update.message.text.strip()

    if not user_text:
        return

    # Initialize chat history if needed
    if chat_id not in CHAT_CONTEXT:
        CHAT_CONTEXT[chat_id] = []

    # Add user message to history
    CHAT_CONTEXT[chat_id].append({"role": "user", "content": user_text})

    msg = await update.message.reply_text(
        f"🧠 **NOVA Agent** يعمل على:\n`{user_text[:200]}{'...' if len(user_text) > 200 else ''}`\n\n⏳ انتظر..."
    )

    # Show typing indicator
    try:
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")
    except Exception:
        pass

    output = await run_opencode_prompt(user_text, CHAT_CONTEXT[chat_id])

    # Add assistant response to history
    CHAT_CONTEXT[chat_id].append({"role": "assistant", "content": output})

    # Keep history manageable (last 20 messages)
    if len(CHAT_CONTEXT[chat_id]) > 20:
        CHAT_CONTEXT[chat_id] = CHAT_CONTEXT[chat_id][-20:]

    # Determine if it looks like a conversation or a command result
    is_code_output = any(marker in output for marker in ["```", "exit:", "❌", "✅", "⚠️"])

    if is_code_output:
        full = f"**✅ Agent response:**\n```\n{output}\n```"
    else:
        full = f"**🤖 NOVA:**\n{output}"

    try:
        await msg.edit_text(full)
    except Exception:
        # Message too long or can't edit, send new
        await update.message.reply_text(full)

    # Add menu button
    await update.message.reply_text("💡 استخدم /menu للقائمة الرئيسية.")

@restricted
# ── /set_freq command ─────────────────────────────────
@restricted
async def set_freq_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    if not context.args:
        opts = " | ".join(f"{f}={FREQ_LABELS[f]}" for f in FREQ_LEVELS)
        return await update.message.reply_text(f"🔔 **تكرار الإشعارات**\nاختر:\n{opts}\n\nمثال: `/set_freq important`")
    freq = context.args[0].lower()
    if freq not in FREQ_LEVELS:
        return await update.message.reply_text(f"⚠️ غير معروف. الخيارات: {', '.join(FREQ_LEVELS)}")
    set_chat_freq(chat_id, freq)
    await update.message.reply_text(f"✅ تم تعيين التكرار: {FREQ_LABELS[freq]}")

# ── Broadcast command (admin only) ──────────────────────
@restricted
async def cmd_broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id not in load_chats():
        return await update.message.reply_text("⛔ غير مصرح")
    if not context.args:
        return await update.message.reply_text("📝 استعمال: /broadcast <رسالة>\nأو /broadcast <type> <رسالة>")
    notif_type = "system"
    msg_parts = " ".join(context.args)
    if context.args[0] in NOTIF_TYPES:
        notif_type = context.args[0]
        msg_parts = " ".join(context.args[1:]) if len(context.args) > 1 else ""
    if not msg_parts:
        return await update.message.reply_text("⚠️ الرسالة فارغة")
    await broadcast_message(f"📢 **بث**: {msg_parts}", notif_type)
    await update.message.reply_text(f"✅ تم البث (type: {notif_type})")

# ── Error Handler ──────────────────────────────────────
async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    print(f"Error: {context.error}", file=sys.stderr)

# ── Main ────────────────────────────────────────────────
def main():
    async def on_start(app):
        await broadcast_message("🟢 **NOVA Bot** — التشغيل", "system")

    app = Application.builder().token(BOT_TOKEN).post_init(on_start).build()

    # Callback query handler — must be first to catch all
    app.add_handler(CallbackQueryHandler(callback_handler))

    # Command handlers
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("register", cmd_register))
    app.add_handler(CommandHandler("unregister", cmd_unregister))
    app.add_handler(CommandHandler("menu", cmd_menu))
    app.add_handler(CommandHandler("myid", cmd_myid))
    app.add_handler(CommandHandler("notif", cmd_notif))
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

    # Catch all non-command text messages — direct chat with agent
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_direct_message))

    app.add_error_handler(error_handler)

    async def on_start(app):
        await broadcast_message("🟢 **NOVA Bot** — التشغيل", "system")

    print("NOVA Bot v3.2 started — notification frequency control + broadcast command.", flush=True)
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
