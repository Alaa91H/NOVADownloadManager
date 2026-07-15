---
name: tauri-dev
description: Use when working with Tauri desktop application, Rust daemon, native engines, or desktop-specific features. Covers Tauri API, Rust code, libcurl integration, and desktop UI components.
---

# Tauri Development Skill

## Overview

This skill covers development for the NOVA desktop application built with Tauri, including the Rust daemon, native engine integration, and desktop-specific UI components.

## Key Files and Locations

- **Rust daemon**: `src-tauri/src/`
- **Tauri config**: `src-tauri/tauri.conf.json`
- **Cargo manifest**: `src-tauri/Cargo.toml`
- **Desktop UI**: `src/` (React components)
- **Tauri plugins**: `src-tauri/plugins/`

## Development Workflow

### Rust Development
```bash
# Check for compilation errors
cargo check --manifest-path src-tauri/Cargo.toml

# Run clippy for linting
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# Run tests
cargo test --manifest-path src-tauri/Cargo.toml

# Format code
cargo fmt --manifest-path src-tauri/Cargo.toml
```

### Tauri Desktop App
```bash
# Run in development mode
pnpm run tauri:dev

# Build for production
pnpm run tauri:build

# Prepare Tauri assets
pnpm run tauri:prepare
```

### Native Engine Integration
- **libcurl**: Built via `scripts/build-native-curl.mjs`
- **yt-dlp**: Downloaded via `scripts/fetch-engines.mjs`
- **FFmpeg**: Bundled for media post-processing

## Architecture Patterns

### Engine Capability System
The desktop UI must never expose controls for unsupported engine capabilities:
1. `EngineCapabilityContext.tsx` polls `/api/engines/capabilities`
2. Dialogs validate options before submission
3. UI disables unsupported features at render time

### API Communication
- Frontend communicates with daemon via HTTP (loopback)
- All communication is local (127.0.0.1)
- No remote telemetry or control

### State Management
- Zustand stores for global state
- React context for engine capabilities
- Local state for UI-specific concerns

## Common Tasks

### Adding a New Engine Capability
1. Add capability detection in Rust daemon
2. Expose via `/api/engines/capabilities`
3. Update `EngineCapabilityContext.tsx`
4. Gate UI controls in relevant dialogs

### Modifying Native Engine
1. Update build scripts in `scripts/`
2. Test cross-platform builds
3. Update dependency versions in `scripts/fetch-engines.mjs`
4. Verify compatibility with existing features

### Desktop UI Components
1. Follow React/TypeScript conventions
2. Use Tailwind CSS for styling
3. Integrate with Tauri API for native features
4. Test with mocked daemon responses

## Testing Strategy

### Unit Tests
- React Testing Library for component tests
- Vitest for unit testing
- Mock Tauri API calls

### Integration Tests
- Playwright for E2E browser tests
- Test daemon integration paths
- Validate capability gating end-to-end

### Security Tests
- Injection vulnerability scanning
- Path traversal testing
- Authentication bypass checks

## Common Pitfalls

1. **Capability Gating**: Never expose UI controls without engine support verification
2. **Platform Differences**: Test on Windows, macOS, and Linux
3. **Native Dependencies**: Ensure proper linking for libcurl, OpenSSL, etc.
4. **Error Handling**: Graceful degradation for missing engines
5. **Performance**: Optimize for large file downloads and media processing

## Useful Commands

```bash
# Development
pnpm run tauri:dev          # Run desktop app in dev mode
cargo check --manifest-path src-tauri/Cargo.toml  # Check Rust compilation

# Testing
cargo test --manifest-path src-tauri/Cargo.toml   # Run Rust tests
pnpm test                   # Run frontend tests

# Building
pnpm run tauri:build        # Build production desktop app
pnpm run fetch-engines      # Download and prepare engines

# Linting
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings  # Rust linting
pnpm run lint               # TypeScript typecheck
pnpm run lint:eslint        # ESLint
```

## References

- Tauri Documentation: https://tauri.app/v1/guides/
- Rust Book: https://doc.rust-lang.org/book/
- libcurl Documentation: https://curl.se/libcurl/c/
- NOVA Architecture: `docs/architecture/`
- Capability Gating: `docs/architecture/CAPABILITY_GATING.md`
