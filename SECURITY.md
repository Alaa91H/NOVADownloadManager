# Security Policy

NOVA Download Manager is a desktop application that runs a local daemon, links a
native download engine, and communicates with a browser companion over a
strictly local bridge. Because it handles URLs, files, and native processes, we
take security reports seriously.

## Supported versions

NOVA is pre-1.0. Security fixes are applied to the latest released version and
the `main` branch. Older tagged builds are not patched individually — please
upgrade to the latest release.

| Version | Supported |
| --- | --- |
| Latest release / `main` | ✅ |
| Older tagged builds | ❌ (upgrade to latest) |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately through one of:

- GitHub **Security Advisories** — "Report a vulnerability" on the repository's
  Security tab (preferred; supports coordinated disclosure).
- The Telegram channel: https://t.me/NOVADownloadManager (request a private
  contact for a security report).

Please include:

- A description of the issue and its impact.
- Steps to reproduce (proof of concept if possible).
- Affected version / commit and platform.
- Any suggested remediation.

We aim to acknowledge reports within a reasonable time and will keep you updated
on remediation progress. Please allow a coordinated-disclosure window before any
public discussion.

## Scope and security model

NOVA's architecture is designed to minimize attack surface:

- **Local-only bridge.** The browser extension talks to the daemon over loopback
  HTTP (`http://127.0.0.1`) and a Native Messaging host
  (`com.nova.downloadmanager`). There is no remote telemetry or remote control
  channel.
- **Capability gating.** User-facing controls are derived from engine
  capabilities verified at runtime; unsupported protocols/features are not
  offered or accepted (see
  [docs/architecture/CAPABILITY_GATING.md](docs/architecture/CAPABILITY_GATING.md)).
- **Scoped process handling.** The installer and app target only processes
  launched from the installed application directory.
- **Browser extension security** is documented separately in
  [docs/extension/SECURITY.md](docs/extension/SECURITY.md) (permissions, DRM
  guard, transport budgets, and store-compliance model).

### Especially interested in reports about

- Command/argument injection into the native engines (curl, yt-dlp, FFmpeg).
- Path traversal or arbitrary file write via download destinations or merges.
- Loopback bridge or Native Messaging authentication/pairing bypass.
- Privilege escalation via installer/uninstaller hooks or native host
  registration.

### Out of scope

- Vulnerabilities in third-party engines themselves (report those upstream to
  curl, yt-dlp, or FFmpeg) — though we welcome a heads-up so we can update the
  bundled version.
- Issues requiring a already-compromised local machine or physical access.
