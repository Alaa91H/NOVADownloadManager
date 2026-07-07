#!/usr/bin/env python3
"""
NOVA Telegram Bot — Direct control & monitoring for NOVA Dev Agent.
Commands: /start, /status, /log, /start_agent, /stop_agent, /restart_agent,
          /exec, /quality, /plan, /git, /opencode, /build
"""
import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ──────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────
BOT_TOKEN = os.environ.get("NOVA_BOT_TOKEN", "8996219734:AAF23wUwd-cdkeCO1kuLIym99G3fYEyZegY")
ALLOWED_USER_IDS = os.environ.get("NOVA_ALLOWED_USERS", "").split(",")
ALLOWED_USER_IDS = [int(uid.strip()) for uid in ALLOWED_USER_IDS if uid.strip().isdigit()]

PROJECT_DIR = Path("/home/ubuntu/NOVA")
LOG_FILE = Path("/var/log/nova-dev-agent.log")
AGENT_SERVICE = "nova-dev-agent.service"
STATE_FILE = PROJECT_DIR / ".agent-state.json"
OPENCODE_BIN = "/home/ubuntu/.opencode/bin/opencode"
CHATS_FILE = PROJECT_DIR / ".bot-chats.json"

MAX_OUTPUT_LENGTH = 3800  # Telegram message limit is 4096, leave room for formatting

# Track running exec processes to allow cancellation
running_execs: dict[int, asyncio.subprocess.Process] = {}

# ──────────────────────────────────────────────────────
# Auth decorator
# ──────────────────────────────────────────────────────
def restricted(func):
    async def wrapper(self_or_update, context, *args, **kwargs):
        if isinstance(self_or_update, Update):
            update = self_or_update
        else:
            update = args[0] if args else None

        if not update or not update.effective_user:
            return

        user_id = update.effective_user.id
        if ALLOWED_USER_IDS and user_id not in ALLOWED_USER_IDS:
            await update.message.reply_text("⛔ غير مصرح لك باستخدام هذا البوت.")
            return

        return await func(self_or_update, context, *args, **kwargs)
    return wrapper

# ──────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────
async def run_cmd(cmd: str, timeout: int = 30, cwd: str | None = None) -> tuple[int, str, str]:
    """Run a shell command and return (exit_code, stdout, stderr)."""
    proc = await asyncio.create_subprocess_shell(
        cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd or str(PROJECT_DIR),
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "", f"⏱️ تجاوز المهلة ({timeout}s)"

def trim_output(text: str, max_len: int = MAX_OUTPUT_LENGTH) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len] + f"\n\n... (مقتطع، إجمالي {len(text)} حرف)"

def format_status(status: str) -> str:
    icons = {"active": "🟢", "inactive": "🔴", "failed": "🔴", "activating": "🟡", "deactivating": "🟡"}
    return f"{icons.get(status, '⚪')} {status}"

def escape_md(text: str) -> str:
    """Escape Telegram MarkdownV2 special chars."""
    special = r"_*[]()~`>#+-=|{}.!"
    for ch in special:
        text = text.replace(ch, f"\\{ch}")
    return text

# ──────────────────────────────────────────────────────
# Command Handlers
# ──────────────────────────────────────────────────────
@restricted
def load_chats() -> list[int]:
    if CHATS_FILE.exists():
        try:
            return json.loads(CHATS_FILE.read_text())
        except Exception:
            return []
    return []

def save_chats(chats: list[int]):
    CHATS_FILE.write_text(json.dumps(chats, indent=2))

async def broadcast_message(text: str):
    """Send a message to all registered chats."""
    chats = load_chats()
    if not chats:
        return
    from telegram import Bot
    bot = Bot(token=BOT_TOKEN)
    for chat_id in chats:
        try:
            await bot.send_message(chat_id=chat_id, text=text)
        except Exception:
            pass

