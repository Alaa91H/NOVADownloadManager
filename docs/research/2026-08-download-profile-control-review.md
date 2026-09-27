# Download Profile Control Review — August 2026

## Scope

This review evaluates a narrowly scoped improvement after `v2.4.33-alpha`: expose NOVA's existing native download-engine profiles as an explicit, safe user control. The goal is to turn a currently discoverable API capability into a coherent product workflow, rather than add speculative protocols or duplicate controls.

## External comparison

| Product / source                                                                   | Relevant capability                                                                                                                                                                                                                                  | Product implication for NOVA                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Free Download Manager features](https://www.freedownloadmanager.org/features.htm) | Describes selectable traffic-usage modes so browsing and downloads can coexist, alongside a scheduler.                                                                                                                                               | Users need an understandable intent-level control, not merely a numeric rate field.                          |
| [Motrix Next README](https://github.com/AnInsomniacy/motrix-next)                  | Documents separate controls for active tasks, connections per server, segments per file, peer limits, and global/per-task limits with time scheduling.                                                                                               | Performance controls should be explicit about scope and should not silently mix independent engine settings. |
| [aria2 manual](https://aria2.github.io/manual/en/html/aria2c.html)                 | Documents independent options for concurrent downloads, connections per server, splitting, and per-download speed limits. Its `--max-concurrent-downloads` note explicitly distinguishes queue-item concurrency from the connections within an item. | NOVA should preserve the distinction between a policy/profile and a manual global speed cap.                 |

## NOVA baseline findings

NOVA already has four daemon-native built-in profiles in `src-tauri/src/daemon/engine/profiles.rs`: `maximum-speed`, `balanced`, `economical`, and `background`. Each carries connection bounds, adaptive behavior, retry policy, segmentation, optional rate limit, and segment sizing. The daemon exposes `GET` / `POST /api/engine/profiles`, and the frontend client/store already loads and can set the active profile.

However, the normal UI has no profile-selection control. A code search found the profile API/store exposed only as an unused control surface; the existing Scheduler Speed tab exposes numeric list speed limits only. This creates a product gap: users cannot intentionally choose the existing full policy profiles, and a numeric cap alone cannot explain or select retry/connection/segmentation trade-offs.

## Selected change

Add a small, localized **Download profile** control to the Scheduler Speed tab. It must:

1. Read the daemon-provided profile list and active profile through the existing engine store.
2. Display a named selection control with a concise, profile-derived description. It must not hard-code profile IDs as the operational authority.
3. Apply a selected profile through the existing API, disable while pending, and show an accessible error state without pretending a failed write succeeded.
4. Keep the existing scheduler-list speed limiter independent. Selecting a profile changes the engine policy; the scheduler limit remains a separate queue/list setting.
5. Reuse existing translated strings where possible and add only the minimal new keys, synchronised to every supported dictionary using the repository’s established i18n workflow.
6. Cover profile normalization, loading/error/pending behavior, and the existing speed-limit regression path with unit/component tests.

## Acceptance criteria

| Criterion                                                                        | Verification                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Existing built-in and any valid daemon-supplied profile is selectable            | Component test with mocked profile payloads.            |
| Active selection changes only after successful API completion                    | Component test for pending/success and rejection paths. |
| Malformed API payloads do not produce broken option labels or unsafe assumptions | Pure helper tests.                                      |
| Numeric scheduler speed-limit behavior is unchanged                              | Existing and targeted Scheduler Speed tests.            |
| Every locale remains key-complete                                                | `pnpm run i18n:validate`.                               |
| No daemon contract change is required                                            | TypeScript/client and frontend-only diff review.        |

## Deliberate non-goals

This change does not add BitTorrent, remote control, unbounded automatic bandwidth detection, or server-side capability claims. It does not claim that all servers support multiple ranges or that an active transfer will necessarily be reconfigured mid-flight; the profile is an engine policy selection and remains subject to the existing engine lifecycle and server behavior.
