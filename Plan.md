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
  - xvfb: pending
  - playwright: pending
  - rust-targets: pending
  - gh-cli: pending
  - e2e: pending
  - release: pending
- Objective:
  - Make the agent fully autonomous: write code, run all tests (including E2E with browser), build for all platforms, create releases, and self-maintain — all without human intervention.
- Architecture:
  1. **Infrastructure**: xvfb (headless browser) + Rust cross-compilation targets + gh CLI
  2. **Testing**: Playwright E2E via xvfb, coverage 10%+
  3. **CI/CD**: GitHub Actions workflows triggered by agent, cross-platform build matrix
  4. **Agent Enhancement**: Trigger workflows via gh, auto-release, self-healing
  5. **Self-Maintenance**: Auto-update deps, disk cleanup, log rotation, health monitoring
- Notes:
  - Server: Ubuntu 24.04 (1GB RAM + 8GB swap)
  - Model: opencode/big-pickle (free via Zen)
  - All builds pushed to GitHub; releases use GitHub Releases API

---

## Planned Tasks

### INFRA-003 — Install headless browser (xvfb) + Playwright

- Status: `[ ] PLANNED`
- Priority: critical
- Type: infra
- Source branch: `Dev`
- Work branch: `ai/infra-xvfb`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - xvfb-run: pending
  - playwright chromium: pending
  - pnpm exec playwright test: pending
- Objective:
  - Install xvfb (X Virtual Framebuffer) and Playwright with Chromium browser so the agent can run E2E tests headlessly.
- Plan:
  1. Install xvfb via apt
  2. Install Playwright system deps
  3. npx playwright install chromium
  4. Verify tests pass with xvfb-run
  5. Update agent script to run E2E through xvfb

### INFRA-004 — Install Rust cross-compilation targets

- Status: `[ ] PLANNED`
- Priority: high
- Type: infra
- Source branch: `Dev`
- Work branch: `ai/infra-rust-targets`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - rustup target list --installed: pending
  - cross build test: pending
- Objective:
  - Install all necessary Rust targets and system libraries for cross-compiling Tauri apps to Windows (x64, x86, ARM64), Linux ARM64, and (where possible) macOS.
- Plan:
  1. rustup target add x86_64-pc-windows-msvc
  2. rustup target add i686-pc-windows-msvc
  3. rustup target add aarch64-pc-windows-msvc
  4. rustup target add aarch64-unknown-linux-gnu
  5. Install mingw-w64 for Windows cross-compilation
  6. Install gcc-aarch64-linux-gnu for ARM64
  7. Test a cross-compile build
  8. Note: macOS targets need macOS SDK (license-restricted); use GitHub Actions for macOS

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
  - Install GitHub CLI so the agent can trigger workflows, create releases, and manage the repo programmatically.
- Plan:
  1. Install gh via apt
  2. Authenticate with GitHub PAT (already stored)
  3. Test: gh workflow list, gh release list
  4. Update agent script to use gh for release management

### TEST-002 — E2E tests with Playwright + xvfb

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
  - playwright install: pending
  - e2e tests pass: pending
  - coverage 10%+: pending
- Objective:
  - Write comprehensive E2E tests using Playwright with Chromium, run headlessly via xvfb. Target 10%+ coverage.
- Plan:
  1. Configure Playwright (chromium only, headless, CI reporter)
  2. Write tests: downloads, settings, scheduler, sidebar, i18n, tasks, queue, API, UI components, navigation
  3. Run E2E via xvfb-run
  4. Add to quality gates and agent pre-commit checks
  5. Validate coverage meets 10% threshold
- Notes:
  - Requires INFRA-003 (xvfb + playwright install)

### CI-001 — GitHub Actions CI/CD matrix

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/ci-matrix`
- Target branch: `Dev`
- Started: pending
- Completed: pending
- PR: pending
- Validation:
  - CI triggers: pending
  - builds pass: pending
  - tests pass: pending
- Objective:
  - Create full CI/CD pipeline with GitHub Actions: quality gates, multi-platform build matrix, E2E tests, and release automation.
- Plan:
  1. Create .github/workflows/quality.yml (lint, test, build, audit)
  2. Create .github/workflows/e2e.yml (Playwright with xvfb)
  3. Create .github/workflows/build.yml (Windows/Linux/macOS x64+ARM)
  4. Create .github/workflows/release.yml (tag → draft release → upload assets)
  5. All workflows triggerable via workflow_dispatch (agent-controlled)

### AGENT-003 — Agent release automation

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
  - gh release create: pending
  - auto-version: pending
- Objective:
  - Program the agent to create GitHub releases automatically: determine next version, tag, build, upload, publish.
- Plan:
  1. Add release logic to nova-dev-agent.sh
  2. Determine version from Plan.md or git tags
  3. Build via pnpm build, pnpm bundle
  4. Create GitHub release via gh CLI
  5. Upload artifacts
  6. Notify via Telegram

### AGENT-004 — Agent self-maintenance & healing

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
  - health check: pending
  - log rotation: pending
- Objective:
  - Add self-healing, resource monitoring, log rotation, and dependency auto-update to the agent. Make it truly "set and forget."
- Plan:
  1. Add health check endpoint (systemd service health, disk space, memory)
  2. Auto-cleanup: prune old builds, node_modules, docker cache
  3. Log rotation: archive logs older than 7 days
  4. Dependency auto-update: pnpm update --latest with validation
  5. Auto-restart if stuck (no output for 30 min)
  6. Telegram notifications for all maintenance actions

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
