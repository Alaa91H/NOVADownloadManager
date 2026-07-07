# Project Plan

## Rules
- Work is executed from top to bottom by priority.
- Only one task may be "IN_PROGRESS" at a time.
- Unfinished tasks must be resumed before new tasks start.
- Completed tasks older than 30 full days must be removed from this file.
- Every task must include start date, completion date, status, branch, PR link if available, validation results, and notes.
- Major changes require research and a written plan before implementation.
- Stable releases require full validation before publishing.

## Status Legend
- "[ ] PLANNED"
- "[/] IN_PROGRESS"
- "[x] COMPLETED"
- "[!] BLOCKED"
- "[-] CANCELLED"

---

# NOVA Development Constitution

هذا القسم يحدد النهج الثابت الذي يتبعه الوكيل في كل دورة عمله. أي انحراف عن هذه المبادئ يجب تبريره.

## المبادئ الأساسية

### 1. 🚫 لا بناء على السيرفر
السيرفر (1GB RAM) **للإدارة فقط**:
- ❌ **ممنوع**: تشغيل `pnpm build`, `pnpm tauri:build`, `pnpm test:coverage` (E2E), أو أي build ثقيل
- ✅ **مسموح**: `pnpm install`, `pnpm lint`, `pnpm lint:eslint`, `pnpm format:check`, `pnpm test` (unit tests فقط), `git` operations
- ✅ **مسموح**: `pnpm audit:final` (خفيف)
- البناء والتجميع يتم عبر **GitHub Actions** فقط

### 2. 🔍 بحث معمق قبل كل قرار
قبل تنفيذ أي تغيير:
1. ابحث عن **أحدث إصدار مستقر** للمكتبات والأدوات
2. تأكد من **التوافق** مع البيئة الحالية (Node 24, pnpm 11, Rust, Tauri 2)
3. اقرأ التوثيق الرسمي
4. تأكد من عدم وجود **breaking changes**
5. ابحث عن **أفضل الممارسات** (best practices)
6. قيم **التأثير** على الأداء والاستقرار والحجم

### 3. 🔄 دورة التطوير المستمر
```
[Git Sync] → [Research] → [Write Code] → [Local Quality Gates]
    → [Commit & Push] → [CI Workflow (GitHub Actions)]
        → [Monitor CI] → [Success? → Continue | Failure → Fix & Repeat]
```

### 4. 🧹 الجودة أولاً
- **لا`any` أبداً** — استخدم `unknown` وحوّله
- **أنواع صريحة** لكل function و component prop
- **حالات الخطأ والتحميل والفارغ** لكل مكون
- **Error boundaries** للمكونات الأساسية
- **اختبارات** لكل حالة: نجاح، فشل، تحميل، فارغ، حافة
- **Selectors محسّنة** في Zustand (لا إعادة تصيير غير ضرورية)

### 5. 📈 التغطية (Coverage) — الطريق إلى 100%
| المرحلة | الهدف | الحالة |
|---------|-------|--------|
| 1 | **10%** | ⬜ |
| 2 | **25%** | ⬜ |
| 3 | **50%** | ⬜ |
| 4 | **75%** | ⬜ |
| 5 | **100%** | ⬜ |
- كل مرحلة تتطلب E2E tests + unit tests
- التركيز أولاً على المكونات الحرجة (downloads, settings, tasks)

### 6. 📋 خطة العمل قبل التنفيذ
أي مهمة كبيرة تتطلب:
1. وصف المشكلة أو الهدف
2. خيارات متعددة مع تحليل利弊
3. الخيار الموصى به مع التبرير
4. خطة التنفيذ خطوة بخطوة
5. معايير النجاح (acceptance criteria)

### 7. 🤖 تطوير البوت تلغرام المستمر
البوت (`nova-bot.py`) يجب أن يتطور ليشمل:
- **التحكم الكامل**: كل ما يقدر الوكيل يسويه، البوت يقدر يتحكم فيه
- **الأوامر الجدبدة**: بحث، تخطيط، تحليل، تقارير
- **تقارير دورية**: ملخص أسبوعي للتقدم، التنبيهات
- **مراقبة متقدمة**: CI status, coverage trends, performance metrics

---

## Active Task

