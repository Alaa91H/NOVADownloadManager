# Code Style Guide

This document defines the coding conventions for the NOVA Download Manager project. Consistency in style makes the codebase easier to read, review, and maintain.

---

## TypeScript / React

### Naming Conventions
| Entity | Convention | Example |
|--------|------------|---------|
| Component | `PascalCase` | `DownloadCard` |
| Hook | `camelCase` + `use` prefix | `useDownloadState` |
| Utility function | `camelCase` | `formatBytes` |
| Type / Interface | `PascalCase` | `DownloadTask` |
| Enum | `PascalCase` with `SCREAMING_SNAKE` values | `DownloadStatus.IN_PROGRESS` |
| Constant | `SCREAMING_SNAKE_CASE` | `MAX_CONNECTIONS` |
| CSS variable | `--kebab-case` | `--accent-primary` |

### File Naming
- React components: `PascalCase.tsx` (e.g. `TaskTable.tsx`)
- Hooks: `use<Name>.ts` (e.g. `useEngineCapabilities.ts`)
- Utilities: `camelCase.ts` (e.g. `formatUtils.ts`)
- Type-only files: suffix `.types.ts` (e.g. `desktop-ui.types.ts`)

### Imports
1. Node built-ins first
2. External packages
3. Internal absolute imports (`@/`)
4. Relative imports

Always use `import type` for type-only imports:
```ts
import type { DownloadTask } from '@/types/desktop-ui.types';
```

### Component Guidelines
- Use **functional components** with hooks exclusively.
- Add explicit return types on all exported functions.
- Decompose components larger than ~200 lines into smaller pieces.
- Use `useCallback` for event handlers passed as props.
- Use `useMemo` for expensive derived data, not as a default.

### Error Handling
- Never swallow errors silently — log with `logger.error()` at minimum.
- Use `ErrorBoundary` from `components/ErrorBoundary.tsx` for subtree boundaries.
- In async functions, always `await` Promises or handle rejection explicitly.

### No `any`
The ESLint rule `@typescript-eslint/no-explicit-any` is set to **error**. Use:
- `unknown` when the type is genuinely unknown
- Proper generics when the shape is consistent
- Discriminated unions for variant data

---

## Rust

### Naming Conventions
- Follow standard Rust conventions: `snake_case` for functions/variables, `PascalCase` for types.
- Prefix internal error types with `Error` (e.g. `DownloadError`).

### Error Handling
- Use `thiserror` or `anyhow` — never `unwrap()` in library code (`lib.rs`).
- Use `expect()` only in `main.rs` for unrecoverable startup failures with a descriptive message.
- All `MutexGuard` lock paths must handle `PoisonError` via `.unwrap_or_else(|e| e.into_inner())`.

### Safety
- `unsafe` blocks require a `// SAFETY:` comment explaining the invariant.
- `#![deny(unsafe_code)]` is recommended for modules that do not require FFI.

---

## CSS

### Variables
All design tokens live in `src/styles/tokens.css`. **Never** hardcode color values in component styles — always reference a token.

### Specificity
- Keep specificity low: prefer single-class selectors.
- Avoid `!important` except in utility overrides.

### Performance
- Apply `will-change: transform` only to actively animated elements.
- Use `contain: layout style` on high-volume list items (table rows, download cards).

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`

Examples:
```
feat(engine): add HTTP/2 multiplexing support
fix(ui): prevent progress bar overflow on small screens
docs(contributing): add PR checklist
chore(deps): bump react to 19.2.7
```

---

## Pull Request Checklist

Before opening a PR, verify:

- [ ] `pnpm run lint` passes (TypeScript type-check)
- [ ] `pnpm run lint:eslint` passes with zero warnings
- [ ] `pnpm run format:check` passes
- [ ] `pnpm test` passes
- [ ] New features include unit tests
- [ ] No `console.log` left in production code
- [ ] No hardcoded secrets or credentials
- [ ] `CHANGELOG.md` updated if this is a user-visible change
