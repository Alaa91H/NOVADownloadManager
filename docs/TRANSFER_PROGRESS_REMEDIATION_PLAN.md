# Transfer and Live-Progress Remediation Plan

## Objective

This remediation makes a download successful only when NOVA has actually analyzed and transferred the target content, produced the expected output bytes, surfaced authoritative status transitions, and emitted measurable progress while the transfer is still active. A completed task without an observed byte-level progression is not an acceptable outcome for known-size payloads.

## Confirmed Finding

The Rust suite contains an integration-style unit test, `daemon::curl::task_api::tests::multi_socket_runtime_downloads_local_response`, which starts a loopback HTTP server and exercises the libcurl socket runtime. The test hangs before its server receives the request. System-call tracing shows a non-blocking TCP connection is opened but no HTTP request is written. The current socket driver can call `Multi::wait` with a zero timer duration instead of honoring libcurl's immediate timer callback through `Multi::timeout`. This blocks real transfers before data starts flowing.

## Priority-Ordered Work

| Priority | Work item | Definition of done |
| --- | --- | --- |
| P0 | Repair libcurl multi-socket scheduling | A zero-delay libcurl timer is executed immediately through `Multi::timeout`; socket updates are drained after each action; the loopback transfer test completes within a bounded time. |
| P0 | Add deterministic transfer fixtures | Local HTTP fixtures cover a direct known-length file, a redirect chain, an encoded/query-bearing URL, a slow chunked response, and a response without `Content-Length`. Each fixture proves content integrity and final state. |
| P0 | Prove true progress events | A deliberately throttled known-length response produces at least two distinct in-progress byte counters before completion, with monotonic percentage and byte values. |
| P1 | Verify UI consumption of authoritative progress | The front-end store consumes emitted status/progress events without mount-time race conditions, preserves intermediate values, and represents unknown-size transfers as indeterminate rather than falsely showing `0%`. |
| P1 | Harden analysis/fallback selection | Analysis safely normalizes links, follows permitted redirects, rejects unsafe destinations, retains an explicit referer only when configured, and falls back only to validated direct candidates. |
| P2 | Validate packaging and regression gates | Static checks, Rust tests, front-end tests, browser-extension checks, production bundle checks, and an installable package build succeed in their supported build environment. |

## Mandatory Practical Acceptance Tests

| Scenario | Practical setup | Required evidence |
| --- | --- | --- |
| Direct download | Local HTTP endpoint serving a known byte sequence with `Content-Length` | Saved bytes and SHA-256 match the fixture; final HTTP status is successful. |
| Complex link | Redirecting endpoint with query parameters and URL-encoded path components | Final resolved resource is downloaded correctly without mangling the URL. |
| Slow, known-size server | Endpoint writes multiple chunks with controlled delays and a declared length | Observed event stream contains a start value, at least two increasing intermediate byte counts, and a final value equal to the declared size. |
| Unknown-size server | Chunked endpoint with no `Content-Length` | Payload integrity is proved; UI contract is indeterminate while active and never fabricates a numeric total or a stuck `0%`. |
| Failure behavior | Dead candidate or non-success HTTP status followed by a valid candidate | The invalid candidate is rejected and the valid candidate is selected only after validation. |
| Front-end rendering | Progress helper/component test fed with real-style event transitions | Rendered state changes from queued/starting to an intermediate progress state and then to completion without skipping the intermediate state. |

## Completion Rule

The remediation is complete only after every mandatory practical acceptance test passes, the complete Rust and TypeScript test suites pass, and the release build completes. Any environment-dependent package artifact will be labeled with its target platform and verified command; unsupported cross-platform installers will not be claimed as built.

## Traceability

Every code change must include or update a regression test. The final report will list the command, fixture, observed progress sequence, content-integrity result, and build artifact location for each acceptance scenario.