### AGENT-001 — Full autonomous development pipeline

- Status: `[/] IN_PROGRESS`
- Priority: critical
- Type: infra
- Started: 2026-07-07
- Completed: pending
- Objective:
  - Make the agent fully autonomous following الـ NOVA Development Constitution
- Notes:
  - Server: Ubuntu 24.04 (1GB RAM + 8GB swap)
  - Model: opencode/big-pickle (free via Zen)

---

## Planned Tasks

### CI-001 — Add Dev trigger to build.yml + quality workflow

- Status: `[ ] PLANNED`
- Priority: critical
- Type: ci
- Started: pending
- Completed: pending
- Objective:
  - Modify `.github/workflows/build.yml` to trigger on `Dev` branch pushes (not just main/master). Create dedicated `.github/workflows/quality.yml` for fast feedback on every push.
- Plan:
  1. Add `Dev` to build.yml triggers (push + PR)
  2. Create quality.yml: lint → typecheck → test → build → audit (runs on every Dev push)
  3. quality.yml fails fast (no continue-on-error) — الوكيل يصلح الخطأ فوراً
  4. Remove continue-on-error from build.yml validate job or keep it for summary

### CI-002 — GitHub Actions E2E workflow (Playwright + xvfb)

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Started: pending
- Completed: pending
- Objective:
  - Create `.github/workflows/e2e.yml` that runs Playwright E2E tests headlessly and reports coverage.
- Plan:
  1. Install Playwright with Chromium and system deps
  2. Run tests via xvfb-run
  3. Upload coverage report as artifact
  4. Fail if coverage below current target
  5. Trigger: push to Dev + workflow_dispatch

### CI-003 — GitHub Actions cross-platform build matrix

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Started: pending
- Completed: pending
- Objective:
  - Expand build.yml to multi-platform matrix: Windows x64, Linux x64, macOS x64 + ARM64.
- Plan:
  1. Matrix strategy with os + arch + target triple
  2. Use tauri-actions for cross-compilation
  3. Upload build artifacts per platform
  4. Trigger: tag push + workflow_dispatch

### CI-004 — GitHub Actions release automation

- Status: `[ ] PLANNED`
- Priority: medium
- Type: ci
- Started: pending
- Completed: pending
- Objective:
  - Create release workflow: versioning, changelog, multi-platform binaries, GitHub release.
- Plan:
  1. Trigger: tag push or workflow_dispatch with version
  2. Run full build matrix
  3. Generate changelog from conventional commits
  4. Create GitHub release with all assets

### TEST-001 — Write E2E test suites (10 files, 10% coverage)

- Status: `[ ] PLANNED`
- Priority: high
- Type: testing
- Started: pending
- Completed: pending
- Objective:
  - Write 10 E2E test files under `src/e2e/` covering all major features. Reach 10% coverage.
- Files:
  - `src/e2e/downloads.spec.ts` — إنشاء, إيقاف, حذف تحميل
  - `src/e2e/settings.spec.ts` — تغيير الإعدادات وحفظها
  - `src/e2e/scheduler.spec.ts` — جدولة التحميلات
  - `src/e2e/sidebar.spec.ts` — التنقل بين الأقسام
  - `src/e2e/i18n.spec.ts` — تغيير اللغة
  - `src/e2e/tasks.spec.ts` — إدارة المهام
  - `src/e2e/queue.spec.ts` — طابور التحميل
  - `src/e2e/api.spec.ts` — اختبار API calls
  - `src/e2e/ui-components.spec.ts` — المكونات الأساسية
  - `src/e2e/navigation.spec.ts` — نظام التنقل
- Plan:
  1. Install @playwright/test
  2. Configure playwright.config.ts (chromium only, headless)
  3. Write all 10 test files
  4. Ensure tests pass locally
  5. Push — CI runs them in GitHub Actions

### AGENT-002 — CI monitoring & auto-fix

- Status: `[ ] PLANNED`
- Priority: high
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent monitors GitHub Actions after each push. On failure: fetch logs, analyze, fix in next cycle.
- Plan:
  1. Use gh CLI to get latest workflow run
  2. Wait for completion (timeout 5 min)
  3. On failure: save run ID + logs to `.last-ci-failure`
  4. Next cycle: read failure, analyze, fix code
  5. Notify via Telegram
  6. Re-push after fix → new CI run