@restricted
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await update.message.reply_text(
        f"🤖 مرحباً {user.first_name}!\n"
        f"بوت التحكم بـ **NOVA Download Manager**\n\n"
        f"⚠️ يجب أولاً تسجيل الاشتراك بإرسال /register\n"
        f"لاستقبال إشعارات العامل التلقائي.\n\n"
        f"**الأوامر:**\n"
        f"• /register — تسجيل الاشتراك في الإشعارات\n"
        f"• /unregister — إلغاء الاشتراك\n"
        f"• /status — حالة النظام والعامل\n"
        f"• /log — آخر 30 سطر من السجل\n"
        f"• /log 100 — عدد محدد من الأسطر\n"
        f"• /start_agent — تشغيل العامل\n"
        f"• /stop_agent — إيقاف العامل\n"
        f"• /restart_agent — إعادة تشغيل العامل\n"
        f"• /exec `command` — تشغيل أمر مباشر\n"
        f"• /quality — تشغيل فحوصات الجودة\n"
        f"• /plan — عرض خطة العمل\n"
        f"• /plan_add عنوان | وصف | اولوية — إضافة مهمة\n"
        f"• /plan_start كلمة — نقل مهمة للنشطة\n"
        f"• /plan_done — إكمال المهمة النشطة\n"
        f"• /plan_block كلمة | سبب — تعطيل مهمة\n"
        f"• /git `args` — أوامر git\n"
        f"• /opencode `prompt` — تشغيل opencode\n"
        f"• /build — بناء المشروع"
    )

