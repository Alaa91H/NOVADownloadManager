# Link Intake and Duplicate-Safety Review — August 2026

## Scope

This review evaluates whether NOVA should improve the transition from a discovered, pasted, or browser-captured URL into the actual download queue. The focus is bounded: preserve NOVA's direct-download architecture and signed-URL privacy controls while making intake decisions explicit and safe.

## Source: JDownloader LinkGrabber

[JDownloader's official LinkGrabber guide](https://support.jdownloader.org/en/knowledgebase/article/linkgrabber-how-to-add-links) describes multiple intake paths—clipboard observation, paste, manual add dialog, remote app, and browser add-on—but keeps newly discovered items in a LinkGrabber stage. Its quick settings distinguish automatic confirmation from automatic download start, use a visible delay indicator, and allow confirmation without starting. The guide also describes waiting for discovery to finish, with an explicit configurable maximum delay for long-running crawls.

### Product implication

The useful transferable pattern is **an explicit review/confirmation boundary**, not a copy of JDownloader's crawler scope or automatic clipboard capture. NOVA already has staged probes, browser-capture review records, and a direct Add Download dialog. Any enhancement should unify the duplicate decision at that boundary and should never canonicalize or compare signed URLs by stripping security-sensitive query parameters for submission.

## Source: Free Download Manager

[Free Download Manager's official feature page](https://www.freedownloadmanager.org/features.htm) presents browser add-on support alongside accelerated/resumable downloads, smart file management, scheduling, and adjustable traffic use. It validates that browser-originated intake is a first-class product surface, but it does not justify automatic replacement of a user’s explicit queue choices.

### Product implication

NOVA should make a potentially repeated intake visible at the same deliberate boundary as browser handoff and direct submission. A warning must remain non-destructive and must not block legitimate repeated downloads such as a refreshed build artifact or intentionally separate destination.

## Initial NOVA baseline

- NOVA already deduplicates queue entries in the native priority queue and deduplicates RFC 6249 mirror URLs.
- Browser extension capture APIs already return a `duplicate` signal alongside capture-review records.
- Batch import has exact concrete-URL duplicate handling, but the desktop Add Download flow requires a focused inspection before asserting consistent duplicate feedback across pasted URL, staged probe, and submission paths.

## Working hypothesis

A high-value narrow improvement is to provide **safe exact-match duplicate feedback** when the user is about to submit a direct HTTP(S) download. It must compare only the raw submitted URL against existing task URLs (no query stripping, path normalization, or credential exposure), expose a non-blocking warning with a clear user choice, and retain the user's ability to intentionally download the same resource again. The implementation decision remains pending validation against the current Add Download and task-store code.

## Source: AB Download Manager (open source)

The [AB Download Manager repository](https://github.com/amir1376/ab-download-manager) documents browser extensions as a separately distributed integration with the desktop application and directs users to dedicated extension packages. This supports treating capture/review handoff as a durable boundary with its own validation and user feedback. Its public README did not provide sufficient primary evidence for a specific duplicate-resolution policy, so this review does not attribute one to the project.

## Decision criteria for a NOVA improvement

A change is acceptable only if it detects an exact repeat without altering the submitted URL, communicates that state without leaking URL details, preserves an explicit override for intentional repeats, works consistently for manual and extension-derived submissions, and is covered by unit plus dialog-level regression tests.