- Notes:
  - Implemented in nova-dev-agent.sh: `monitor_workflow()` function

### AGENT-003 — Agent release automation

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent triggers releases via gh CLI: determine version, dispatch workflow, monitor, notify.
- Plan:
  1. Read version from package.json
  2. Determine next version (semver)
  3. Create tag + push
  4. Dispatch release workflow via gh
  5. Monitor until complete
  6. Notify via Telegram with download links

### AGENT-004 — Agent self-maintenance

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Self-healing: log rotation, disk cleanup, health monitoring, auto-restart if stuck.
- Plan:
  1. Log rotation: archive logs > 7 days
  2. Disk cleanup: prune old builds, temp files
  3. Health check: disk space, memory, responsiveness
  4. Auto-restart if no output for 30 min
  5. Telegram notifications for all maintenance

### AGENT-005 — Full quality hardening

- Status: `[ ] PLANNED`
- Priority: medium
- Type: refactor
- Started: pending
- Completed: pending
- Objective:
  - Refactor entire codebase: strict types, error handling, performance, no dead code.
- Plan:
  1. Fix all TypeScript strict errors
  2. Replace any with unknown everywhere
  3. Error boundaries on all components
  4. Loading/empty/error states everywhere
  5. Optimize Zustand selectors
  6. Remove dead code
  7. Proper return types

### BOT-002 — Evolve Telegram bot for full control

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Evolve nova-bot.py to match all agent capabilities for complete server/agent control.
- New commands:
  - /research `topic` — يقوم الوكيل ببحث متعمق ويعيد تقرير
  - /plan_new `objective` — الوكيل يكتب خطة كاملة في Plan.md
  - /report — تقرير أسبوعي شامل (التقدم، CI, coverage, errors)
  - /ci_history — آخر 10 CI runs مع النتائج
  - /coverage — التغطية الحالية + الاتجاه
  - /audit — تشغيل التدقيق الأمني
  - /clean — تنظيف السيرفر (مسح مؤقت)
  - /research_before `task` — بحث قبل تنفيذ مهمة
  - /rollback — العودة لآخر commit ناجح
  - /diff — عرض الفرق مع آخر commit

### COVERAGE-001 — Reach 10% coverage

- Status: `[ ] PLANNED`
- Priority: high
- Type: testing
- Started: pending
- Completed: pending
- Objective:
  - Achieve 10%+ code coverage through unit + E2E tests.
- Prerequisites: TEST-001 (E2E tests written), CI-002 (E2E workflow)

### COVERAGE-002 — Reach 25% coverage

- Status: `[ ] PLANNED`
- Priority: medium
- Type: testing
- Started: pending
- Completed: pending
- Objective:
  - Expand test coverage to 25%+.

### COVERAGE-003 — Reach 50% coverage

- Status: `[ ] PLANNED`
- Priority: medium
- Type: testing
- Started: pending
- Completed: pending

### COVERAGE-004 — Reach 75% coverage

- Status: `[ ] PLANNED`
- Priority: medium
- Type: testing
- Started: pending
- Completed: pending

### COVERAGE-005 — Reach 100% coverage

- Status: `[ ] PLANNED`
- Priority: low
- Type: testing
- Started: pending
- Completed: pending

---

## Completed Tasks

### BOT-001 — Telegram bot for agent control & notifications

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Full Telegram bot: /start, /status, /log, /exec, /quality, /plan management, /git, /opencode, /build
  - Agent sends automatic notifications at each cycle phase
  - Systemd service nova-bot.service running in parallel with nova-dev-agent.service
  - Commands: /register, /plan_add, /plan_start, /plan_done, /plan_block for task management

### INFRA-001 — Set up continuous development infrastructure

- Status: `[x] COMPLETED`
- Priority: critical
- Type: ci
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Plan.md, Dev branch, opencode 1.17.14 installed
  - systemd service 24/7, Zen Big Pickle, 8GB swap

### INFRA-002 — Agent script with Telegram notifications

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Agent reads Plan.md, reports active task, notifies via Telegram
  - Tracks cycle duration, rate-limit handling, CI monitoring

---

## Blocked Tasks

*None yet.*
