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

## Active Task

### AGENT-001 — Full autonomous development pipeline

- Status: `[/] IN_PROGRESS`
- Priority: critical
- Type: infra
- Source branch: `Dev`
- Work branch: `ai/full-autonomy`
- Target branch: `Dev`
- Started: 2026-07-07
- Completed: pending
- Validation:
  - gh-cli: pending
  - workflows: pending
  - release-automation: pending
- Objective:
  - Make the agent fully autonomous: write code, push to Dev, trigger GitHub Actions workflows for build/test/release, and self-maintain. Server does development only; GitHub Actions does heavy lifting.
- Architecture:
  - **Server (1GB RAM)**: opencode agent writes code, runs unit tests, pushes to Dev
  - **GitHub Actions**: builds, E2E tests (Playwright), cross-platform compilation, releases
  - **Bridge**: gh CLI + workflow_dispatch events trigger CI/CD from agent
- Notes:
  - Server: Ubuntu 24.04 (1GB RAM + 8GB swap)
  - Model: opencode/big-pickle (free via Zen)

---

## Planned Tasks

### CI-001 — GitHub Actions quality gates workflow

- Status: `[ ] PLANNED`
- Priority: critical
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/quality-workflow`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - workflow runs: pending
  - all gates pass: pending
- Objective:
  - Create GitHub Actions workflow that runs all quality gates on every push to Dev: install, lint, typecheck, test, build, audit.
- Plan:
  1. Create .github/workflows/quality.yml
  2. Triggers: push to Dev, workflow_dispatch
  3. Steps: checkout → install → lint → typecheck → test → build → audit
  4. Add badge to README
  5. Test it works end-to-end

### CI-002 — GitHub Actions E2E workflow (Playwright + xvfb)

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/e2e-workflow`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - E2E passes: pending
  - coverage 10%+: pending
- Objective:
  - Create GitHub Actions workflow that runs Playwright E2E tests headlessly (xvfb) and reports coverage.
- Plan:
  1. Create .github/workflows/e2e.yml
  2. Install Playwright with Chromium and system deps
  3. Run tests via xvfb-run
  4. Upload coverage report as artifact
  5. Fail if coverage below 10%
  6. Test it works

### CI-003 — GitHub Actions cross-platform build matrix

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/build-workflow`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - builds pass all targets: pending
  - artifacts uploaded: pending
- Objective:
  - Create GitHub Actions workflow that builds Tauri apps for all platforms: Windows (x64, x86, ARM64), Linux (x64, ARM64), macOS (x64, ARM64).
- Plan:
  1. Create .github/workflows/build.yml
  2. Matrix strategy with os + arch + target triple
  3. Use tauri-actions for cross-compilation
  4. Upload build artifacts
  5. Test with dev channel

### CI-004 — GitHub Actions release automation

- Status: `[ ] PLANNED`
- Priority: medium
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/release-workflow`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - release created: pending
  - assets uploaded: pending
- Objective:
  - Create workflow that creates GitHub releases with versioning, changelog, and multi-platform binaries.
- Plan:
  1. Create .github/workflows/release.yml
  2. Trigger: tag push or workflow_dispatch with version
  3. Run full build matrix
  4. Generate changelog
  5. Create GitHub release with assets
  6. Publish to channels (dev/nightly/beta/stable)

### INFRA-005 — Install GitHub CLI (gh) and authenticate

- Status: `[ ] PLANNED`
- Priority: high
- Type: infra
- Source branch: `Dev`
- Work branch: `ai/infra-gh-cli`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - gh --version: pending
  - gh auth status: pending
- Objective:
  - Install GitHub CLI so the agent can trigger workflows and monitor results.
- Plan:
  1. Install gh via apt
  2. Authenticate with existing GitHub PAT
  3. Test: gh workflow list, gh run list

### TEST-001 — Write E2E test suites (10 files)

- Status: `[ ] PLANNED`
- Priority: high
- Type: testing
- Source branch: `Dev`
- Work branch: `ai/e2e-tests`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - 10 test files: pending
  - local tests pass: pending
- Objective:
  - Write 10 E2E test files under src/e2e/ to be run by GitHub Actions. Tests target: downloads, settings, scheduler, sidebar, i18n, tasks, queue, API, UI components, navigation.
- Plan:
  1. Write each test file with proper describe/it blocks
  2. Cover loading/empty/error/success states
  3. Mock external dependencies where needed
  4. Ensure tests pass locally with vitest
  5. Push to Dev (workflow runs them in CI)

### AGENT-003 — Agent release automation (trigger via gh)

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Source branch: `Dev`
- Work branch: `ai/agent-release`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - gh workflow trigger: pending
  - release created: pending
- Objective:
  - Program the agent to trigger releases automatically via gh CLI: determine version, dispatch workflow, monitor result.
- Plan:
  1. Add release trigger to nova-dev-agent.sh
  2. Read version from package.json
  3. Dispatch release workflow via gh
  4. Wait for workflow to complete
  5. Notify via Telegram

### AGENT-004 — Agent self-maintenance

- Status: `[ ] PLANNED`
- Priority: medium
- Type: infra
- Source branch: `Dev`
- Work branch: `ai/agent-healing`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - auto-cleanup: pending
  - log rotation: pending
- Objective:
  - Add self-maintenance to the agent: log rotation, disk cleanup, health monitoring, auto-restart if stuck.
- Plan:
  1. Log rotation: archive logs older than 7 days
  2. Disk cleanup: prune old node_modules, temp files
  3. Health check: monitor disk space, memory, agent responsiveness
  4. Auto-restart if stuck (no output for 30 min)
  5. Telegram notifications for maintenance actions

### AGENT-005 — Full quality hardening

- Status: `[ ] PLANNED`
- Priority: medium
- Type: refactor
- Source branch: `Dev`
- Work branch: `ai/quality-hardening`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - lint clean: pending
  - all types strict: pending
  - no any: pending
- Objective:
  - Refactor the entire codebase for maximum quality: strict types, comprehensive error handling, performance optimization.
- Plan:
  1. Fix all TypeScript errors (strict mode)
  2. Replace any with unknown
  3. Add error boundaries to all components
  4. Add loading/empty/error states
  5. Optimize Zustand selectors
  6. Remove dead code
  7. Add proper return types

---

## Completed Tasks

### BOT-001 — Telegram bot for agent control & notifications

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Full Telegram bot with /start, /status, /log, /exec, /quality, /plan management, /git, /opencode, /build
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
  - Plan.md created, Dev branch created, opencode 1.17.14 installed on server
  - systemd service running 24/7, Zen Big Pickle configured, 8GB swap created

### INFRA-002 — Agent script with Telegram notifications

- Status: `[x] COMPLETED`
- Priority: high
- Type: infra
- Started: 2026-07-07
- Completed: 2026-07-07
- Notes:
  - Agent reads Plan.md and reports active task
  - Sends Telegram notifications at cycle start, during opencode, on completion, on rate-limit
  - Tracks and reports duration of each cycle

---

## Blocked Tasks

*None yet.*
