# NOVA Download Manager — Maintainer Reference

## Server Runtime Policy

The remote server is a repository orchestration node only. Do not run local build, test, lint, coverage, audit, packaging, dependency-install, or release commands from service-controlled processes on that server. Use GitHub Actions for validation and release gates.

## Quality Gates

Run these in GitHub Actions or on a capable development workstation, not from the server runtime.

```bash
pnpm install --frozen-lockfile
pnpm lint                          # tsc --noEmit
pnpm lint:eslint
pnpm format:check
pnpm test                           # vitest run
pnpm test:coverage                  # with coverage
pnpm build                          # vite build
pnpm audit:final
pnpm i18n:validate
pnpm i18n:validate-primary
pnpm extension:install
pnpm extension:build
pnpm native-curl:build
pnpm native-curl:verify
pnpm bundle
```

## E2E Tests (target 10%+ coverage)

### Install Playwright
```bash
npm install -D @playwright/test
npx playwright install chromium
```

### Test Structure
```
src/e2e/
  downloads.spec.ts
  settings.spec.ts
  scheduler.spec.ts
  sidebar.spec.ts
  i18n.spec.ts
  tasks.spec.ts
  queue.spec.ts
  api.spec.ts
  ui-components.spec.ts
  navigation.spec.ts
```

### Commands
```bash
pnpm exec playwright test
pnpm exec playwright test --ui
pnpm exec playwright show-report
pnpm exec playwright test --project=chromium
```

## Build & Cross-Platform

### Tauri Build
```bash
pnpm tauri:build --target x86_64-pc-windows-msvc
pnpm tauri:build --target i686-pc-windows-msvc
pnpm tauri:build --target aarch64-pc-windows-msvc
pnpm tauri:build --target x86_64-unknown-linux-gnu
pnpm tauri:build --target aarch64-unknown-linux-gnu
pnpm tauri:build --target x86_64-apple-darwin
pnpm tauri:build --target aarch64-apple-darwin
```

### Native Curl
```bash
pnpm native-curl:build
pnpm native-curl:verify
pnpm native-curl:env
```

### Release
```bash
pnpm version:apply --version=X.Y.Z
pnpm release
pnpm bundle
pnpm audit:final
```

### Browser Extension
```bash
pnpm extension:install
pnpm extension:build
pnpm extension:package
```

## Code Quality Standards

- `strict: true` in tsconfig
- No `any` types (use `unknown`)
- Explicit return types
- Functional components only
- Explicit props interfaces
- Error boundaries
- Loading/empty/error states
- Zustand stores with explicit types
- Selectors optimized
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`

## Deployment Targets

| Platform | Arch | Status |
|----------|------|--------|
| Windows  | x64  | ✅     |
| Windows  | x86  | ⬜     |
| Windows  | ARM64| ⬜     |
| Linux    | x64  | ✅     |
| Linux    | ARM64| ⬜     |
| macOS    | x64  | ⬜     |
| macOS    | ARM64| ⬜     |
| Android  | ARM64| 🔍     |
| iOS      | ARM64| 🔍     |

## Coverage Targets
- Current: ~3%
- Target 1: **10%** (E2E + unit)
- Target 2: 25%
- Target 3: 50%
- Target 4: 75%+

## Continuous Improvement Checklist
- [ ] Fix all errors and warnings
- [ ] Write E2E tests
- [ ] Reach 10%+ coverage
- [ ] Build for all platforms
- [ ] Complete CI/CD
- [ ] All quality gates pass
- [ ] Clean audit
- [ ] Full i18n validation
- [ ] Updated documentation
- [ ] Optimized bundle
