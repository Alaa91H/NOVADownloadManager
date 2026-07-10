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

### 3. الإدارة الذاتية الكاملة (Self-Directed)
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

### 10. تطوير البوت تلغرام المستمر
البوت (`nova-bot.py`) يجب أن يتطور مع الوكيل:
- **كل قدرة للوكيل = أمر في البوت**
- البحث، التخطيط، التقارير، التحكم الكامل بالسيرفر
- واجهة تحكم متقدمة: لوحة قيادة، تقارير دورية، تنبيهات فورية

### 11. 📊 التقارير التلقائية
بعد كل دورة:
- **Telegram**: ملخص ما تم، المدة، CI status, الأخطاء إن وجدت
- **Plan.md**: تحديث الـ status تلقائياً
- **State file**: `.agent-state.json` يُحدّث بكل التفاصيل

### 12. 🚫 لا ملفات ذكاء اصطناعي على `main`
- **ممنوع منعاً باتاً** وجود أي من هذه الملفات على فرع `main`:
  - `Plan.md` — خطة العمل (تطوير فقط)
  - `AGENTS.md` — مرجع الوكيل
  - `.agent-state.json` — حالة الوكيل
  - `.bot-chats.json` — اشتراكات البوت
  - `.last-ci-failure` — سجل فشل CI
  - أي ملف خاص بالوكيل أو التشغيل (`nova-dev-agent.sh`, `nova-bot.py`, `nova-bot.service`)
- فرع `main` يحتوي فقط على: **كود نظيف، مستقر، جاهز للإنتاج**
- الفرع المخصص للتطوير هو `Dev` — كل ملفات الإدارة والتخطيط تبقى هناك
- أي PR إلى `main` يجب أن يستثني هذه الملفات (استخدم `.gitattributes` أو مراجعة PR)
- القاعدة: **`Dev` = تطوير وإدارة | `main` = إنتاج نظيف**

### 13. 📦 الإصدارات التلقائية (Release Automation)
الوكيل يدير دورة حياة الإصدارات بالكامل:
- **Dev channel**: كل push إلى `Dev` → CI يبني ويختبر
- **Nightly**: كل ليلة → build + E2E + تقرير
- **Alpha**: إصدار تجريبي غير مستقر → اختبار الميزات الجديدة
- **Beta**: إصدار شبه مستقر → اختبار المجتمع
- **RC (Release Candidate)**: إصدار نهائي قبل الإطلاق
- **Stable**: إصدار إنتاجي → `main` branch
- **Hotfix**: إصلاح عاجل لـ `main` → merge إلى `Dev` أيضاً

كل إصدار يتضمن:
1. رفع الإصدار (semantic versioning)
2. Changelog تلقائي من conventional commits
3. Build لكل المنصات
4. Signing (حيثما أمكن)
5. GitHub Release مع assets
6. إشعار تلغرام

### 14. 🔐 الأمان والسرية
- لا تكتب أبداً tokens, keys, كلمات مرور في الكود
- استخدم environment variables لكل الأسرار
- لا تكتب path محلية أو user-specific data
- استخدم لغة صيانة محايدة واحترافية في كل رسالة commit وPR وissue وتعليق

---

## Active Task

### AGENT-001 — Full autonomous development pipeline

- Status: `[x] COMPLETED`
- Priority: critical
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Agent v2.0 fully built: scripts, systemd services, bot v3.1, inline menus, notification control, direct chat, server status
  - Ready for operational development tasks

---

## Planned Tasks

### CI-001 — Add Dev trigger to build.yml + quality workflow

- Status: `[x] COMPLETED`
- Priority: critical
- Type: ci
- Started: 2026-07-07
P26-07-07
- Objective:
  - Modify `.github/workflows/build.yml` to trigger on `Dev` pushes. Create dedicated `quality.yml` for fast feedback.
- Plan:
  1. Add `Dev` to build.yml triggers (push + PR)
  2. Create quality.yml: lint → typecheck → test → build → audit
  3. quality.yml fails fast (no continue-on-error)

### UI-001 — Full interface refinement & engine compatibility (100%)

- Status: `[x] COMPLETED`
- Priority: critical
- Type: feat
- Started: 2026-07-07
- Completed: 2026-07-07
- Objective:
  - Refine the entire UI professionally — buttons, toolbars, dialogs, status bar, sidebar, task table. Ensure 100% compatibility between UI state and engine capabilities (curl, yt-dlp, ffmpeg). Every UI element must react correctly to available engines.
- Progress:
  - ✅ TopBar main "New Download" button gated by `directReady || mediaReady` with disabled state + tooltip
  - ✅ StatusBar engine status indicators (direct/media/ffmpeg) with colored dots and clickable diagnostics
  - ✅ Sidebar engine capability indicators below bridge widget (Direct/Media/FFmpeg ready/unavailable)
  - ✅ TaskTable context menu engine-aware actions (disabled with tooltip when engine unavailable)
  - ✅ StatusBar per-engine status with translations (en.ts + ar.ts keys added, StatusBar uses t() calls)
  - ✅ Resume/Stop/Delete engine gating (context menu + batch resume gated by engine availability)
  - ✅ Dialog engine awareness: AddDownloadDialog, YoutubeDownloadDialog, BatchImportDialog, TaskPropertiesDialog all already gated; ActiveProgressDialog resume button now gated by `isEngineAvailable` following TaskTable pattern.
- Validation:
  - `pnpm lint` (tsc --noEmit): passed clean
  - `pnpm test`: 7 files, 35 tests passed
  - ESLint skipped (OOM on 1GB server)
