---
name: browser-ext
description: Use when working with the NOVA browser extension, Manifest V3, browser APIs, Native Messaging, or extension-specific testing. Covers Chrome, Firefox, and Edge compatibility.
---

# Browser Extension Skill

## Overview

This skill covers development for the NOVA browser extension, a Manifest V3 companion that communicates with the desktop daemon via Native Messaging and provides download management capabilities directly in the browser.

## Key Files and Locations

- **Extension source**: `browser-extension/`
- **WXT config**: `browser-extension/wxt.config.ts`
- **Manifest**: `browser-extension/src/manifest.ts`
- **Background scripts**: `browser-extension/src/background/`
- **Content scripts**: `browser-extension/src/content/`
- **Popup UI**: `browser-extension/src/popup/`
- **Tests**: `browser-extension/src/__tests__/`

## Development Workflow

### Setup
```bash
# Install dependencies
pnpm --filter nova-browser-extension install

# Run in development mode
pnpm --filter nova-browser-extension dev

# Build for production
pnpm --filter nova-browser-extension build

# Package as zip for store submission
pnpm run extension:package
```

### Testing
```bash
# Typecheck
pnpm --filter nova-browser-extension typecheck

# Verify offline capabilities
pnpm --filter nova-browser-extension verify:offline

# Verify Nova sync
pnpm --filter nova-browser-extension verify:nova-sync

# Run tests
pnpm --filter nova-browser-extension test

# Run with coverage
pnpm --filter nova-browser-extension test:coverage
```

## Architecture Patterns

### Manifest V3 Compliance
- Service worker-based background scripts
- No persistent background pages
- Proper permissions and content security policy
- Host permissions for loopback communication

### Nova Sync Protocol
- Browser extension syncs with desktop daemon
- Capability negotiation on startup
- Secure message passing via Native Messaging

### Transport Budget System
- Manages bandwidth allocation
- Prioritizes active downloads
- Respects system network conditions

## Key Components

### Background Service Worker
- Manages download lifecycle
- Handles Native Messaging communication
- Coordinates with daemon for engine capabilities

### Content Scripts
- Injected into web pages
- Detects downloadable content
- Provides context menu integration

### Popup UI
- React-based interface
- Shows active downloads
- Manages settings and preferences

### Bridge/Capability Layer
- Validates engine capabilities before sending requests
- Gates protocol and stream support
- Prevents unsupported feature exposure

## Common Tasks

### Adding a New Browser Feature
1. Update manifest permissions if needed
2. Add content script or background logic
3. Integrate with Nova sync protocol
4. Test across Chrome, Firefox, Edge

### Modifying Download Handling
1. Update background service worker
2. Modify transport budget calculations
3. Test with various content types
4. Verify daemon communication

### Extension Store Preparation
1. Run verification scripts
2. Build production package
3. Generate store assets
4. Validate compliance requirements

## Testing Strategy

### Unit Tests
- Jest for component tests
- Mock browser APIs
- Test message passing logic

### Integration Tests
- Playwright for browser automation
- Test extension installation flow
- Verify daemon communication

### Cross-Browser Testing
- Chrome: Primary development target
- Firefox: Manifest V3 compatibility
- Edge: Chromium-based, should work like Chrome

## Security Considerations

### Content Security Policy
- Strict CSP for extension pages
- No inline scripts or eval
- Proper nonce handling

### Permission Model
- Minimal permissions requested
- Host permissions for loopback only
- No remote server communication

### Data Handling
- No telemetry or analytics
- Local storage only
- Secure message passing

## Common Pitfalls

1. **Manifest V3 Limits**: Service workers can be terminated; use chrome.alarms for periodic tasks
2. **Cross-Browser Differences**: Test Firefox-specific APIs
3. **Native Messaging**: Ensure proper host registration
4. **Content Scripts**: Avoid conflicts with page scripts
5. **Permissions**: Request minimal permissions; explain why each is needed

## Useful Commands

```bash
# Development
pnpm --filter nova-browser-extension dev          # Run in dev mode
pnpm --filter nova-browser-extension build        # Build for production

# Testing
pnpm --filter nova-browser-extension typecheck     # Type checking
pnpm --filter nova-browser-extension test          # Run tests
pnpm --filter nova-browser-extension verify:offline # Offline verification

# Packaging
pnpm run extension:package                         # Package as zip

# Verification
pnpm --filter nova-browser-extension verify:nova-sync  # Verify sync protocol
pnpm --filter nova-browser-extension audit:release     # Release audit
```

## References

- Manifest V3 Documentation: https://developer.chrome.com/docs/extensions/mv3/
- WebExtension API: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions
- Native Messaging: https://developer.chrome.com/docs/extensions/mv3/nativeMessaging/
- NOVA Extension Docs: `docs/extension/`
- Security Model: `docs/extension/SECURITY.md`
