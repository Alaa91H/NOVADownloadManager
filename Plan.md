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

### INFRA-001 — Set up continuous development infrastructure

- Status: `[x] COMPLETED`
- Priority: critical
- Type: ci
- Source branch: `main`
- Work branch: `ai/infra-setup`
- Target branch: `Dev`
- Started: 2026-07-07
- Completed: 2026-07-07
- PR: pending
- Validation:
  - install: not-applicable
  - lint: not-applicable
  - typecheck: not-applicable
  - test: not-applicable
  - build: not-applicable
  - audit: not-applicable
- Objective:
  - Create Plan.md, Dev branch, install opencode on server, and set up continuous development service.
- Plan:
  1. Create Plan.md with full task structure
  2. Create and push Dev branch
  3. Install opencode on the server
  4. Clone repo on server and configure continuous dev script
  5. Set up systemd service for continuous development
  6. Verify full setup works end-to-end
- Progress:
  - Plan.md created and pushed
  - Dev branch created and pushed to origin
  - opencode 1.17.14 installed on server (novadownloadmanager)
  - Repo cloned at /home/ubuntu/NOVA on server
  - Continuous dev agent script at /usr/local/bin/nova-dev-agent.sh
  - systemd timer nova-dev-agent.timer active (every 3 hours)
  - Zen provider configured with Big Pickle model (free)
  - 8GB swap file created on server
- Notes:
  - Server: Ubuntu 24.04, 141.147.26.53 (novadownloadmanager)
  - Repo: https://github.com/Alaa91H/NOVADownloadManager.git
  - Big Pickle model: opencode/big-pickle (free via Zen)

---

## Planned Tasks

### INFRA-002 — Set up GitHub Actions opencode workflow

- Status: `[ ] PLANNED`
- Priority: high
- Type: ci
- Source branch: `Dev`
- Work branch: `ai/github-actions-workflow`
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
  - Configure GitHub Actions to run opencode on schedule and on issue/PR comments.
- Plan:
  1. Create .github/workflows/opencode.yml
  2. Configure schedule and event triggers
  3. Add appropriate secrets
- Notes:
  - Requires ANTHROPIC_API_KEY secret in GitHub
  - Model: opencode/big-pickle

### DEV-001 — Run initial project audit and inspection

- Status: `[/] IN_PROGRESS`
- Priority: high
- Type: testing
- Source branch: `Dev`
- Work branch: `ai/initial-audit`
- Target branch: `Dev`
- Started: 2026-07-07
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
  - Inspect full project, run all validation scripts, identify issues, and create prioritized tasks.
- Plan:
  1. Run pnpm install --frozen-lockfile
  2. Run lint, typecheck, test, build
  3. Run audit scripts
  4. Document findings
  5. Create follow-up tasks
- Notes:
  - Foundation task for all future work

### REL-001 — Configure release channels and versioning

- Status: `[ ] PLANNED`
- Priority: medium
- Type: release
- Source branch: `Dev`
- Work branch: `ai/release-config`
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
  - Set up release automation for dev, nightly, alpha, beta, rc, stable channels.
- Plan:
  1. Review current release scripts
  2. Create release workflow
  3. Test with dev channel
- Notes:
  - Current version: 0.1.0

---

## Completed Tasks

*None yet.*

---

## Blocked Tasks

*None yet.*
