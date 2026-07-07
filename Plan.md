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

هذا القسم يحدد النهج الثابت الذي يتبعه الوكيل في **كل دورة عمله**. أي انحراف يتطلب تبرير في الـ commit message.

## المبادئ الأساسية

### 1. 🚫 لا بناء على السيرفر
السيرفر (1GB RAM) **للإدارة فقط**:
- ❌ **ممنوع نهائياً**: `pnpm build`, `pnpm tauri:build`, `pnpm tauri:dev`, `pnpm test:coverage` (E2E), `pnpm release`, أو أي build ثقيل
- ✅ **مسموح**: `pnpm install`, `pnpm lint`, `pnpm lint:eslint`, `pnpm format:check`, `pnpm test` (unit tests فقط), `pnpm audit:final`, git operations, gh CLI
- البناء والتجميع والنشر → **GitHub Actions** فقط

### 2. 🔍 بحث عميق قبل كل قرار (Research-First)
قبل إضافة مكتبة، تغيير architecture، أو أي قرار تقني كبير:
1. **ابحث في npm / crates.io / GitHub** عن أحدث إصدار مستقر
2. **اقرأ Changelog** — تأكد من عدم وجود breaking changes ضد Node 24, pnpm 11, Tauri 2
3. **قارن البدائل** — على الأقل 3 خيارات مع تحليل优缺点
4. **اقرأ التوثيق الرسمي** + GitHub issues للمشاكل المعروفة
5. **قيّم التأثير**: حجم الحزمة، أداء، استقرار، أمان، تراخيص
6. **وثّق القرار** في Notes المهمة أو في ملف RESEARCH.md
7. إذا كان القرار خطير (مثلاً تغيير الـ state management)، اكتب خطة كاملة أولاً

### 3. 🤖 الإدارة الذاتية الكاملة (Self-Directed)
الوكيل **لا ينتظر أوامر** — هو يدير نفسه بنفسه:
- **تحليل الـ Codebase**: كل دورة يفحص الكود ويحدد نقاط الضعف والتحسين
- **توليد المهام**: يضيف مهام جديدة لـ Plan.md بشكل استباقي (قبل ما تطلبها أنت)
- **التخطيط الاحترافي**: المهام الكبيرة تبدأ بخطة (خيارات، تحليل، خطة تنفيذ)
- **البحث الاستباقي**: قبل تنفيذ أي شيء، يبحث عن أفضل الممارسة
- **إدارة الـ Repo**: branches, PRs, issues, labels, milestones — كل شيء عبر gh CLI
- **التقارير التلقائية**: كل دورة يرسل تحديث شامل عبر تلغرام

### 4. 🔄 دورة التطوير المتقدمة
```
[Git Sync] → [Codebase Scan] → [Generate/Update Tasks] → [Research]
    → [Write Professional Plan] → [Implement] → [Local Quality Gates]
    → [Commit & Push] → [Create PR (if needed)] → [CI Workflow (GitHub)]
        → [Monitor CI] → [Success? → Next Task | Failure → Analyze & Fix]
            → [Report via Telegram]
```

### 5. 🧹 الجودة المطلقة
- **لا`any` أبداً مطلقاً** — استخدم `unknown` + type guards
- **أنواع صريحة** لكل function, prop, state, store, API response
- **كل component** له 4 حالات: `loading | empty | error | success`
- **Error boundaries** حول كل feature (downloads, settings, tasks, queue)
- **Tests**: unit + E2E لكل حالة (normal, edge, error, empty)
- **Zustand**: selectors محسّنة، no inline object/array creation في hooks
- **No dead code, no console.log في production, no commented-out code**

### 6. 📈 التغطية (Coverage) — الطريق إلى 100%
| المرحلة | الهدف | الطريقة |
|---------|-------|---------|
| 1 | **10%** | 10 E2E test files + unit tests للمكونات الرئيسية |
| 2 | **25%** | توسيع E2E + unit لكل services و stores |
| 3 | **50%** | كل components + hooks + utilities |
| 4 | **75%** | كل الكود ما عدا i18n dictionaries |
| 5 | **100%** | كل شيء بما فيها i18n و scripts |

### 7. 📋 التخطيط الاحترافي (Professional Planning)
أي مهمة ذات scope متوسط أو كبير (أكثر من 50 سطر تغيير):
1. **تحليل المشكلة**: ما هي المشكلة الحقيقية؟ (5 Whys)
2. **خيارات متعددة**: على الأقل 2-3 حلول ممكنة مع:
   - المميزات (Pros)
   - العيوب (Cons)
   - التأثير على الأداء والحجم والصيانة
   - التجارب السابقة والدروس المستفادة