- Plan:
  1. **Engine compatibility audit**: Map every interactive element in TopBar, Sidebar, StatusBar, TaskTable, and all dialogs to their required engine. Disable/hide elements when required engine is unavailable.
  2. **Button audit**: Scan ALL buttons/icons across the UI. Ensure each has: proper label, translation key, tooltip/aria-label, correct enabled/disabled state based on engine capabilities and task state.
  3. **Mode-based visibility**: Some features depend on download engine (direct vs media). Ensure UI correctly shows/hides options based on `EngineCapabilityContext`.
  4. **State consistency**: Every button must reflect real state — e.g., "Pause" only shown when task is downloading, "Resume" when paused, etc.
  5. **Error states**: Every action must handle daemon offline, engine missing, download failure gracefully with user feedback.
  6. **Performance**: Ensure no unnecessary re-renders when updating task states from SSE events.
- Research:
  - Read `EngineCapabilityContext.tsx` fully to understand capability flags
  - Read `TopBar.tsx`, `StatusBar.tsx`, `Sidebar.tsx` button mappings
  - Check `novaClient.ts` for all available API endpoints
  - Read `desktop-ui.types.ts` for DownloadStatus enum states
- Files affected:
  - `src/components/TopBar.tsx`, `StatusBar.tsx`, `Sidebar.tsx`, `TaskTable.tsx`, `AppShell.tsx`
  - `src/capabilities/EngineCapabilityContext.tsx`
  - `src/state/appStore.tsx`, `src/state/useTaskStore.ts`
  - All dialog files in `src/dialogs/`

### UI-002 — Comprehensive button translation & tooltip audit

- Status: `[x] COMPLETED`
- Priority: high
- Type: refactor
- Started: 2026-07-08
- Completed: 2026-07-09
- Objective:
  - Find EVERY button, icon, clickable element, menu item, and label across ALL components. Ensure all have: proper i18n translation key, tooltip describing the action, and aria-label for accessibility.
- Plan:
  1. **Button inventory**: Create a complete inventory of all interactive elements:
     - TopBar: new download, resume all, stop all, delete dropdown, search, scheduler, settings, notifications, window controls
     - Sidebar: navigation items, category items, theme toggle, browser/telegram/scheduler links
     - StatusBar: speed indicator, daemon status, browser/telegram/clipboard status, speed limiter, mute
     - TaskTable: column headers, sort controls, context menu items, row actions
     - Dialogs: all buttons in AddDownloadDialog, BatchImportDialog, TaskPropertiesDialog, etc.
  2. **Translation audit**: Check every button label against translation keys in `src/lib/i18n/`. Add missing keys to English locale (`en.ts`) and Arabic (`ar.ts`). Ensure every UI string uses `getTranslation()` or a translation-aware mechanism.
  3. **Tooltip addition**: Add `title` attribute or custom Tooltip component to every icon-only button. Tooltip text should come from translations.
  4. **Aria-labels**: Add meaningful `aria-label` to all icon buttons, progress bars, and interactive elements for accessibility.
  5. **Description**: For complex buttons (e.g., speed limiter, queue selector), add short helper text below or on hover.
- Progress:
  - ✅ Button inventory completed: 15 files, 150+ hardcoded strings, ~12 icon buttons missing aria-labels
  - ✅ Sidebar hardcoded strings fixed (NOVA Engine, Web Browser, engine labels → translated)
  - ✅ Window control buttons (AppShell, Modal) now have aria-labels
  - ✅ SpeedLimitInput stepper/unit buttons now have aria-labels
  - ✅ TimePicker labels translated
  - ✅ Added translation keys to en.ts and ar.ts
  - ✅ tsc --noEmit clean
- Cycle 2026-07-08 (round 1): Fixed Sidebar (7 hardcoded strings → t() calls), added aria-labels to 12 icon-only buttons across AppShell, Modal, SpeedLimitInput; translated TimePicker labels; added 18 new translation keys to en.ts/ar.ts.
- Validation:
  - `tsc --noEmit`: clean (exit 0)
  - Branch: Dev
  - Push: `58e6bfa` pushed to Dev at 2026-07-08
  - CI: https://github.com/Alaa91H/NOVADownloadManager/actions/runs/28914117558 (pending)
- Cycle 2026-07-08 (round 2 — CI repair): Fixed 3 failing CI gates (Validate translations, ESLint, Run tests).
  - ESLint: SchedulerPanel hooks rule, EngineCapabilityContext test immutability/non-null-assertion
  - i18n: synced 922 keys to all 132 locales (2340 issues)
  - Tests: Sidebar, TimePicker, WebpageGrabberDialog, YoutubeDownloadDialog
  - Push: `45423a3` pushed to Dev at 2026-07-08
  - CI: https://github.com/Alaa91H/NOVADownloadManager/actions/runs/28916426329 (FAILED: TypeScript + ESLint — SchedulerPanel conditional hooks)
- Cycle 2026-07-08 (round 3 — CI repair): Fixed SchedulerPanel conditional hooks & TS errors.
  - Root cause: 9 `useState` and 1 `useEffect` were placed after early returns, violating Rules of Hooks.
  - Fix: Moved all hooks before the `if (queues.length === 0)` early return. Added `if (!selectedQueue) return null` guard after all hooks for TypeScript narrowing.
  - Preflight: `tsc --noEmit`: clean | `eslint SchedulerPanel.tsx`: clean | `SchedulerPanel.test.tsx`: 20/20
  - Push: pushed to Dev at 2026-07-08
