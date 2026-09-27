# Download Progress and Link-Resolution Verification — 2026-08-21

## Scope

This report records the live, deterministic verification performed after the release-pipeline audit. It covers the direct libcurl transfer path, live task snapshots, unknown-size handling, chunked responses, and HTML interstitial link resolution. The tests use in-process loopback HTTP servers and real file writes; they do not mock the transfer engine.

## Results

| Scenario                                  | Live mechanism exercised                                                    | Acceptance condition                                                                                                              | Result |
| ----------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Fresh known-size download                 | A throttled loopback range server streams a 4 MiB payload in 64 KiB chunks. | A task snapshot reports `0 < downloaded_bytes < size_bytes` before completion, and the written file matches the original payload. | Passed |
| Initially unknown size                    | A loopback server supplies `Content-Length` during the active transfer.     | The task learns a usable total during transfer and exposes live progress rather than remaining at 0 until completion.             | Passed |
| Chunked response without `Content-Length` | A loopback server sends a real chunked body.                                | The client keeps progress indeterminate rather than inventing an unsafe percentage, then verifies the completed content.          | Passed |
| HTML interstitial resolution              | A loopback HTML page exposes a direct download target.                      | The resolver selects the real asset URL and downloads the complete file.                                                          | Passed |

## Commands Executed

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  fresh_single_download_reports_intermediate_progress_and_full_content -- --nocapture

cargo test --locked --manifest-path src-tauri/Cargo.toml \
  unknown_size_download_learns_total_from_content_length_for_live_progress -- --nocapture

cargo test --locked --manifest-path src-tauri/Cargo.toml \
  chunked_response_without_content_length_keeps_progress_honest -- --nocapture

cargo test --locked --manifest-path src-tauri/Cargo.toml \
  html_interstitial_with_direct_link_downloads_real_file -- --nocapture
```

All four tests passed on 2026-08-21.

## Technical Evidence

The production transfer handler adds bytes to a shared atomic counter only after a successful write to disk. The active multi-transfer loop reads that counter, reconciles it with the file size, updates the task snapshot, and runs at a bounded 250 ms interval while libcurl has an active transfer. The fresh-download test deliberately throttles the local server so an intermediate snapshot is a required and deterministic assertion rather than a timing race.

| Source                                              | Verified behavior                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/daemon/curl/easy_config.rs`          | `SegmentWriter::write` increments the transferred-byte counter after `write_all` succeeds.              |
| `src-tauri/src/daemon/curl/transfer.rs`             | The transfer tick records downloaded bytes, discovered total, speed, and ETA in the live task snapshot. |
| `src-tauri/src/daemon/curl/multi.rs`                | The active multi loop invokes the progress tick at most 250 ms apart while work remains.                |
| `src-tauri/src/daemon/curl/transfer.rs` test module | The four tests above operate against real loopback HTTP responses and validate output bytes.            |

## Environment Limitation

The sandbox linked against its fallback/system libcurl for these local tests, as reported by the build script. Release CI uses its separate platform toolchains and successfully built the six release targets. Therefore, this report establishes actual engine behavior in a deterministic local network environment, but it does not replace a final manual GUI run on each target operating system or an authenticated YouTube download, which remains subject to external site anti-bot controls.

## Conclusion

The investigated defect class—progress staying at zero until a transfer suddenly completes—was not reproduced. The direct-download engine emitted verified intermediate byte counts during a real throttled transfer, preserves honest indeterminate state when a total is unavailable, and resolves a tested HTML interstitial to its direct asset.
