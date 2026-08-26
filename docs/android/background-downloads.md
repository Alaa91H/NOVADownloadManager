# Background Download Execution

## Principle

**Android lifecycle is not download lifecycle.** The Rust core must persist durable task intent and checkpoints frequently enough to survive process loss. Android decides when execution is permitted, starts or stops an approved unit of work, and surfaces progress and errors through platform notifications.

The initial Android foundation contains only an inert `NovaUserInitiatedTransferJobService` entry point. It deliberately performs no byte transfer because the versioned Rust task-session handoff does not exist yet. This is safer than a Kotlin implementation that would create a second download engine.

## Execution policy

| User or system scenario | Android 14+ mechanism | Earlier-device mechanism | Rust responsibility | Android responsibility | Current state |
|---|---|---|---|---|---|
| User explicitly starts an immediate, visible download | User-Initiated Data Transfer (UIDT) job | Validated foreground/long-running work fallback | Run a durable task session; emit bounded progress; checkpoint state. | Start work while permitted, attach notification, cancel safely. | Designed only; no task session yet. |
| Deferred or constrained retry, Wi-Fi-only work | WorkManager with constraints | WorkManager | Select eligible task according to shared retry policy. | Translate network/battery/storage preferences to constraints. | Deferred. |
| Finalization, cleanup, metadata refresh | Bounded WorkManager work | Bounded WorkManager work | Validate and commit core state. | Schedule short work; obey constraints and cancellation. | Deferred. |
| Media processing | Only applicable `mediaProcessing` handling with separate policy | Explicit user-visible bounded alternative | Media intent/model only once designed. | Codec/backend/notification policy. | Explicitly deferred. |

Android recommends UIDT for user-initiated data transfers that show immediate progress on Android 14 and higher, while deferrable transfer work should use WorkManager.[1] Long-running workers use a foreground service underneath and are still subject to Android's background and foreground-service restrictions.[2]

## Required state transitions

A future `TaskSession` bridge must make these transitions durable before reporting success to Android:

```text
Created → Queued → Eligible → Running → Pausing → Paused
                                 │              │
                                 ├→ Retrying ───┘
                                 ├→ Failed
                                 ├→ Cancelled
                                 └→ Completed → Finalized
```

| Event | Android action | Core action | Recovery rule |
|---|---|---|---|
| User starts a download | Submit UIDT/fallback unit only after a task is durable. | Create or resume task session. | Reconcile a job ID to durable task ID on restart. |
| OS stops work | Call stop/cancellation bridge without assuming a process callback. | Persist checkpoint and retry eligibility. | Resume only under shared policy and current Android constraints. |
| User pauses/cancels from notification | Send a typed command, then update notification only after state confirmation. | Own state transition and cleanup policy. | Avoid relying on UI process state. |
| Process dies | No cleanup assumption. | Restore from durable storage next session. | Android reconciles stale notifications/jobs. |
| Destination grant is revoked | Surface a recoverable task error. | Preserve task metadata; do not write elsewhere. | Ask user to select destination again. |

## Notification policy

A real transfer implementation must create the `Downloads` notification channel, request notification permission where applicable, and provide actions mapped to typed core commands. UI text may change immediately to indicate a requested action, but the canonical task state must come from the core snapshot after the command returns.

| Notification control | Typed core command | Android guard |
|---|---|---|
| Pause | `pauseTask(taskId)` | Only for a running, pausable task. |
| Resume | `resumeTask(taskId)` | Only for a paused/retryable task and valid network conditions. |
| Cancel | `cancelTask(taskId)` | Confirmation policy for destructive cleanup; never delete unrelated files. |
| Retry | `retryTask(taskId)` | Only where core marks error retryable and OS policy permits. |
| Open | Navigation intent to task detail | Never includes secrets, headers, or opaque storage grants in extras. |

## Explicit non-goals in this milestone

No background service currently transfers data. No WorkManager request, UIDT dispatch, notification action, scheduler, or process-death recovery flow has been executed on an Android device. The manifest permissions and service declaration are preparatory only and must not be described as production download support.

## Acceptance tests before enabling a real transfer

| Test | Required evidence |
|---|---|
| Immediate start | User starts a direct HTTP(S) task on API 34+; UIDT policy path and visible progress are observed. |
| Backgrounding | Download continues/reconciles correctly after Activity is backgrounded. |
| Stop/resume | OS/job stop results in one durable checkpoint and a policy-correct resume. |
| Force-stop/process loss | No corrupt state; new launch reports a reconciled task state. |
| Network transition | Offline, metered, roaming, and Wi-Fi-only constraints behave as selected. |
| Notification actions | Pause/resume/cancel map to core state transitions without duplicate work. |

## References

[1] [Android Developers — Data transfer background task options](https://developer.android.com/develop/background-work/background-tasks/data-transfer-options)

[2] [Android Developers — Support for long-running workers](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running)

[3] [Android Developers — User-initiated data transfer jobs](https://developer.android.com/develop/background-work/background-tasks/uidt)