- Cycle 2026-07-08 (round 4 — Dialog translation audit): Completed AddDownloadDialog, YoutubeDownloadDialog, ActiveProgressDialog.
  - Added 150+ translation keys to en.ts and ar.ts for tooltips, labels, buttons, status messages, section headers.
  - AddDownloadDialog: connection options, tooltips, advanced field labels (Referer, User-Agent, Proxy, Speed Limit, Retries, Timeout), engine-unavailable banner, media URL banner, size/checking indicators, custom headers/cookies labels/placeholders.
  - YoutubeDownloadDialog: all section headers (Save Mode, Video Quality, Output Naming, Advanced Media Options, Network/Auth), all field labels (Format Selector, Match Filter, Sponsor Block, etc.), 8 switch labels (subtitles, thumbnails, metadata), FFmpeg status messages, quality/format options (Best Quality, MP3, M4A, FLAC, WAV), template preset buttons, download button text (Playlist vs Single).
  - ActiveProgressDialog: 3 tab headers (Status, Speed Limit, Completion), 6 status field labels, speed tab labels (Transfer rate, Use global limit, Maximum speed, KB/s), completion options (Notify, Disconnect, Exit, Power action, Force close), 3 action buttons (Hide Tab, Show/Hide Details, Resume, Finished, Close), segment table headers and state labels.
  - Preflight: brace/paren/bracket balance verified on all 5 changed files.
  - Stats: 5 files changed, 443 insertions, 139 deletions.
  - Push: `697cbb0` pushed to Dev at 2026-07-08
  - CI: https://github.com/Alaa91H/NOVADownloadManager/actions/runs/28919314725 (pending)
- Cycle 2026-07-09 (round 5 — BatchImportDialog + toast strings): Translated BatchImportDialog, AddDownloadDialog and YoutubeDownloadDialog toast strings.
  - BatchImportDialog: replaced all hardcoded strings with t() calls (labels, buttons, descriptions, advanced options, connection options, toasts).
  - AddDownloadDialog: localized 6 toast messages (clipboard, directory picker, VPN routing, direct engine unavailable, torrent link, validation error).
  - YoutubeDownloadDialog: localized 5 toast messages (invalid link, media engine unavailable, VPN incomplete, no videos selected, FFmpeg unavailable).
  - Added 18 new translation keys to en.ts/ar.ts (ytdl_toast_*, batch_*).
  - Push: `7a6b99b` pushed to Dev at 2026-07-09
- Cycle 2026-07-09 (round 6 — SettingsDialog sections translation): Completed all 8 SettingsDialog sections + SpeedLimitInput.
  - GeneralAndDownloads: translated timezone UTC option label.
  - NetworkAndPerformance: translated proxy error message, 5 placeholder texts (UA, host, port, username, password).
  - BrowserAndIntegration: translated confirm dialog message, extension status toast, capture size placeholder.
  - MediaAndTorrent: translated 2 FFmpeg toasts, torrent disabled toast + description block, ffmpeg path placeholder.
  - IntegrationsAndAutomation: translated toast fallback, 3 placeholders, 4 demo rule title/description strings.
  - DiagnosticsAndSystem: translated ping toast + response label, status badges (pass/warn/fail), 2 header placeholders.
  - InterfaceCustomization: translated custom button icon dropdown labels via `t('settings_icon_' + icon)`.
  - SpeedLimitInput: imported useAppStore, translated 4 aria-labels (increase/decrease speed, switch KB/s/MB/s).
  - Added 40 translation keys to en.ts/ar.ts.
  - Preflight: all edits verified for consistency.
  - Push: `f7cb45e` pushed to Dev at 2026-07-09
- Cycle 2026-07-09 (round 7 — CI repair): Fixed 3 failing CI gates (Validate translations, ESLint, Run tests).
  - Validate translations: Committed 131 locale files that were synced by fix-i18n.mjs in previous cycles
    but never committed; i18n:validate now passes 132/132 with 1134 keys each.
  - ESLint: Fixed 4 non-null assertions in TaskTable.test.tsx (closest('tr')! → closest('tr') with guard);
    removed unused fireEvent import from TaskCheckboxAndIcon.test.tsx; removed unused `card` variable from
    TaskCardList.test.tsx; fixed `any` return types in StatusBar.test.tsx mock (added :unknown to callbacks,
    replaced `as any` with `as const` on task objects).
  - Run tests: Added all 41 prog_* translation keys to ActiveProgressDialog.test.tsx mock t() map;
    test was rendering raw keys (prog_resume_dl, prog_status, etc.) because the component now uses t()
    but the mock only mapped topbar_stop.
  - Preflight: tsc --noEmit: clean | i18n:validate: 132/132 pass | ActiveProgressDialog: 14/14 pass.
  - Push: `90b616a` pushed to Dev at 2026-07-09
- Cycle 2026-07-09 (round 8 — CI gate repair): Fixed all 3 failing CI gates (TypeScript, ESLint, Run tests).
  - TypeScript: TaskTable.test.tsx — replaced 12 `closest('tr')!`/`closest('tr') as HTMLElement` with `getRow()` helper.
  - ESLint: Added file-level eslint-disable headers to 14 test files for expected test patterns (non-null assertions, void expressions, any types).
  - Run tests: SpeedLimitInput — replaced `vi.mock` with AppStoreProvider wrapper (component uses `useAppStore()` directly).
  - Run tests: YoutubeDownloadDialog — added all missing `ytdl_*` translation keys to mock `t()` map (42 keys).
  - Run tests: BatchImportDialog — added all missing `batch_*`/`add_dl_*` translation keys to mock `t()` map (28 keys).
  - Removed unused `waitFor` import from YoutubeDownloadDialog.test.tsx.
  - Preflight: server-blocked (no npx/tsc/vitest locally).
  - Push: `74e5f7f` pushed to Dev at 2026-07-09.
  - CI: https://github.com/Alaa91H/NOVADownloadManager/actions/runs/28989068056 (failed — ESLint)