3. **الخيار الموصى به**: مع تبرير واضح
4. **خطة التنفيذ**: خطوات محددة، ملفات ستتغير، estimated time
5. **Acceptance Criteria**: كيف نعرف أن المهمة اكتملت بنجاح
6. **معايير الرفض**: متى نتراجع عن التغيير

### 8. 🌳 إدارة الـ Repo الكاملة
الوكيل يدير الـ repository بالكامل:
- **Branches**: `feat/<task-id>`, `fix/<task-id>`, `chore/<task-id>`, `refactor/<task-id>`
- **PRs**: ينشئ PR مع وصف واضح، ويربطه بالمهمة في Plan.md
- **Commits**: Conventional commits (feat, fix, chore, test, refactor, docs, ci)
- **Issues**: ينشئ issues للمشاكل الكبيرة أو الاقتراحات
- **Labels**: يضيف labels تصنيفية للمهام
- **Milestones**: ينشئ milestones للإصدارات
- **Code Review**: يراجع PRs الموجودة ويعلق عليها

### 9. 🩺 الصيانة الذاتية والتدقيق الدوري (Self-Audit)
كل دورة أو بشكل دوري:
- **Scan dependencies**: npm audit, outdated packages, security advisories
- **Scan codebase**: deprecation warnings, dead code, code smells
- **Performance**: bundle size, build time, test time
- **Security**: check for secrets in code, CSP headers, dependency vulnerabilities
- **Disk cleanup**: node_modules/.cache, dist, old builds, logs
- **Health check**: service status, disk space, memory, swap usage

### 10. 🤖 تطوير البوت تلغرام المستمر
البوت (`nova-bot.py`) يجب أن يتطور مع الوكيل:
- **كل قدرة للوكيل = أمر في البوت**
- البحث، التخطيط، التقارير، التحكم الكامل بالسيرفر
- واجهة تحكم متقدمة: لوحة قيادة، تقارير دورية، تنبيهات فورية

### 11. 📊 التقارير التلقائية
بعد كل دورة:
- **Telegram**: ملخص ما تم، المدة، CI status, الأخطاء إن وجدت
- **Plan.md**: تحديث الـ status تلقائياً
- **State file**: `.agent-state.json` يُحدّث بكل التفاصيل

### 12. 🔐 الأمان والسرية
- لا تكتب أبداً tokens, keys, كلمات مرور في الكود
- استخدم environment variables لكل الأسرار
- لا تكتب path محلية أو user-specific data
- لا تذكر "AI" أو "agent" أو "LLM" في أي commit, PR, issue, comment

---

## Active Task

### AGENT-001 — Full autonomous development pipeline

- Status: `[/] IN_PROGRESS`
- Priority: critical
- Type: infra
- Started: 2026-07-07
- Completed: pending
- Objective:
  - Make the agent fully autonomous following the NOVA Development Constitution above
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
  - Modify `.github/workflows/build.yml` to trigger on `Dev` pushes. Create dedicated `quality.yml` for fast feedback.
- Plan:
  1. Add `Dev` to build.yml triggers (push + PR)
  2. Create quality.yml: lint → typecheck → test → build → audit
  3. quality.yml fails fast (no continue-on-error)

### CI-002 — GitHub Actions E2E workflow

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Started: pending
- Completed: pending
- Objective:
  - Create `.github/workflows/e2e.yml` with Playwright + xvfb, coverage reports.

### CI-003 — Cross-platform build matrix

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Started: pending
- Completed: pending
- Objective:
  - Multi-platform matrix: Windows x64, Linux x64, macOS x64 + ARM64.

### CI-004 — Release automation

- Status: `[ ] PLANNED`
- Priority: medium
- Type: ci
- Started: pending
- Completed: pending
- Objective:
  - Create release workflow: versioning, changelog, multi-platform binaries, GitHub release.

### TEST-001 — Write E2E test suites (10 files, 10% coverage)

- Status: `[ ] PLANNED`
- Priority: high
- Type: testing
- Started: pending
- Completed: pending
- Objective:
  - Write 10 E2E test files under `src/e2e/` covering all features. Reach 10% coverage.
- Files:
  - `src/e2e/downloads.spec.ts`, `settings.spec.ts`, `scheduler.spec.ts`, `sidebar.spec.ts`, `i18n.spec.ts`
  - `src/e2e/tasks.spec.ts`, `queue.spec.ts`, `api.spec.ts`, `ui-components.spec.ts`, `navigation.spec.ts`

### AGENT-002 — CI monitoring & auto-fix