@restricted
async def cmd_register(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    chats = load_chats()
    if chat_id not in chats:
        chats.append(chat_id)
        save_chats(chats)
    await update.message.reply_text("✅ تم تسجيل الاشتراك! ستصللك إشعارات العامل تلقائياً.")

@restricted
async def cmd_unregister(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    chats = load_chats()
    if chat_id in chats:
        chats.remove(chat_id)
        save_chats(chats)
    await update.message.reply_text("✅ تم إلغاء الاشتراك.")

@restricted
async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("🔍 جاري جمع المعلومات...")

    # System info
    cpu = await run_cmd(r"top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'")
    mem = await run_cmd("free -m | awk 'NR==2{printf \"%s/%sMB (%.1f%%)\", $3,$2,$3*100/$2}'")
    disk = await run_cmd("df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'")
    uptime = await run_cmd("uptime -p | sed 's/up //'")
    load = await run_cmd("cat /proc/loadavg | awk '{print $1, $2, $3}'")

    # Agent service status
    svc = await run_cmd(f"systemctl is-active {AGENT_SERVICE}")
    svc_enabled = await run_cmd(f"systemctl is-enabled {AGENT_SERVICE}")

    # Last cycle from state file
    last_cycle = "N/A"
    last_time = "N/A"
    if STATE_FILE.exists():
        try:
            state = json.loads(STATE_FILE.read_text())
            last_cycle = state.get("last_cycle", "N/A")
            last_time = state.get("timestamp", "N/A")
        except Exception:
            pass

    # Git info
    git_branch = await run_cmd("git rev-parse --abbrev-ref HEAD")
    git_commit = await run_cmd("git log --oneline -1")

    text = (
        f"**🖥️ النظام**\n"
        f"• CPU: `{cpu[1].strip() or 'N/A'}%`\n"
        f"• RAM: `{mem[1].strip() or 'N/A'}`\n"
        f"• Disk: `{disk[1].strip() or 'N/A'}`\n"
        f"• Uptime: `{uptime[1].strip() or 'N/A'}`\n"
        f"• Load: `{load[1].strip() or 'N/A'}`\n\n"
        f"**🤖 العامل**\n"
        f"• Service: {format_status(svc[1].strip())}\n"
        f"• Enabled: `{svc_enabled[1].strip()}`\n"
        f"• Last cycle: `{last_cycle}`\n"
        f"• Last run: `{last_time}`\n\n"
        f"**📦 Git**\n"
        f"• Branch: `{git_branch[1].strip()}`\n"
        f"• HEAD: `{git_commit[1].strip()}`"
    )
    await msg.edit_text(text)

@restricted
async def cmd_log(update: Update, context: ContextTypes.DEFAULT_TYPE):
    lines = 30
    if context.args and context.args[0].isdigit():
        lines = int(context.args[0])
        lines = min(lines, 500)  # cap at 500

    if not LOG_FILE.exists():
        await update.message.reply_text("❌ ملف السجل غير موجود.")
        return

    result = await run_cmd(f"tail -{lines} {LOG_FILE}")
    output = result[1] or "⚠️ سجل فارغ"
    output = trim_output(output)
    await update.message.reply_text(f"**📋 آخر {lines} سطر:**\n```\n{output}\n```")

@restricted
async def cmd_start_agent(update: Update, context: ContextTypes.DEFAULT_TYPE):
    result = await run_cmd(f"sudo systemctl start {AGENT_SERVICE}")
    out = result[1] + result[2]
    await update.message.reply_text(f"🟢 تشغيل العامل:\n`{out.strip() or 'OK'}`")

@restricted
async def cmd_stop_agent(update: Update, context: ContextTypes.DEFAULT_TYPE):
    result = await run_cmd(f"sudo systemctl stop {AGENT_SERVICE}")
    out = result[1] + result[2]
    await update.message.reply_text(f"🔴 إيقاف العامل:\n`{out.strip() or 'OK'}`")

@restricted
async def cmd_restart_agent(update: Update, context: ContextTypes.DEFAULT_TYPE):
    result = await run_cmd(f"sudo systemctl restart {AGENT_SERVICE}")
    out = result[1] + result[2]
    await update.message.reply_text(f"🔄 إعادة تشغيل العامل:\n`{out.strip() or 'OK'}`")

@restricted
async def cmd_exec(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("📝 استعمال: /exec <command>\nمثال: /exec ls -la")
        return

    command = " ".join(context.args)
    msg = await update.message.reply_text(f"⚡ تشغيل:\n`{command}`")

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(PROJECT_DIR),
    )

    chat_id = update.effective_chat.id
    running_execs[chat_id] = proc

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        out = stdout.decode(errors="replace")
        err = stderr.decode(errors="replace")
        output = out + ("\n⚠️ " + err if err else "")
        output = trim_output(output.strip() or "✅ انتهى بنجاح (بدون مخرجات)")
        await msg.edit_text(f"**✅ exit code:** {proc.returncode}\n```\n{output}\n```")
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        await msg.edit_text("⏱️ تجاوز المهلة (120s)")
    finally:
        running_execs.pop(chat_id, None)

@restricted
async def cmd_quality(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("🔍 جاري فحوصات الجودة...")

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
        await msg.edit_text(f"🔍 {name}...")
        code, out, err = await run_cmd(cmd, timeout=120)
        status_icon = "✅" if code == 0 else "❌"
        all_pass = all_pass and (code == 0)
        results.append(f"{status_icon} **{name}** (exit: {code})")

    summary = "✅ **كل الفحوصات ناجحة!**" if all_pass else "⚠️ **بعض الفحوصات فشلت**"
    text = f"{summary}\n\n" + "\n".join(results)
    await msg.edit_text(text)

@restricted
async def cmd_plan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    plan_file = PROJECT_DIR / "Plan.md"
    if not plan_file.exists():
        await update.message.reply_text("❌ Plan.md غير موجود.")
        return

    content = plan_file.read_text()

    # Extract key sections for a summary view
    lines = content.split("\n")
    active_section = []
    planned_section = []
    current_section = None
    for line in lines:
        if "## Active Task" in line:
            current_section = "active"
            continue
        elif "## Planned Tasks" in line:
            current_section = "planned"
            continue
        elif line.startswith("## ") and current_section:
            current_section = None
            continue

        if current_section == "active":
            active_section.append(line)
        elif current_section == "planned":
            planned_section.append(line)

    active_text = "\n".join(active_section).strip()[:1500] or "لا توجد مهمة نشطة"
    planned_text = "\n".join(planned_section).strip()[:1500] or "لا توجد مهام مخططة"

    text = (
        f"**📋 خطة العمل**\n\n"
        f"**👉 المهمة النشطة:**\n```\n{active_text}\n```\n\n"
        f"**📅 المهام المخططة:**\n```\n{planned_text}\n```"
    )
    await update.message.reply_text(text)

# ──────────────────────────────────────────────────────
# Plan Editing
# ──────────────────────────────────────────────────────
PLAN_FILE = PROJECT_DIR / "Plan.md"

def _plan_read() -> str:
    return PLAN_FILE.read_text() if PLAN_FILE.exists() else ""

def _plan_write(content: str):
    PLAN_FILE.write_text(content)

def _plan_find_task(content: str, title_keyword: str) -> tuple[int, int, str] | None:
    """Find a task block by keyword in its title. Returns (start_line, end_line, block_text)."""
    lines = content.split("\n")
    task_starts = []
    for i, line in enumerate(lines):
        if line.strip().startswith("### ") and not line.strip().startswith("####"):
            task_starts.append(i)

    for idx, start in enumerate(task_starts):
        title = lines[start].strip()
        if title_keyword.lower() in title.lower():
            end = task_starts[idx + 1] if idx + 1 < len(task_starts) else len(lines)
            # trim trailing blank lines
            while end > start and not lines[end - 1].strip():
                end -= 1
            block = "\n".join(lines[start:end])
            return start, end, block
    return None

def _plan_set_status(content: str, status_icon: str) -> str:
    """Change the status line of the active (first IN_PROGRESS) task."""
    return re.sub(
        r"(Status:\s*`)\[\/\] IN_PROGRESS(`)",
        rf"\1{status_icon}\2",
        content,
        count=1,
    )

def _plan_find_first_planned(content: str) -> tuple[int, int, str] | None:
    """Find the first task in the Planned Tasks section."""
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
    while end > task_start and not lines[end - 1].strip():
        end -= 1
    block = "\n".join(lines[task_start:end])
    return task_start, end, block

@restricted
async def cmd_plan_add(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Add a new task to Planned Tasks. Usage: /plan_add TITLE | DESCRIPTION | PRIORITY"""
    text = " ".join(context.args) if context.args else ""
    if not text or "|" not in text:
        await update.message.reply_text(
            "📝 استعمال: `/plan_add Task Title | Description here | high`\n"
            "الأقسام مفصولة بـ `|`\n"
            "الاولوية: critical, high, medium, low"
        )
        return

    parts = [p.strip() for p in text.split("|")]
    title = parts[0]
    desc = parts[1] if len(parts) > 1 else "وصف المهمة"
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
        await update.message.reply_text("❌ Plan.md غير موجود.")
        return

    # Insert before "## Completed Tasks" or "## Blocked Tasks" section
    insert_before = "## Completed Tasks"
    replace_with = f"## Planned Tasks\n\n{new_task.strip()}\n\n## Completed Tasks"
    if insert_before in content:
        content = content.replace(insert_before, replace_with, 1)
    else:
        # Append to Planned Tasks section
        planned_marker = "## Planned Tasks"
        if planned_marker in content:
            content = content.replace(planned_marker, f"{planned_marker}\n\n{new_task.strip()}", 1)
        else:
            # Add section before Completed
            content += f"\n\n## Planned Tasks\n\n{new_task.strip()}\n"

    _plan_write(content)
    await update.message.reply_text(f"✅ تمت إضافة المهمة: **{title}** (Priority: {priority})")

@restricted
async def cmd_plan_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Move a planned task to active. Usage: /plan_start keyword"""
    if not context.args:
        await update.message.reply_text("📝 استعمال: `/plan_start keyword`\nمثال: /plan_start quality")
        return

    keyword = " ".join(context.args)
    content = _plan_read()
    if not content:
        await update.message.reply_text("❌ Plan.md غير موجود.")
        return

    # Find the task in Planned Tasks section
    found = _plan_find_task(content, keyword)
    if not found:
        await update.message.reply_text(f"❌ لم يتم العثور على مهمة بـ: `{keyword}`\nاستخدم /plan لعرض المهام.")
        return

    start, end, block = found

    # Check it's in PLANNED status
    if "[ ] PLANNED" not in block:
        await update.message.reply_text("❌ المهمة ليست في حالة PLANNED. الحالة الحالية:\n" + block[:500])
        return

    # Update status to IN_PROGRESS
    new_block = block.replace("- Status: `[ ] PLANNED`", "- Status: `[/] IN_PROGRESS`")
    new_block = new_block.replace("- Started: pending", f"- Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")

    lines = content.split("\n")
    lines = lines[:start] + new_block.split("\n") + lines[end:]
    new_content = "\n".join(lines)

    _plan_write(new_content)
    await update.message.reply_text(f"✅ تم نقل المهمة إلى **نشطة**:\n`{block.split(chr(10))[0].strip()}`")

@restricted
async def cmd_plan_done(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Mark current active (IN_PROGRESS) task as completed."""
    content = _plan_read()
    if not content:
        await update.message.reply_text("❌ Plan.md غير موجود.")
        return

    # Find current IN_PROGRESS task
    match = re.search(r"### (.+?)\n.*?Status:\s*`\[/\] IN_PROGRESS`", content, re.DOTALL)
    if not match:
        await update.message.reply_text("❌ لا توجد مهمة نشطة (IN_PROGRESS).")
        return

    title = match.group(1).strip()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Update status
    content = re.sub(
        r"(Status:\s*`)\[/\] IN_PROGRESS(`)",
        r"\1[x] COMPLETED\2",
        content,
        count=1,
    )
    content = re.sub(
        r"(- Completed: )pending",
        rf"\1{today}",
        content,
        count=1,
    )

    _plan_write(content)
    await update.message.reply_text(f"✅ تم إكمال المهمة: **{title}**")

@restricted
async def cmd_plan_block(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Mark a task as blocked. Usage: /plan_block keyword | reason"""
    text = " ".join(context.args) if context.args else ""
    if not text:
        await update.message.reply_text("📝 استعمال: `/plan_block keyword | reason`\nمثال: /plan_block build | missing CI token")
        return

    parts = [p.strip() for p in text.split("|", 1)]
    keyword = parts[0]
    reason = parts[1] if len(parts) > 1 else "blocked"

    content = _plan_read()
    if not content:
        await update.message.reply_text("❌ Plan.md غير موجود.")
        return

    found = _plan_find_task(content, keyword)
    if not found:
        await update.message.reply_text(f"❌ لم يتم العثور على مهمة بـ: `{keyword}`")
        return

    start, end, block = found

    new_block = block
    new_block = re.sub(r"Status:\s*`\[/?\]\s*\w+`", "- Status: `[!] BLOCKED`", new_block)
    if "Notes:" in new_block:
        new_block = new_block.replace("Notes:", f"Notes:\n  - Blocked: {reason}")
    else:
        new_block += f"\n- Notes:\n  - Blocked: {reason}"

    lines = content.split("\n")
    lines = lines[:start] + new_block.split("\n") + lines[end:]
    _plan_write("\n".join(lines))

    await update.message.reply_text(f"⛔ تم تعطيل المهمة: **{keyword.strip('#')}**\nالسبب: {reason}")

@restricted
async def cmd_git(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("📝 استعمال: /git <args>\nمثال: /git status\nمثال: /git log --oneline -5")
        return

    command = "git " + " ".join(context.args)
    result = await run_cmd(command)
    output = result[1] + ("\n⚠️ " + result[2] if result[2] else "")
    output = trim_output(output.strip() or "✅ انتهى")
    await update.message.reply_text(f"```\n{output}\n```")

@restricted
async def cmd_opencode(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text(
            "📝 استعمال: /opencode <prompt>\n"
            "مثال: /opencode Check for any lint errors and fix them"
        )
        return

    prompt = " ".join(context.args)
    msg = await update.message.reply_text(f"🤖 جاري تشغيل opencode...\n\n`{prompt[:200]}{'...' if len(prompt)>200 else ''}`")

    cmd = (
        f"cd {PROJECT_DIR} && "
        f"PATH=\"/home/ubuntu/.opencode/bin:$PATH\" "
        f"{OPENCODE_BIN} run --model \"opencode/big-pickle\" --auto {shlex_quote(prompt)}"
    )

    try:
        code, out, err = await run_cmd(cmd, timeout=600)
        output = out.strip()[:3000] or "✅ انتهى (بدون مخرجات)"
        await msg.edit_text(f"**✅ opencode** (exit: {code})\n```\n{output}\n```")
    except Exception as e:
        await msg.edit_text(f"❌ خطأ: {e}")

def shlex_quote(s):
    """Simple shell quoting."""
    return "'" + s.replace("'", "'\\''") + "'"

@restricted
async def cmd_build(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = await update.message.reply_text("🔨 جاري البناء...")
    code, out, err = await run_cmd("pnpm build", timeout=300)
    output = out.strip()[:3000] or ""
    if err:
        output += "\n⚠️ " + err[:500]
    status = "✅" if code == 0 else "❌"
    await msg.edit_text(f"{status} **Build** (exit: {code})\n```\n{output}\n```")

@restricted
async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    if chat_id in running_execs:
        running_execs[chat_id].kill()
        await update.message.reply_text("🛑 تم إلغاء الأمر.")
    else:
        await update.message.reply_text("لا يوجد أمر قيد التشغيل.")

# ──────────────────────────────────────────────────────
# Error handler
# ──────────────────────────────────────────────────────
async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    print(f"Error: {context.error}", file=sys.stderr)

# ──────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────
def main():
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("register", cmd_register))
    app.add_handler(CommandHandler("unregister", cmd_unregister))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("log", cmd_log))
    app.add_handler(CommandHandler("start_agent", cmd_start_agent))
    app.add_handler(CommandHandler("stop_agent", cmd_stop_agent))
    app.add_handler(CommandHandler("restart_agent", cmd_restart_agent))
    app.add_handler(CommandHandler("exec", cmd_exec))
    app.add_handler(CommandHandler("quality", cmd_quality))
    app.add_handler(CommandHandler("plan", cmd_plan))
    app.add_handler(CommandHandler("plan_add", cmd_plan_add))
    app.add_handler(CommandHandler("plan_start", cmd_plan_start))
    app.add_handler(CommandHandler("plan_done", cmd_plan_done))
    app.add_handler(CommandHandler("plan_block", cmd_plan_block))
    app.add_handler(CommandHandler("git", cmd_git))
    app.add_handler(CommandHandler("opencode", cmd_opencode))
    app.add_handler(CommandHandler("build", cmd_build))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_error_handler(error_handler)

    print("NOVA Bot started...", flush=True)
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