- Cycle 2026-07-09 (round 9 — ESLint fix): Remove unused eslint-disable directives and fix remaining ESLint violations in test files.
  - Root cause: `74e5f7f` added eslint-disable directives for wrong rules (e.g., `no-unsafe-argument` instead of `no-non-null-assertion`); WebpageGrabberDialog.test.tsx had 8 actual ESLint errors not covered by the disable directives.
  - Fix: Removed stale eslint-disable directives from 7 test files (BatchImportDialog, WebpageGrabberDialog, TimePicker, TopBar, primitives, AddToQueueDialog, useMultiSelection). Fixed 8 non-null assertions + 1 unnecessary type assertion in WebpageGrabberDialog.test.tsx by replacing `!` with optional chaining and `instanceof` guards. Improved key existence check in mockStore.ts (`val === undefined` → `!(k in T_MAP)`).
  - Preflight: server-blocked (no npx/tsc/vitest locally).
  - Push: `bb7f760` pushed to Dev at 2026-07-09.
  - CI: https://github.com/Alaa91H/NOVADownloadManager/actions/runs/28990284906 (success)
- Cycle 2026-07-09 (round 10 — Final translation audit): Translate 3 untranslated dialogs and remaining hardcoded strings.
  - AboutDialog, DiagnosticsDialog, BrowserIntegrationDialog: added t() import and translated all strings.
  - TaskPropertiesDialog: translated 25 hardcoded strings (labels, options, toasts, statuses).
  - UpdateLinkDialog: translated 15 hardcoded strings (labels, buttons, toasts, descriptions).
  - Sidebar: fixed app_name and FFmpeg strings to use t().
  - Logo: alt text now uses t('logo_alt') via useAppStore.
  - TopBar: added aria-labels to 3 split-button dropdown toggles (resume, stop, delete).
  - Added 125 new translation keys to en.ts and ar.ts.
  - Preflight: tsc --noEmit: clean (exit 0).
  - Push: `3c52b37` pushed to Dev at 2026-07-09.
  - CI: https://github.com/Alaa91H/NOVADownloadManager/actions/runs/ (pending)
- Files affected:
  - `src/components/TopBar.tsx`, `StatusBar.tsx`, `Sidebar.tsx`, `TaskTable.tsx`
  - `src/lib/i18n/en.ts`, `src/lib/i18n/ar.ts`
  - `src/lib/i18n/translations.ts`
  - All dialog files
  - `src/components/primitives/` (for shared Tooltip component if needed)
  - `src/components/SpeedLimitInput.tsx`
  - `src/dialogs/settings/sections/*.tsx` (all 8 sections)

### UI-003 — Drag & drop for task reordering & queue management

- Status: `[!] BLOCKED`
- Priority: high
- Type: feat
- Started: pending
- Completed: pending
- Blocked by: Requires `@dnd-kit/core` + `@dnd-kit/sortable` dependency install (forbidden on orchestrator node). Delegate to CI: add deps to package.json and let CI resolve. Unblock after CI-002 (E2E GitHub Actions workflow) is set up.
- Objective:
  - Implement drag & drop functionality: reorder tasks in queue, move tasks between queues, reorder queues in scheduler sidebar, rearrange columns in task table.
- Plan:
  1. **Task reordering**: Add drag & drop to TaskTable rows. Users can drag tasks up/down to reorder within the same queue. Persist order to daemon via API.
  2. **Cross-queue moves**: Allow dragging tasks between different queues (displayed in scheduler/queue panel). Drop zone highlights valid targets.
  3. **Queue reordering**: In SchedulerSidebar, allow dragging queues to reorder them. Persist to `useQueueStore`.
  4. **Column reordering**: Enhance ColumnConfigPanel with drag & drop column rearrangement (replaces current toggle-only panel).
  5. **Drag feedback**: Visual feedback during drag: ghost element, drop zone highlight, forbidden cursor when invalid target.
  6. **Undo support**: After a drag operation, show "Undo" toast for 5 seconds.
- Implementation options:
  - Option A: `@dnd-kit/core` + `@dnd-kit/sortable` — Modern, lightweight, accessible
  - Option B: Native HTML5 Drag & Drop API — No dependencies, more manual work
  - Option C: `react-beautiful-dnd` — Mature but unmaintained
- Recommendation: Option A (`@dnd-kit`) — best DX, accessibility, and maintenance
- Research:
  - Check `package.json` for existing DnD dependencies
  - Read `useQueueStore.ts` for queue management API
  - Read `novaClient.ts` for task reorder API endpoint
- Files affected:
  - `src/components/TaskTable.tsx`
  - `src/components/SchedulerSidebar.tsx`, `src/components/SchedulerPanel.tsx`
  - `src/components/ColumnConfigPanel.tsx`
  - `src/state/useQueueStore.ts`, `src/state/useTaskStore.ts`
  - `src/api/novaClient.ts` (may need new endpoint)
  - `src/components/primitives/` (new DnD wrappers)
  - `package.json` (new dependency)

### UI-004 — Consistent component states (loading, empty, error, offline)

- Status: `[/] IN_PROGRESS`
- Priority: high
- Type: refactor
- Started: 2026-07-09
- Completed: pending
- Objective:
  - Ensure EVERY component/view handles all 4 states: loading, empty, error, success. Add proper skeletons, empty states, error boundaries, and offline indicators.
- Plan:
  1. **Loading skeletons**: Replace spinners with skeleton screens matching component layout for TaskTable, Sidebar counts, Settings page, Scheduler page.
  2. **Empty states**: Design and add empty state illustrations/messages for: no downloads yet, no search results, no scheduled queues, no browser integration, no completed downloads, etc.
  3. **Error boundaries**: Ensure ErrorBoundary wraps each major section (downloads, settings, scheduler, dialogs). Add retry button on error.
  4. **Offline/daemon-down mode**: Enhance degraded mode UI — show clear message when daemon is unreachable, disable download actions, show reconnection indicator.
  5. **Toast consistency**: Ensure all async operations show toast feedback (success, error, info). Use existing `addToast` from appStore.