- Status: `[ ] PLANNED`
- Priority: high
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent monitors CI after each push. On failure: fetch logs → analyze → fix in next cycle.
- Notes: Implemented in nova-dev-agent.sh (`monitor_workflow()`)

### AGENT-003 — Agent release automation

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent triggers releases via gh CLI: version → tag → dispatch → monitor → notify.

### AGENT-004 — Agent self-maintenance

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Self-healing: log rotation, disk cleanup, health monitoring, auto-restart if stuck.

### AGENT-005 — Full quality hardening

- Status: `[ ] PLANNED`
- Priority: medium
- Type: refactor
- Started: pending
- Completed: pending
- Objective:
  - Refactor codebase: strict types, error handling, performance, no dead code.

### AGENT-006 — Self-directed task generation

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent analyzes codebase each cycle, identifies issues proactively, generates tasks in Plan.md.
- Plan:
  1. Each cycle: scan for lint/TS errors, deprecation warnings, missing tests, code smells
  2. Add new tasks to Plan.md automatically with priority
  3. Re-prioritize existing tasks based on impact
  4. Report new findings via Telegram

### AGENT-007 — Professional planning workflow

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Before any medium/large task, agent writes professional plan: research, options, recommendation, execution plan.
- Plan:
  1. Detect scope of task (>50 lines or architectural change)
  2. Research phase: read docs, check alternatives, compare versions
  3. Write plan in Plan.md under the task
  4. Optionally request approval via Telegram (if high risk)
  5. Execute plan step by step with validation after each step

### AGENT-008 — Deep research capability

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent researches npm, crates.io, GitHub, and web for best choices before decisions.
- Commands/tools:
  1. npm view <package> versions, dependencies, downloads
  2. curl crates.io/api/v1/crates/<name> for Rust crate info
  3. gh search issues for known problems
  4. curl GitHub API for release info
  5. Document findings in Notes

### AGENT-009 — Full repo management (branches, PRs, issues)

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent manages repo autonomously: create branches, PRs, issues, milestones, labels.
- Plan:
  1. Each task gets its own branch: `feat/`, `fix/`, `chore/`, `refactor/`, `test/`
  2. After local quality gates, push branch and create PR to Dev
  3. PR includes: summary, changes, validation results, risks
  4. If CI fails on PR branch, fix and push again
  5. Merge PR when CI passes
  6. Create issues for bugs found in codebase scan

### AGENT-010 — Self-audit & proactive improvement

- Status: `[ ] PLANNED`
- Priority: low
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent runs periodic audits: dependencies, security, performance, code smells, deprecations.
- Plan:
  1. npm audit + pnpm outdated weekly
  2. Bundle size analysis (vite build --report)
  3. Security scan (secrets, CSP, deps)
  4. Deprecation scan (TypeScript, ESLint warnings)
  5. Performance audit (build time, test time, bundle)
  6. Disk usage (node_modules, dist, cache)
  7. Fix found issues proactively (add tasks, fix directly if small)

### BOT-002 — Evolve Telegram bot for full control

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Evolve nova-bot.py to match all agent capabilities for complete control.
- New commands:
  - /research `topic` — بحث متعمق + تقرير
  - /plan_new `objective` — كتابة خطة احترافية في Plan.md
  - /report — تقرير شامل (التقدم، CI, coverage, errors, disk)
  - /ci_history — آخر 10 CI runs
  - /coverage — التغطية + الاتجاه
  - /audit — تدقيق أمني + تبعيات
  - /clean — تنظيف السيرفر
  - /research_before `task` — بحث قبل التنفيذ
  - /rollback — العودة لآخر commit ناجح
  - /diff — الفرق مع آخر commit
  - /branches — قائمة الفروع
  - /prs — PRs المفتوحة
  - /issues — المشاكل المفتوحة
  - /schedule `interval` — تغيير دورة الوكيل

### COVERAGE-001 → 005 — Coverage targets 10% → 100%

- Status: `[ ] PLANNED` (×5)
- Priority: high → low
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
  - Telegram bot with /start, /status, /log, /exec, /quality, /plan management, /git, /opencode, /build, /register, /myid
  - Agent sends automated notifications at each cycle phase
  - Systemd nova-bot.service + nova-dev-agent.service running

### INFRA-001 — Set up continuous development infrastructure

- Status: `[x] COMPLETED`
- Priority: critical
- Type: ci
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Plan.md, Dev branch, opencode 1.17.14, systemd service 24/7, Zen Big Pickle, 8GB swap

### INFRA-002 — Agent script with Telegram notifications + CI monitoring

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Agent reads Plan.md, reports active task, CI monitoring via gh, auto-fix on failure

---

## Blocked Tasks

*None yet.*
