#!/usr/bin/env python3
"""Generate an end-of-day summary of repository activity (plain language, no
code) and append it to the notification event journal for delivery."""
import json
import os
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

REPO = os.environ.get("NOVA_PROJECT_DIR", os.path.join(os.path.expanduser("~"), "NOVA"))
VAR_DIR = os.environ.get("NOVA_VAR_DIR", "/var/lib/nova")
EVENTS_FILE = os.environ.get("NOVA_EVENTS_FILE", os.path.join(VAR_DIR, "events.jsonl"))
BRANCH = os.environ.get("NOVA_BRANCH") or os.environ.get("NOVA_DEVELOP_BRANCH", "develop")
TZ = ZoneInfo("Europe/Berlin")

TYPE_AR = {
    "fix": "🛠️ إصلاحات", "feat": "🧩 تطوير", "refactor": "✨ إعادة هيكلة",
    "perf": "⚡ أداء", "docs": "📝 توثيق", "test": "🧪 اختبارات",
    "style": "🎨 تنسيق", "build": "🏗️ بناء", "ci": "🔧 تكامل مستمر",
    "chore": "🧹 صيانة",
}


def git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", "-C", REPO, *args],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
    except Exception:
        return ""


def main() -> None:
    now = datetime.now(TZ)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    since = f"@{int(midnight.timestamp())}"
    date_label = now.strftime("%Y-%m-%d")

    subjects = [s for s in git("log", f"--since={since}", "--no-merges",
                               "--pretty=%s", BRANCH).split("\n") if s]
    files = [f for f in git("log", f"--since={since}", "--no-merges",
                            "--name-only", "--pretty=format:", BRANCH).split("\n") if f]

    if not subjects:
        state = {}
        try:
            state = json.load(open(os.path.join(VAR_DIR, ".agent-state.json"), encoding="utf-8"))
        except Exception:
            pass
        phase = state.get("phase", "—")
        msg = (f"📊 الملخّص اليومي — {date_label} (بتوقيت برلين)\n\n"
               f"لم تُسجَّل تغييرات على المستودع اليوم.\n"
               f"الحالة الحالية للمتحكم: {phase}.")
    else:
        counts: Counter = Counter()
        for s in subjects:
            t = s.split(":", 1)[0].split("(", 1)[0].strip().lower() if ":" in s else "other"
            counts[t if t in TYPE_AR else "chore"] += 1

        uniq_files = sorted(set(files))
        areas = Counter()
        for f in uniq_files:
            parts = f.split("/")
            area = "/".join(parts[:2]) if len(parts) > 1 else parts[0]
            areas[area] += 1
        top_areas = "، ".join(a for a, _ in areas.most_common(3)) or "—"

        lines = [f"📊 الملخّص اليومي — {date_label} (بتوقيت برلين)", ""]
        lines.append(f"اليوم أُنجزت {len(subjects)} تغييرات على المستودع (فرع {BRANCH}):")
        for t, _ in counts.most_common():
            lines.append(f"{TYPE_AR.get(t, '🧹 صيانة')}: {counts[t]}")
        lines.append("")
        lines.append("أبرز ما تغيّر:")
        for s in subjects[:6]:
            lines.append(f"• {s}")
        lines.append("")
        lines.append(f"📁 الأكثر تعديلاً: {top_areas}")
        lines.append(f"📈 إجمالي الملفات المتغيّرة: {len(uniq_files)}")
        head = git("log", "-1", "--pretty=%h %s", BRANCH)
        if head:
            lines.append(f"🔖 آخر تحديث: {head}")
        msg = "\n".join(lines)

    event = {
        "ts": int(time.time()),
        "iso": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "type": "daily_summary",
        "cycle": "daily",
        "task": "daily-summary",
        "title": f"الملخّص اليومي {date_label}",
        "kind": "system",
        "stream": "",
        "rc": 0,
        "dur": 0,
        "summary": msg,
        "branch": BRANCH,
    }
    os.makedirs(os.path.dirname(EVENTS_FILE), exist_ok=True)
    with open(EVENTS_FILE, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    print("daily digest appended:", len(subjects), "commits")


if __name__ == "__main__":
    main()