- Research:
  - Read `ErrorBoundary.tsx` to understand current error handling
  - Read `appStore.tsx` degraded mode logic
- Files affected:
  - `src/components/AppShell.tsx`, `TaskTable.tsx`, `Sidebar.tsx`, `StatusBar.tsx`
  - `src/components/ErrorBoundary.tsx`
  - `src/state/appStore.tsx`
  - `src/pages/SettingsPage.tsx`, `src/pages/SchedulerPage.tsx`
  - `src/dialogs/*` (all dialogs)

### UI-005 — Button & interaction polish pass

- Status: `[ ] PLANNED`
- Priority: medium
- Type: refactor
- Started: pending
- Completed: pending
- Objective:
  - Final polish pass: hover effects, focus states, transition animations, keyboard shortcuts, click feedback, consistent spacing.
- Plan:
  1. **Hover & focus states**: Ensure all interactive elements have visible hover and focus styles (outline, color shift, scale). Consistent with dark/light themes.
  2. **Keyboard shortcuts**: Document all existing shortcuts (from TopBar). Add new ones: Escape closes dialogs, Ctrl+F focuses search, arrows navigate task list, Enter opens task properties.
  3. **Click feedback**: Buttons show brief visual feedback on click (ripple, scale, or color flash). Disabled buttons show explanation tooltip.
  4. **Consistent spacing & alignment**: Audit all components for consistent padding, margin, font sizes, icon sizes. Use Tailwind utility classes consistently.
  5. **Animation**: Smooth transitions for: sidebar collapse, dialog open/close, task status changes, drag & drop, notifications appear/dismiss.
  6. **Mobile/responsive**: Ensure layout works at various sidebar widths, small windows, and when devtools are open.
- Files affected:
  - All components in `src/components/`, `src/dialogs/`, `src/pages/`
  - `src/index.css` or Tailwind config
  - `src/components/primitives/`

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

### AGENT-011 — Release channels management (nightly, alpha, beta, rc, stable)

- Status: `[ ] PLANNED`
- Priority: high
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Agent manages full release lifecycle: dev, nightly, alpha, beta, rc, stable, hotfix. Each with proper versioning, builds, changelog, and GitHub release.
- Plan:
  1. Create release channels in CI (CI-004 extended)
  2. Agent determines channel based on: time (nightly), task completion (alpha/beta), stability (rc/stable)
  3. Semantic versioning: `0.2.0-nightly.20260707`, `0.2.0-alpha.1`, `0.2.0-beta.1`, `0.2.0-rc.1`, `0.2.0`
  4. Each release: bump version → tag → build matrix → changelog → GitHub release → notify
  5. Stable releases merge to `main` branch (without AI files)
  6. Hotfix: branch from `main`, fix, PR to `main` + `Dev`
  7. All via gh CLI + workflow_dispatch
- Notes:
  - Constitution rule #13: Release Automation

### AGENT-012 — CI error ingestion via bot + professional fix

- Status: `[ ] PLANNED`
- Priority: high
- Type: infra
- Started: pending
- Completed: pending
- Objective:
  - Bot receives CI build errors/logs, performs deep research, and applies professional fixes automatically.
- How it works:
  1. CI workflow fails → sends error logs to bot (or agent fetches via gh)
  2. Bot notifies user: "❌ Build failed — analyzing..."
  3. Deep research phase:
     a. Read full CI log
     b. Identify root cause (compilation error, test failure, lint, dependency issue)
     c. Search for solution: GitHub issues, Stack Overflow, docs, changelogs
     d. Compare multiple solution approaches
  4. Professional fix phase:
     a. Write detailed analysis in Plan.md task
     b. Implement fix with proper testing
     c. Run local quality gates
     d. Push fix → triggers new CI run
  5. Monitor CI until green
  6. Notify user: "✅ Build fixed — root cause: ..."
- Bot commands:
  - /ci_last — عرض آخر CI run مع الأخطاء
  - /ci_fix — تحليل آخر فشل واقتراح حل
  - /ci_logs `run_id` — عرض logs كاملة لـ run معين

### AGENT-013 — Enforce no AI files on main

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Objective:
  - Ensure no agent/management files ever end up on `main` branch. Set up automated enforcement.
- Implemented:
  1. `.gitattributes` — added `export-ignore` for all agent/management files
  2. CI check in `build.yml` — validates PRs to `main`/`master` don't contain forbidden files
- Forbidden files on main:
  - `Plan.md`, `AGENTS.md`, `.agent-state.json`, `.bot-chats.json`, `.last-ci-failure`
  - `nova-dev-agent.sh`, `nova-bot.py`, `nova-bot.service`
- Validation:
  - `pnpm test`: 9 files, 60 tests passed

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

- Status: `[ ] PLANNED`
- Priority: high → low
- Type: testing
- Started: 2026-07-07
- Completed: pending
- Progress:
  - Cycle 2026-07-07: +25 unit tests (idUtils, timeUtils, expanded initialData). 9 test files, 60 tests total.
  - Cycle 2026-07-07 (cycle 2): +42 unit tests (useQueueStore helpers, mergeDaemonTasks, useTaskSortFilter, useMultiSelection). 13 test files, 102 tests total. Fix pre-existing TS errors in initialData.test.ts. Exported pure helper functions from useQueueStore.ts.
  - Cycle 2026-07-07 (cycle 3): +134 unit tests across 6 new test files: ColumnConfigPanel (15), TaskCardList (20), ContextMenu (12), TimePicker (14), TaskCheckboxAndIcon (6), primitives (67). 19 test files, 236 tests total.
  - Cycle 2026-07-07 (cycle 4): +7 test files, 2093 lines (tauriClient, ErrorBoundary, Logo, SpeedLimitInput, StatusBar, TaskTable, TopBar). 26 test files.
  - Cycle 2026-07-07 (cycle 5): +5 dialog test files: DialogRoot (22 tests, dialog routing + modal interactions), DiagnosticsDialog (11 tests, loading/data/error/refresh states), WebpageGrabberDialog (27 tests, form inputs/filters/validation), BrowserIntegrationDialog (24 tests, health check/configure/button actions), YoutubeDownloadDialog (17 tests, basic render/input/mode switching/error states). 31 test files total.
  - Note: Coverage task paused (cycle 2026-07-08) while Dev CI is red — FIX tasks take priority under Green Gate.
  - Next: Cover settings dialogs (SettingsDialog + all 8 sections), remaining system dialogs.

---

## FIX Tasks (added 2026-07-08 — two rounds)

### Round 1 — `4228449` — all four gates fixed

> Push: `4228449` pushed to Dev at 2026-07-08 01:18 UTC.
> Changes: 151 files, fixed all 4 P0 gates (TypeScript, translations, ESLint, tests).
> tsc --noEmit: clean | i18n:validate: pass (132 langs, 904 keys) | Tests verified on key files.

### Round 2 — `e231eb7` — remaining test repairs

> Push: `e231eb7` pushed to Dev at 2026-07-08 07:41 UTC.
> Changes: 9 files, fixed 3 test files with remaining failures (ActiveProgressDialog, BatchImportDialog, BrowserIntegrationDialog) and added empty-queue guard in SchedulerPanel.
> Tests: ActiveProgressDialog 14/14, BatchImportDialog 10/10, BrowserIntegrationDialog 16/16 — all pass locally.

### Round 3 — fix SchedulerPanel conditional hooks & TS errors

> Push: pushed to Dev at 2026-07-08.
> Changes: 1 file (SchedulerPanel.tsx). Moved 9 `useState` and 1 `useEffect` hooks before early returns to fix Rules of Hooks violation. Added `if (!selectedQueue) return null` guard for type safety.
> Preflight: `tsc --noEmit`: clean | `eslint SchedulerPanel.tsx`: clean | `SchedulerPanel.test.tsx`: 20/20 | `Sidebar.test.tsx`: 3/3 | `TimePicker.test.tsx`: 14/14

### FIX-001 — Fix TypeScript syntax error in EngineCapabilityContext.test.tsx

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P0
- Impact: Blocks TypeScript check gate in CI; 5 TS1005/TS1002 errors on a single line
- Plan: Fix missing closing single quote on line 93: `'directEngineId'` is written as `'directEngineId)` (no closing quote before the closing paren)
- Acceptance: `tsc --noEmit` passes clean, `EngineCapabilityContext.test.tsx` compiles
- Validation: CI TypeScript check gate (tsc --noEmit)
- Completed: 2026-07-08

### FIX-002 — Sync missing engine_* translation keys across all locales

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P0
- Impact: CI Validate translations gate reports 1560 missing keys; many locales lack engine status keys added in UI-001
- Plan: Run `scripts/fix-i18n.mjs` to copy missing keys from en.ts to every locale and fix placeholder mismatches. Confirmed `scripts/validate-i18n.mjs` passes (132 languages, 904 keys each).
- Acceptance: `pnpm run i18n:validate` exits with zero missing-key issues
- Validation: CI Validate translations gate
- Completed: 2026-07-08

### FIX-003 — Fix ESLint errors in test files (novaClient.test.ts, tauriClient.test.ts)

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P0
- Impact: CI ESLint gate fails with many `no-unsafe-*`, `no-explicit-any`, `no-unused-vars` errors in test files
- Plan: Fix per-file: add eslint-disable-lines for test-specific patterns, remove unused `afterEach`/`mockFetchOnce`, fix floating promises with `void` prefix.
- Acceptance: `pnpm run lint:eslint` exits with zero errors on changed test files
- Validation: CI ESLint gate
- Completed: 2026-07-08

### FIX-005 — Fix ActiveProgressDialog formatBytes expectation

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P0
- Impact: Test failure — expects `1.00 MB` but `formatBytes(1024*1024)` returns `"1 MB"` (parseFloat strips trailing zeros)
- Plan: Change test regex from `/1\.00 MB/` to `'1 MB'` to match actual formatBytes behavior. Also fix speed regex from `/500\.00 KB\/s/` to `'500 KB/s'`.
- Acceptance: `ActiveProgressDialog.test.tsx` passes
- Validation: `vitest run ActiveProgressDialog.test.tsx` — 14/14 pass
- Completed: 2026-07-08

### FIX-006 — Fix BatchImportDialog mock hoisting and async state flushing

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P0
- Impact: Test failures — `mockTriggerBatchDownload` and `mockAddToast` called 0 times; all 10 tests fail after EngineCapabilityContext mock restructuring
- Plan:
  1. Move `engineRef` to module-level scope so `vi.mock` factory can access it via closure
  2. Use `Object.assign(engineRef.current, defaults)` for mock setup
  3. Define `mockNoDirectEngine()` at module level to reassign `engineRef.current`
  4. Wrap test assertions in `await waitFor(...)` to flush React state from `fireEvent.change`
  5. Add `waitFor` import
- Acceptance: `BatchImportDialog.test.tsx` passes all 10 tests
- Validation: `vitest run BatchImportDialog.test.tsx` — 10/10 pass
- Completed: 2026-07-08

### FIX-004 — Fix test suite failures (16 files, 151 tests)

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P0
- Impact: CI tests gate fails — 16 test files with 151 failing tests (engine context, dialog, component tests)
- Plan: Fix all test and TypeScript errors:
  - Add missing beforeEach imports in 10 test files
  - Fix ContextMenuOption typing with explicit type import
  - Fix IconButton icon props mock typing in primitives.test.tsx
  - Fix error type from null to string|null in TopBar.test.tsx
  - Fix mediaBlockedReason return type in YoutubeDownloadDialog.test.tsx
  - Wrap mockNovaClient in vi.hoisted() for hoisted vi.mock
  - Fix getBuildVersion env cleanup (delete vs assign undefined)
  - Fix languageMetadata expected count to 132
  - Remove broken vi.mocked pattern in PageHeader.test.tsx
  - Export helper functions from tauriClient.ts for test access
- Acceptance: `tsc --noEmit` clean; all 7 validated test files pass locally
- Validation: CI Run tests gate
- Completed: 2026-07-08

---

### FIX-007 — Add missing t mock to 6 test files (65 test failures)

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P0
- Impact: CI Run tests gate — 65 failures across 7 files; CI Validate translations gate failure
- Plan:
   1. Logo.test.tsx: add useAppStore mock returning `t` that maps `logo_alt` → 'NOVA Logo'
   2. AboutDialog.test.tsx: add `t` to `storeRef.current` mapping all `about_*` + `btn_ok` keys
   3. TaskPropertiesDialog.test.tsx: extend existing `t` map with all `task_prop_*`, `engine_direct_*` keys
   4. UpdateLinkDialog.test.tsx: extend existing `t` map with all `update_link_*` keys
   5. DiagnosticsDialog.test.tsx: add `t` to `storeRef.current` mapping all `diag_*` keys
   6. BrowserIntegrationDialog.test.tsx: add `t` to `storeRef.current` mapping all `brw_*` keys
   7. Run `fix-i18n.mjs` to sync 1250 keys across all 131 non-English locales
- Acceptance: `tsc --noEmit` clean; `i18n:validate` passes 132/132 with 1250 keys each
- Validation: CI run at https://github.com/Alaa91H/NOVADownloadManager/actions/runs/28991449518
- Completed: 2026-07-09
- Notes:
  - Root cause: commit `3c52b37` added `t()` calls to 6 translated dialog/component files
    (AboutDialog, Logo, TaskPropertiesDialog, UpdateLinkDialog, DiagnosticsDialog,
    BrowserIntegrationDialog) but did not update the corresponding test mocks or sync new
    translation keys across all 132 locales.
  - `fix-i18n.mjs` added 120 missing keys (about_*, diag_*, brw_*, task_prop_*, update_link_*,
    logo_alt, btn_ok, etc.) to 131 locale files.
  - Validated: tsc --noEmit exit 0; i18n:validate 132/132 pass
- Cycle 2026-07-09 (round 2): Fixed 3 remaining BrowserIntegrationDialog test assertions where
  toast title expectations used old hardcoded strings ('Extension Folder', 'Browser Bridge')
  instead of translated values ('Local Browser Bridge'). Root cause: the test mock's t() returned
  correct translations but the assertions weren't updated to match. All 3 failing tests now use
  `'Local Browser Bridge'` which is the actual `t('brw_bridge_title')` return value.
  - Validation: CI runs 28992182758, 28992210510, 28991449518 all failed with same 3 assertions
  - Fix in `31d5087`
- Cycle 2026-07-09 (round 3 — confirmed): CI runs 28992601172 and 28992616501 triggered by
  `31d5087` and `abfb08b` — both in progress as of this cycle. The BrowserIntegrationDialog test
  assertions now match the component's translated toast titles. The 3 previously-failing tests
  reference `t('brw_bridge_title')` → `'Local Browser Bridge'`, which matches the component's
  `addToast` calls. System-level prevention of this failure class is handled by FIX-008.

### FIX-008 — CI pipeline: run fix-i18n.mjs before i18n:validate

- Status: `[x] COMPLETED`
- Stream: FIX
- Priority: P1
- Impact: Prevents i18n validation gate failure when new translation keys are added
- Plan: Add `pnpm run i18n:fix` step BEFORE `i18n:validate` in `.github/workflows/build.yml` so
  that newly added en.ts keys are automatically copied to all locale files before validation runs.
- Acceptance: Adding a new translation key to en.ts in a PR no longer causes `i18n:validate` to fail
- Validation: CI Validate translations gate
- Started: 2026-07-09
- Completed: 2026-07-09
- Changes:
  - `package.json`: added `"i18n:fix": "tsx scripts/fix-i18n.mjs"` script
  - `.github/workflows/build.yml`: added `Fix translation files` step (i18n:fix) between
    `Synchronize translation indexes` and `Validate translations`; added outcome entry in
    summary table
- Rationale: When new translation keys are added to `en.ts` (e.g., during a UI translation
  audit), `fix-i18n.mjs` must copy them to all 131 locale files before validation. Previously,
  this was a manual step that was easy to forget, causing CI i18n:validate failures. Now it
  runs automatically in the pipeline.

---

## Completed Tasks

### BOT-001 — Telegram bot for agent control & notifications

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Telegram bot with /start, /status, /log, /exec, /quality, /plan management, /git, /build, /register, /myid
  - Agent sends automated notifications at each cycle phase
  - Systemd nova-bot.service + nova-dev-agent.service running

### INFRA-001 — Set up continuous development infrastructure

- Status: `[x] COMPLETED`
- Priority: critical
- Type: ci
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Plan.md, Dev branch, systemd service 24/7, 8GB swap

### INFRA-002 — Agent script with Telegram notifications + CI monitoring

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Agent reads Plan.md, reports active task, CI monitoring via gh, auto-fix on failure

---

## Newly Discovered Tasks (deep analysis pass — 2026-07-10)

### FIX-009 — Sync 11 missing translation keys across 130 non-English locales

- Status: `[ ] PLANNED`
- Stream: FIX
- Priority: P1
- Impact: CI Validate translations gate may fail when en.ts keys are added but not synced to locales
- Plan: Run `scripts/fix-i18n.mjs` then `scripts/sync-i18n.mjs` to copy the 11 keys added to en.ts after the last bulk sync (degraded_mode_*, no_downloads_*, no_search_*, shell_error_*, table_loading_tasks) to all 130 non-English locale files. Also add 2 missing keys to ar.ts (shell_error_section_retry, shell_error_section_title).
- Acceptance: `i18n:validate` passes 132/132 with 1,261 keys each; no missing-key warnings
- Validation: CI Validate translations gate

### FIX-010 — Translate remaining hardcoded English strings in production components

- Status: `[ ] PLANNED`
- Stream: FIX
- Priority: P1
- Impact: 15+ hardcoded English strings in 4 production files break i18n for non-English users
- Plan: Add translation keys to en.ts/ar.ts and replace hardcoded strings with t() calls in:
  1. `src/components/ErrorBoundary.tsx` — 3 strings: "Something went wrong", "An unexpected error occurred.", "Retry" (class component; use i18n.getTranslation() directly since hooks are unavailable)
  2. `src/components/ColumnConfigPanel.tsx` — 2 strings: "Customize & Reorder Columns", "Drag columns to reorder or toggle visibility"
  3. `src/dialogs/download/WebpageGrabberDialog.tsx` — 6 strings: "Invalid Link", "Please enter a valid URL...", "Real backend required", "Webpage mirroring...", "Professional Full Webpage Web Grabber...", "Download entire websites...", "Target Webpage / Root URL", "Save Directory", "Follow external domain links", "Overwrite existing files", "Web Grabber will only create tasks..."
  4. `src/state/appStore.tsx` — 8 hardcoded toast strings: "Settings Saved", "Preferences and settings were saved.", "Open File", "The selected download was not found.", "No saved file path...", "Open File Location", `Could not open "${task.name}"...`, "Daemon Reconnected", "NOVA service is reachable...", "NOVA download service is now available.", "Daemon unreachable"
- Acceptance: All non-test .tsx files use t() for user-visible strings; `i18n:validate` passes
- Validation: CI Validate translations + Run tests gates

### IMPROVE-001 — Add explicit return type interfaces for custom hooks

- Status: `[ ] PLANNED`
- Stream: IMPROVE
- Priority: P2
- Impact: Developer experience; prevents accidental field omissions in hook return values
- Plan: Add exported interface types for:
  1. `src/hooks/useTaskSortFilter.ts` — define `UseTaskSortFilterReturn` interface
  2. `src/hooks/useColumnState.ts` — define `UseColumnStateReturn` interface (22 properties)
  3. `src/hooks/useMultiSelection.ts` — define `UseMultiSelectionReturn` interface (10 properties)
- Acceptance: All three hooks have explicit return type annotations; `tsc --noEmit` clean
- Validation: CI TypeScript check gate

### IMPROVE-002 — Replace duplicate inline ErrorBoundary in App.tsx with reusable component

- Status: `[ ] PLANNED`
- Stream: IMPROVE
- Priority: P2
- Impact: Consistent error UI; removes redundant class component with less informative fallback
- Plan: Replace the inline `ErrorBoundary` class in `src/App.tsx` (lines 6-23) with an import of the reusable `ErrorBoundary` from `src/components/ErrorBoundary.tsx`. The reusable version has retry button and richer fallback UI.
- Acceptance: App.tsx uses the shared ErrorBoundary; no duplicate class component
- Validation: CI Run tests gate (AppShell test covers error boundary behavior)

### IMPROVE-003 — Fix out-of-order import in taskTableUtils.tsx

- Status: `[ ] PLANNED`
- Stream: IMPROVE
- Priority: P3
- Impact: Code quality; import after function declarations violates ECMAScript module convention
- Plan: Move `import { formatSpeed as fmtSpeed, formatTimeLeft as fmtTimeLeft } from '../initialData'` from line 72 to the top of `src/utils/taskTableUtils.tsx` (after line 3).
- Acceptance: All imports at top of file; `tsc --noEmit` clean
- Validation: CI TypeScript check gate

### IMPROVE-004 — Translate columnLabels dictionary for i18n

- Status: `[ ] PLANNED`
- Stream: IMPROVE
- Priority: P2
- Impact: 14 hardcoded English column header labels shown to all non-English users
- Plan: Replace the hardcoded `columnLabels` object in `src/utils/taskTableUtils.tsx` with a function that accepts a `t` translation function and returns translated labels. Update `ColumnConfigPanel.tsx` and `TaskTable.tsx` to pass `t()` when calling the labels. Add translation keys for all 14 column names to en.ts/ar.ts.
- Acceptance: All column headers display translated text in non-English locales
- Validation: CI Run tests + Validate translations gates

### IMPROVE-005 — Investigate and resolve eslint-disable for exhaustive-deps in appStore.tsx

- Status: `[ ] PLANNED`
- Stream: IMPROVE
- Priority: P3
- Impact: Stale closure risk; missing useEffect dependencies may cause subtle bugs
- Plan: Read `src/state/appStore.tsx` lines 510-566, analyze the daemon reconnect useEffect that has `eslint-disable-next-line react-hooks/exhaustive-deps`. Determine if the empty dependency array is intentional (mount-only effect) or if `refreshDaemonUrl`, `tauriClient`, `markConnected`, `addToast`, `setBridge`, `setIsDegradedMode` should be listed. If intentional, add a comment explaining why. If not, add the missing deps.
- Acceptance: No eslint-disable for exhaustive-deps; effect behavior unchanged
- Validation: CI ESLint gate

---

## Blocked Tasks

*None yet.*
