use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ::curl::easy::Easy2;
use ::curl::multi::Easy2Handle;

use super::completion::{merge_parts, part_size, validate_transfer_size, verify_output_sha256};
use super::{
    apply_easy_options, create_easy_for_range_ext, drive_multi_wait_perform,
    drive_multi_wait_perform_until, requested_connections, CurlMultiGuard, CurlTransferConfig,
    DirectDownloadPlan, HtmlHeadCapture, ResponseCapture, SegmentProgress,
};
use crate::daemon::direct::{FileWriter, RetryPolicy, SegmentPlanner, SegmentRange as ByteRange};

use crate::daemon::engine::config::global_config;
use crate::daemon::engine::policy_engine::{DecisionCategory, DecisionContext};
use crate::daemon::state::SharedState;
use crate::daemon::types::{CurlJob, Segment};
use crate::daemon::utils::{build_segments, now_str};
use crate::lock_or_err;

fn build_decision_context(
    state: &SharedState,
    id: &str,
    plan: &DirectDownloadPlan,
    consecutive_failures: u32,
    current_speed: u64,
    supports_range: bool,
) -> DecisionContext {
    // Use the same normalized origin key as connection learning. The former
    // string split kept URL user info in this value, which could leak a secret
    // into profiler state or diagnostics and caused equivalent origins to be
    // learned independently.
    let host = crate::daemon::direct::host_key(&plan.url).unwrap_or_default();

    // Acquire locks in documented order: curl_jobs (2), engine_trackers (4),
    // then die_orchestrator/resource_manager (10).
    let (active_downloads, total_downloaded, elapsed_secs) = {
        if let Ok(jobs) = state.curl_jobs.lock() {
            let active = jobs
                .values()
                .filter(|j| j.task.status == "downloading")
                .count() as u32;
            if let Some(job) = jobs.get(id) {
                (
                    active,
                    job.task.downloaded_bytes,
                    job.start_time.elapsed().as_secs_f64(),
                )
            } else {
                (active, 0u64, 0.0)
            }
        } else {
            (1u32, 0u64, 0.0)
        }
    };

    // M13: report the ACTUAL segment geometry, not plan.connections — the
    // two can differ when bandwidth-aware clamping reduces the connection
    // count at dispatch time. Fall back to plan.connections when the tracker
    // has no segment info (single-connection / unknown-size path).
    let (attempted_segments, current_connections) =
        if let Ok(trackers) = state.engine_trackers.read() {
            if let Some(tracker) = trackers.get(id) {
                (
                    tracker
                        .segments
                        .as_ref()
                        .map(|seg| seg.segments().len() as u32)
                        .unwrap_or(plan.connections),
                    tracker.adaptive.connections(),
                )
            } else {
                (plan.connections, plan.connections)
            }
        } else {
            (plan.connections, plan.connections)
        };
    let mut completed_segments = 0u32;
    let mut failed_segments = 0u32;
    if let Ok(trackers) = state.engine_trackers.read() {
        if let Some(tracker) = trackers.get(id) {
            if let Some(seg) = tracker.segments.as_ref() {
                let info = seg.segments();
                completed_segments = info.iter().filter(|s| s.progress >= 1.0).count() as u32;
                failed_segments = info
                    .iter()
                    .filter(|s| !s.active && s.downloaded == 0 && s.total_bytes > 0)
                    .count() as u32;
            }
        }
    }

    let (server_stability, throughput_ceiling, per_conn_ceiling, is_rate_limited) = {
        if let Ok(die) = state.die_orchestrator.lock() {
            if let Ok(ps) = die.profile_store.lock() {
                let profile = ps.get_for_host(&host);
                let stability = profile.map_or(0.5, |p| p.stability_score as f32);
                let tput = profile.map_or(0, |p| p.throughput_ceiling);
                let per_conn = profile.map_or(0, |p| p.per_connection_ceiling);
                let rate_limited = ps.is_rate_limited(&host);
                (stability, tput, per_conn, rate_limited)
            } else {
                (0.5f32, 0u64, 0u64, false)
            }
        } else {
            (0.5f32, 0u64, 0u64, false)
        }
    };

    let (memory_pressure, cpu_pressure, disk_pressure) = {
        if let Ok(mut rm) = state.resource_manager.lock() {
            let snap = rm.snapshot();
            let disk_pressure = if snap.is_disk_bottlenecked() {
                0.8
            } else {
                0.1
            };
            (snap.memory_pressure, snap.cpu_usage_pct, disk_pressure)
        } else {
            (0.0, 0.0, 0.0)
        }
    };

    DecisionContext {
        category: DecisionCategory::Connection,
        host,
        file_size: plan.total_size,
        current_speed,
        current_connections,
        active_downloads,
        memory_pressure,
        cpu_pressure,
        disk_pressure,
        server_stability,
        is_rate_limited,
        consecutive_failures,
        supports_range,
        supports_resume: plan.resumable,
        protocol_multiplexed: false,
        rtt_us: 0,
        throughput_ceiling,
        per_connection_ceiling: per_conn_ceiling,
        attempted_segments,
        completed_segments,
        failed_segments,
        total_downloaded,
        elapsed_secs,
    }
}

pub fn task_from_body(
    body: &crate::daemon::types::CreateDownloadBody,
    id: &str,
    name: String,
    output_path: &Path,
    direct_options: HashMap<String, serde_json::Value>,
    args: Vec<String>,
) -> CurlJob {
    use crate::daemon::utils::infer_file_type;
    let category = body
        .category
        .clone()
        .unwrap_or_else(|| infer_file_type(&name).to_owned());
    let file_type = body
        .file_type
        .clone()
        .unwrap_or_else(|| infer_file_type(&name).to_owned());
    let initial_size = body.size_bytes.unwrap_or(0);
    // Blocking filesystem read (a single stat on the partial file). This fn is
    // synchronous and called from the async create_curl_task handler; kept here
    // intentionally so the caller can decide how to schedule it.
    let downloaded = FileWriter::current_size(output_path).unwrap_or(0);
    let task = crate::daemon::types::Task {
        id: id.to_owned(),
        name,
        url: body.url.as_deref().unwrap_or("").to_owned(),
        file_type,
        status: if body.start_immediately.unwrap_or(true) {
            "downloading"
        } else {
            "queued"
        }
        .to_owned(),
        size_bytes: initial_size,
        downloaded_bytes: downloaded,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        elapsed_seconds: 0,
        date_added: now_str(),
        category,
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_owned()),
        connections: requested_connections(body.connections),
        resumable: body.resumable.unwrap_or(true),
        save_path: output_path.to_string_lossy().to_string(),
        description: body
            .description
            .clone()
            .unwrap_or_else(|| "Direct download via libcurl multi".to_owned()),
        segments: build_segments(
            requested_connections(body.connections),
            initial_size,
            downloaded,
            0,
        ),
        referer: body.referer.clone(),
        engine: "libcurl-multi".to_owned(),
        engine_id: id.to_owned(),
        engine_status: Some(
            if body.start_immediately.unwrap_or(true) {
                "starting"
            } else {
                "queued"
            }
            .to_owned(),
        ),
        error_message: None,
    };
    CurlJob {
        task,
        direct_options,
        cancel_token: Arc::new(AtomicBool::new(false)),
        run_generation: Arc::new(AtomicU64::new(0)),
        start_time: Instant::now(),
        segment_prev_bytes: Vec::new(),
        args,
    }
}

pub fn plan_from_job(job: &CurlJob) -> DirectDownloadPlan {
    let config = CurlTransferConfig::from(&job.direct_options);
    let allow_overwrite = config.bool_("allowOverwrite").unwrap_or(true);
    let forced_single = config.bool_("forceSingleConnection").unwrap_or(false);
    let segmented = config.bool_("segmented").unwrap_or(true)
        && !forced_single
        && job.task.resumable
        && job.task.size_bytes >= global_config().min_segment_bytes
        && job.task.connections > 1;
    let etag = config.str_("etag").map(str::to_owned);
    let last_modified = config.str_("lastModified").map(str::to_owned);
    let (validator, validator_is_etag) = if let Some(et) = etag {
        (Some(et), true)
    } else if let Some(lm) = last_modified {
        (Some(lm), false)
    } else {
        (None, false)
    };
    let digest_sha256 = config.str_("digestSha256").map(str::to_owned);
    let link_mirrors = config.array_("linkMirrors");
    let mirror_priorities = config
        .array_u32_("mirrorPriorities")
        .unwrap_or_else(|| vec![1u32; link_mirrors.len()]);
    let preflight_resolved = config.bool_("preflightResolved").unwrap_or(false);
    let preflight_supports_range = config
        .bool_("preflightSupportsRange")
        .unwrap_or(job.task.resumable);
    DirectDownloadPlan {
        url: job.task.url.clone(),
        output_path: std::path::PathBuf::from(&job.task.save_path),
        total_size: job.task.size_bytes,
        connections: job
            .task
            .connections
            .clamp(1, global_config().max_connections_per_download),
        resumable: job.task.resumable,
        allow_overwrite,
        follow_redirects: config.bool_("location").unwrap_or(true),
        fail_on_error: config.bool_("failWithBody").unwrap_or(true),
        segmented,
        remove_on_error: config.bool_("removeOnError").unwrap_or(false),
        referer: config
            .str_("referer")
            .map(str::to_owned)
            .or_else(|| job.task.referer.clone()),
        config,
        validator,
        validator_is_etag,
        digest_sha256,
        link_mirrors,
        mirror_priorities,
        preflight_resolved,
        preflight_supports_range,
    }
}

pub fn split_ranges(total_size: u64, connections: u32, output_path: &Path) -> Vec<ByteRange> {
    SegmentPlanner::new(global_config().max_connections_per_download).plan(
        total_size,
        connections,
        output_path,
    )
}

pub fn remove_stale_parts_for(output_path: &Path) {
    FileWriter::remove_stale_parts_for(output_path);
}

fn resolve_effective_target(plan: &DirectDownloadPlan) -> (String, bool, PreflightData) {
    log::info!(
        "resolve_effective_target: url={}, total_size={}, preflight_resolved={}",
        plan.url,
        plan.total_size,
        plan.preflight_resolved
    );

    // ── RIE preflight skip ─────────────────────────────────────────────
    // When the RIE (Resource Intelligence Engine) has already resolved the
    // URL via reqwest with full anti-bot headers (Sec-Fetch-*, realistic
    // User-Agent, Cloudflare challenge bypass), skip the redundant curl
    // preflight entirely. The RIE already:
    //   - Followed all HTTP redirects and meta-refresh chains
    //   - Detected Cloudflare/Akamai bot challenges
    //   - Determined range support (206 vs 200)
    //   - Collected timing, TLS, and connection diagnostics
    //
    // Running a second preflight with curl would:
    //   1. Double latency (extra round-trip before download starts)
    //   2. Use a different TLS fingerprint (libcurl vs reqwest) that may
    //      trigger bot detection differently
    //   3. Lose cookie/session state from the RIE probe
    //   4. Risk receiving a Cloudflare challenge page on the second request
    if plan.preflight_resolved {
        // Trust the RIE's preflight results ONLY when the resolved resource is
        // a real file. Some sites (get.videolan.org) answer a browser-like
        // User-Agent with an HTML interstitial instead of a redirect; if the
        // RIE recorded that page as the "final" resource we must re-resolve
        // instead of downloading the HTML page itself.
        let rts_html = plan
            .config
            .str_("contentType")
            .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/html"));
        if !rts_html {
            log::info!(
                "resolve_effective_target: RIE already resolved {} — reusing preflight results (range={})",
                plan.url,
                plan.preflight_supports_range
            );
            let preflight = PreflightData {
                supports_range: plan.preflight_supports_range,
                ..Default::default()
            };
            return (plan.url.clone(), plan.preflight_supports_range, preflight);
        }
        log::warn!(
            "resolve_effective_target: RIE recorded an HTML interstitial for {} — re-resolving",
            plan.url
        );
    }

    // ── Preflight loop ─────────────────────────────────────────────────
    //    Every URL goes through this cheap HEAD/GET loop (one request for a
    //    direct file). It follows HTTP redirects (libcurl follow_location),
    //    meta-refresh interstitials and — new — plain `<a href>` download
    //    links found on HTML "thank you" pages (e.g. Sublime). The probe adds
    //    a single round-trip for direct file URLs, but skipping it entirely
    //    let HTML interstitials through: get.videolan.org serves a 200 HTML
    //    page to browser UAs even for `.exe` paths, which then failed or
    //    downloaded the page itself.

    log::info!(
        "resolve_effective_target: no known extension — running preflight HEAD/GET for {}",
        plan.url
    );
    const MAX_META_REFRESH_HOPS: usize = 5;
    let mut current = plan.url.clone();
    let mut preflight = PreflightData::default();
    // Direct-download candidates still to try, ranked best-first. Kept across
    // hops so a dead or interstitial first candidate falls back to the next
    // one instead of aborting the whole resolve (SourceForge mirrors, GitHub
    // releases with several assets, etc.).
    let mut pending_direct: std::collections::VecDeque<String> = std::collections::VecDeque::new();

    for _hop in 0..=MAX_META_REFRESH_HOPS {
        // M10: only the URL changes per hop — avoid cloning the whole plan.
        let hop_plan = plan.clone_with_url(current.clone());

        let mut easy = Easy2::new(HtmlHeadCapture::default());
        if apply_easy_options(&mut easy, &hop_plan, Some((0, 0))).is_err() {
            log::warn!(
                "resolve_effective_target: apply_easy_options failed for hop, returning current={current}"
            );
            // No response was received — do not claim range support; the
            // engine falls back to a single connection on a dead target.
            return (current, false, preflight);
        }
        let _ = easy.timeout(Duration::from_secs(5));
        // Bound the preflight body: the capture handler stores at most 64 KiB
        // but tells curl it consumed everything, so a range-ignoring server
        // that answers our bytes=0-0 probe with a full 200 body would stream
        // the ENTIRE file just to sniff the content-type (the exact "5+
        // seconds of latency" the old fast path existed to avoid). Capping
        // the file size makes curl abort with CURLE_FILESIZE_EXCEEDED before
        // the body arrives while headers (status/content-type) stay readable.
        if plan.config.u64_("maxFilesize").is_none() {
            let _ = easy.max_filesize(1024 * 1024);
        }

        // A size-abort (range-ignoring server) still leaves the response code
        // and content-type readable from the headers, so only bail when we
        // never got a response at all.
        if let Err(e) = easy.perform() {
            let code = easy.response_code().unwrap_or(0);
            if code == 0 {
                log::warn!(
                    "resolve_effective_target: preflight perform failed for {current}: {e}, returning current={current}"
                );
                // The server never answered (network drop, TLS failure):
                // claiming range support here would push a segmented plan
                // against a dead target. Return false and let the transfer
                // fail fast on a single connection instead.
                return (current, false, preflight);
            }
            log::info!(
                "resolve_effective_target: preflight body bounded for {current} (status {code}), continuing with headers"
            );
        }

        let code = easy.response_code().unwrap_or(0);
        let effective = easy
            .effective_url()
            .ok()
            .flatten()
            .filter(|u| u.starts_with("http"))
            .map_or_else(|| current.clone(), |u| u.to_owned());

        if let Ok(t) = easy.total_time() {
            preflight.initial_rtt_us = t.as_micros() as u64;
        }
        if let Ok(t) = easy.appconnect_time() {
            let us = t.as_micros() as u64;
            if us > 0 {
                preflight.tls_handshake_us = us;
                preflight.uses_tls = true;
            }
        }
        if let Ok(t) = easy.connect_time() {
            preflight.connect_us = t.as_micros() as u64;
        }
        if let Ok(t) = easy.starttransfer_time() {
            preflight.ttfb_us = t.as_micros() as u64;
        }

        // Capture the HTTP version from the preflight response so the adaptive
        // engine can make protocol-aware decisions (e.g., HTTP/2 multiplexing
        // supports more concurrent streams than HTTP/1.1).
        {
            if let Some(ver) = easy.get_ref().http_version() {
                preflight.protocol = match ver.as_str() {
                    "1.0" => "HTTP/1.0".to_owned(),
                    "1.1" => "HTTP/1.1".to_owned(),
                    "2" => "h2".to_owned(),
                    _ => format!("HTTP/{ver}"),
                };
            }
        }

        let is_html = easy
            .content_type()
            .ok()
            .flatten()
            .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/html"));

        // A followed candidate that answered with an HTTP error (404/403/5xx)
        // is a dead mirror or asset: fall back to the next ranked candidate
        // instead of failing the resolve outright. This MUST run before the
        // is_html branch: real error pages are served as text/html and carry
        // their own page furniture (logo/favicon/nav links). Parsing those
        // would inject them into the candidate queue ahead of the remaining
        // mirrors — and a `logo.png` or `favicon.ico` (both recognizable
        // extensions now) would be downloaded as the "target file". Error
        // responses are dead ends, never link sources.
        if code >= 400 {
            let mut followed = false;
            while let Some(next) = pending_direct.pop_front() {
                if next.starts_with("http") && next != current && next != effective {
                    log::info!(
                        "resolve: direct-download link {current} -> {next} (fallback after {code})"
                    );
                    current = next;
                    followed = true;
                    break;
                }
            }
            if followed {
                continue;
            }
            return (effective, code == 206, preflight);
        }

        if is_html {
            if let Some(refresh) =
                crate::daemon::utils::parse_meta_refresh_url(&easy.get_ref().text())
            {
                let next = crate::daemon::utils::refreshed_url(refresh, &effective);
                if next.starts_with("http") && next != current && next != effective {
                    log::info!("resolve: meta-refresh {current} -> {next}");
                    current = next;
                    continue;
                }
            }
            // Some download pages (Sublime "thank you", SourceForge, GitHub
            // releases) link the real file via plain <a href> instead of a
            // meta-refresh. Follow the ranked candidates one at a time; the
            // top-ranked link may itself be dead or another interstitial, so
            // keep the leftovers across hops and fall back to the next.
            let fresh = crate::daemon::utils::extract_direct_download_links(
                &easy.get_ref().text(),
                &effective,
            );
            if !fresh.is_empty() {
                // The current page's own links are closest to the file, so try
                // them first — but keep any earlier-page candidates after them
                // so a dead chain of interstitials can still fall back to the
                // original page's remaining links. Dedup by exact URL.
                let mut merged: std::collections::VecDeque<String> = fresh.into_iter().collect();
                for leftover in pending_direct {
                    if !merged.contains(&leftover) {
                        merged.push_back(leftover);
                    }
                }
                pending_direct = merged;
            }
            let mut followed = false;
            while let Some(next) = pending_direct.pop_front() {
                if next.starts_with("http") && next != current && next != effective {
                    log::info!("resolve: direct-download link {current} -> {next}");
                    current = next;
                    followed = true;
                    break;
                }
            }
            if followed {
                continue;
            }
            return (effective, false, preflight);
        }

        // The preflight response is a real file (not an interstitial, not an
        // error page): record its total size so the transfer can start with a
        // known size. This is what lets the UI show a live progress
        // percentage from byte one instead of a fake 0% that only jumps to
        // 100% when the download completes.
        if let Some(len) = easy.get_ref().content_length() {
            if len > 0 {
                preflight.total_size = len;
            }
        }
        preflight.supports_range = code == 206;
        return (effective, preflight.supports_range, preflight);
    }

    (current, false, preflight)
}

#[derive(Clone, Debug, Default)]
struct PreflightData {
    protocol: String,
    initial_rtt_us: u64,
    tls_handshake_us: u64,
    connect_us: u64,
    ttfb_us: u64,
    uses_tls: bool,
    supports_range: bool,
    /// Total file size discovered from the preflight response headers
    /// (Content-Length / Content-Range). 0 when unknown (HTML interstitial,
    /// chunked response, error). The caller seeds `plan.total_size` with this
    /// before dispatch so the UI shows a real progress percentage instead of
    /// a fake 0% that jumps to 100% at completion.
    total_size: u64,
}

fn update_curl_task_progress(
    state: &SharedState,
    id: &str,
    total_size: u64,
    ranges: &[(ByteRange, Arc<AtomicU64>, u64)],
    last_total: &mut u64,
    last_tick: &mut Instant,
) {
    let downloaded: u64 = ranges
        .iter()
        .map(|(range, progress, initial)| {
            let on_disk = *initial + progress.load(Ordering::Relaxed);
            on_disk.min(part_size(range))
        })
        .sum();
    let now = Instant::now();
    let elapsed = now.duration_since(*last_tick).as_secs_f64().max(0.001);
    let speed = downloaded.saturating_sub(*last_total) as f64 / elapsed;
    *last_total = downloaded;
    *last_tick = now;

    let speed_u64 = speed.max(0.0) as u64;

    state.bandwidth_manager.report_speed(id, speed_u64);

    if let Ok(trackers) = state.engine_trackers.read() {
        if let Some(tracker) = trackers.get(id) {
            tracker.adaptive.report_speed(speed_u64);
        }
    }

    // Blocking lock: a try_lock spin would delay cancellation checks and
    // stall progress ticks under contention.
    let mut jobs = match state.curl_jobs.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(job) = jobs.get_mut(id) {
        job.task.downloaded_bytes = downloaded;
        job.task.size_bytes = total_size;
        job.task.speed_bytes_per_sec = speed.max(0.0) as u64;
        job.task.elapsed_seconds = job.start_time.elapsed().as_secs();
        job.task.time_left_seconds = if speed > 0.0 && total_size > downloaded {
            ((total_size - downloaded) as f64 / speed).ceil() as u64
        } else {
            0
        };
        if job.segment_prev_bytes.len() != ranges.len() {
            job.segment_prev_bytes.resize(ranges.len(), 0);
        }
        let mut segment_speeds: Vec<u64> = Vec::with_capacity(ranges.len());
        for (i, (range, progress, initial)) in ranges.iter().enumerate() {
            let seg_total = part_size(range);
            let seg_downloaded = (*initial + progress.load(Ordering::Relaxed)).min(seg_total);
            let prev = job.segment_prev_bytes[i];
            let seg_speed = if seg_downloaded > prev {
                (seg_downloaded - prev) as f64 / elapsed
            } else {
                0.0
            };
            job.segment_prev_bytes[i] = seg_downloaded;
            segment_speeds.push(seg_speed.max(0.0) as u64);
        }
        job.task.segments = ranges
            .iter()
            .enumerate()
            .map(|(i, (range, progress, initial))| {
                let seg_total = part_size(range);
                let seg_downloaded = (*initial + progress.load(Ordering::Relaxed)).min(seg_total);
                Segment {
                    id: range.index as u32,
                    progress: if seg_total > 0 {
                        seg_downloaded as f64 / seg_total as f64
                    } else {
                        0.0
                    },
                    downloaded_bytes: seg_downloaded,
                    total_bytes: seg_total,
                    active: seg_downloaded < seg_total && job.task.status == "downloading",
                    speed: segment_speeds[i],
                    start_byte: range.start,
                    end_byte: range.end,
                }
            })
            .collect();
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
        state.mark_dirty();
    }
}

/// HTTP(S) transfers always yield a non-zero response code after a
/// successful perform. Other protocols (FTP/SFTP/SCP/...) legitimately
/// report `response_code()==0` even on success, so the "no response" guards
/// must only apply to HTTP-family URLs.
fn is_http_family(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Result of a completed transfer pass. Carries everything the completion
/// path needs to decide whether the download may be marked complete.
#[derive(Clone, Debug)]
pub(super) struct TransferOutcome {
    pub(super) size: u64,
    pub(super) validator: Option<String>,
    /// True when the server actually sent a `Content-Encoding` (captured
    /// from response headers, not assumed from config), meaning libcurl
    /// decompressed the body and on-disk size may differ from the probed
    /// Content-Length.
    pub(super) content_encoded: bool,
}

impl TransferOutcome {
    const fn plain(size: u64, validator: Option<String>) -> Self {
        Self {
            size,
            validator,
            content_encoded: false,
        }
    }
}

/// Decide the effective total size to report for the next progress tick.
///
/// This is the single source of truth for the size the UI progress bar
/// shows, and it enforces the monotonicity contract that makes the
/// "unknown size (indeterminate bar) → known size (percentage)" transition
/// smooth with no backward jump:
///
/// * Content-encoded responses (gzip/br/deflate) always report 0 — this
///   branch overrides everything else, even a size the preflight already
///   seeded: libcurl decompresses the body before writing it to disk, so
///   the wire Content-Length describes the COMPRESSED size and showing it
///   as the total would let downloaded_bytes outrun size_bytes (progress
///   over 100%). Indeterminate is the honest choice for such transfers.
/// * Otherwise the total transitions 0 → known exactly once, from the
///   response headers' Content-Length / Content-Range. In practice headers
///   arrive before any body bytes are written, so the transition happens
///   while downloaded is still ~0 and the percentage simply starts climbing
///   from a low value.
/// * Outside the content-encoded case, once a size is known it is FROZEN
///   for the rest of the transfer: never replaced by a smaller value (a
///   shrink would drop the percentage) and never "corrected" to a larger
///   one either (a grow would also make downloaded / size jump backward).
///   The completion path reconciles the exact on-disk size at the end,
///   together with downloaded_bytes, so the final snapshot always lands on
///   100%.
fn next_progress_total(current: u64, discovered: Option<u64>, content_encoded: bool) -> u64 {
    if content_encoded {
        return 0;
    }
    if current > 0 {
        return current;
    }
    match discovered {
        Some(d) if d > 0 => d,
        _ => 0,
    }
}

fn run_single_libcurl(
    state: &SharedState,
    id: &str,
    plan: &DirectDownloadPlan,
    cancel: Arc<AtomicBool>,
    retry_after: Arc<AtomicU64>,
    streaming_digest_out: Arc<Mutex<Option<String>>>,
) -> Result<TransferOutcome, String> {
    let _phase_ctx = crate::logging::push_context("phase", "single");
    log::info!(
        "Task {id}: run_single_libcurl starting — url={}, total_size={}, resumable={}, output={}",
        plan.url,
        plan.total_size,
        plan.resumable,
        plan.output_path.display()
    );
    FileWriter::ensure_parent(&plan.output_path)?;
    if plan.config.bool_("skipExisting") == Some(true) && plan.output_path.exists() {
        // Only honour skipExisting when the file on disk is plausibly the
        // completed object. An empty file, or one whose size disagrees with
        // a known remote size, must be (re)downloaded instead of being
        // silently accepted as "complete".
        let existing = FileWriter::current_size(&plan.output_path)?;
        let plausible = if plan.total_size > 0 {
            existing == plan.total_size
        } else {
            existing > 0
        };
        if plausible {
            return Ok(TransferOutcome::plain(existing, None));
        }
        log::info!(
            "skipExisting ignored for {} (on-disk {} bytes, expected {}): redownloading",
            plan.output_path.display(),
            existing,
            plan.total_size
        );
    }
    if plan.output_path.exists() {
        let existing = FileWriter::current_size(&plan.output_path)?;
        // NOTE: an on-disk file whose size equals the remote size is NOT treated
        // as "already complete" here. A file can legitimately have that size
        // while still missing its real content (e.g. a leftover preallocated
        // file), and skipping it would mark a garbage file as downloaded.
        // Resuming from the end of such a file is impossible (the server would
        // answer 416), so restart it from scratch instead. Genuinely complete
        // files are still respected by the explicit `skipExisting` option above.
        if plan.total_size > 0 && existing == plan.total_size {
            if plan.allow_overwrite {
                log::info!(
                    "Task {id}: on-disk file matches the expected size but completion is unverified; restarting download from scratch: {}",
                    plan.output_path.display()
                );
                let _ = std::fs::remove_file(&plan.output_path);
            }
            // With allow_overwrite=false a full-size file is never silently
            // accepted as complete (it may be a leftover preallocated file).
            // The dispatcher already auto-renamed it away in this
            // configuration; if we reach here anyway, fall through and let the
            // resume flow fail loudly (416) instead of reporting a fake 100%.
        } else if plan.total_size > 0 && existing > plan.total_size {
            if plan.allow_overwrite {
                let _ = std::fs::remove_file(&plan.output_path);
            } else {
                return Err(format!(
                    "Destination is larger than expected and overwrite is disabled: {}",
                    plan.output_path.display()
                ));
            }
        } else if !plan.resumable && existing > 0 {
            if !plan.allow_overwrite {
                return Err(format!(
                    "Destination already exists: {}",
                    plan.output_path.display()
                ));
            }
            let _ = std::fs::remove_file(&plan.output_path);
        } else if !plan.allow_overwrite && plan.total_size == 0 && existing > 0 {
            return Err(format!(
                "Cannot safely resume existing destination without a known remote size: {}",
                plan.output_path.display()
            ));
        }
    }

    let resume_existing = if plan.resumable && plan.validator.is_some() {
        FileWriter::current_size(&plan.output_path)?
    } else {
        0
    };
    let on_disk_before = FileWriter::current_size(&plan.output_path)?;
    log::debug!(
        "[DECISION] task={id} phase=single action=resume-dispatch existing={} resume_from={} resumable={} has_validator={} allow_overwrite={} total_size={} output={}",
        on_disk_before,
        resume_existing,
        plan.resumable,
        plan.validator.is_some(),
        plan.allow_overwrite,
        plan.total_size,
        plan.output_path.display()
    );
    let capture = Arc::new(Mutex::new(ResponseCapture::default()));
    let downloaded_counter = Arc::new(AtomicU64::new(0));
    let progress = SegmentProgress {
        downloaded: downloaded_counter.clone(),
        abort: cancel.clone(),
        retry_after: retry_after.clone(),
        capture: capture.clone(),
        streaming_digest_out: streaming_digest_out.clone(),
        range_rejected: Arc::new(AtomicBool::new(false)),
        encoding_rejected: Arc::new(AtomicBool::new(false)),
        expects_206: false,
    };
    let task_limit = state.bandwidth_manager.allowed_speed_for_task(id);
    let task_limit_bps = if task_limit > 0 {
        Some(task_limit * 1024)
    } else {
        None
    };
    let easy = create_easy_for_range_ext(plan, &plan.output_path, progress, None, task_limit_bps)?;
    let mut guard = CurlMultiGuard::new();
    guard.configure_limits(global_config().connection_limits_for(1, &plan.url))?;
    let handle = guard.add2(easy)?;
    let handles = vec![handle];
    // Live rate-limit tracking (M6): remember what cap is currently applied to
    // the easy handle so the tick can push changes immediately instead of
    // waiting for a restart. `None` = unlimited, `Some(bps)` = capped.
    let mut last_applied_rate: Option<u64> = task_limit_bps;
    let bandwidth_for_tick = state.bandwidth_manager.clone();
    let task_id_for_rate = id.to_owned();
    let mut last_total = on_disk_before;
    let mut last_tick = Instant::now();
    let mut last_progress_time = Instant::now();
    let downloaded_for_tick = downloaded_counter.clone();
    let cancel_for_tick = cancel.clone();
    // The total size may be unknown (0) at dispatch time (fast-path downloads
    // whose background size probe failed). Learn it from the server's
    // Content-Length / Content-Range headers as soon as they arrive, so the
    // UI can show a real progress percentage instead of staying at 0% until
    // the whole transfer completes and then jumping to 100%.
    let mut effective_total = plan.total_size;
    // Log a failed live rate-cap push only once per distinct failure (the
    // handle may be mid-transfer; repeated per-tick logs would spam).
    let rate_failure_logged = std::cell::Cell::new(false);
    let mut tick = || {
        // Live rate-limit refresh (M6): push bandwidth changes into the
        // running easy handle on the next tick instead of at handle build.
        let new_rate = match bandwidth_for_tick.rate_limit_for(&task_id_for_rate) {
            crate::daemon::engine::bandwidth::RateLimit::Unlimited => None,
            crate::daemon::engine::bandwidth::RateLimit::Limit(kbps) => Some(kbps * 1024),
            crate::daemon::engine::bandwidth::RateLimit::Paused => {
                // Paused: handled by the drive-loop pause gate; keep the
                // current cap so resume restores it.
                last_applied_rate
            }
        };
        if new_rate != last_applied_rate {
            let raw = handles[0].raw();
            match crate::daemon::curl::easy_config::set_live_rate(raw, new_rate) {
                Ok(()) => {
                    rate_failure_logged.set(false);
                    last_applied_rate = new_rate;
                }
                Err(e) => {
                    if !rate_failure_logged.replace(true) {
                        log::warn!(
                            "Task {id}: could not apply live rate limit ({new_rate:?}): {e}"
                        );
                    }
                }
            }
        }
        let counter_bytes = downloaded_for_tick.load(Ordering::Relaxed);
        let disk_bytes = FileWriter::current_size(&plan.output_path).unwrap_or(0);
        let effective_downloaded =
            on_disk_before + counter_bytes.max(disk_bytes.saturating_sub(on_disk_before));
        let now = Instant::now();
        let elapsed = now.duration_since(last_tick).as_secs_f64().max(0.001);
        let speed = effective_downloaded.saturating_sub(last_total) as f64 / elapsed;
        let prev_last_total = last_total;
        last_total = effective_downloaded;
        last_tick = now;

        // H-2: paused time must not count toward the stall detector — a
        // global pause (or a long-running pause of this task) would otherwise
        // be misread as a 60s stall and force-cancel the transfer.
        if state
            .bandwidth_manager
            .paused_flag()
            .load(Ordering::Relaxed)
            || effective_downloaded > prev_last_total
        {
            last_progress_time = now;
        } else if now.duration_since(last_progress_time).as_secs() >= 60
            && effective_downloaded == prev_last_total
        {
            log::warn!("Task {id}: stall detected — no data received for 60s, aborting transfer");
            cancel_for_tick.store(true, Ordering::Release);
        }

        let speed_u64 = speed as u64;
        state.bandwidth_manager.report_speed(id, speed_u64);

        // A response with a real Content-Encoding (gzip/br/deflate) is
        // decompressed by libcurl before it is written to disk, so the probed
        // Content-Length describes the COMPRESSED wire size, not the file on
        // disk. Using it as the total would let downloaded_bytes outrun
        // size_bytes (a progress bar over 100%). Report an unknown size
        // (indeterminate bar) until completion records the real on-disk size.
        //
        // Otherwise learn the real size from the response headers as soon as
        // they arrive. next_progress_total enforces monotonicity so the size
        // reported to the UI can never jump backward (see its docs).
        let (content_encoded, discovered) = {
            let cap = capture.lock().ok();
            (
                cap.as_ref().is_some_and(|c| c.content_encoded),
                cap.as_ref().and_then(|c| c.content_length),
            )
        };
        let new_total = next_progress_total(effective_total, discovered, content_encoded);
        if new_total != effective_total {
            log::info!(
                "Task {id}: progress total {effective_total} -> {new_total} bytes (learned from response headers)"
            );
            effective_total = new_total;
        }

        // Blocking lock: a try_lock spin would delay progress ticks and the
        // in-loop stall detector under contention.
        let mut jobs = match state.curl_jobs.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        {
            if let Some(job) = jobs.get_mut(id) {
                job.task.downloaded_bytes = effective_downloaded;
                // Prefer the header-discovered total; if the response is still
                // being read, keep any size the async background probe already
                // stored instead of resetting the UI back to 0%.
                job.task.size_bytes = if effective_total > 0 {
                    effective_total
                } else if content_encoded {
                    // Compressed transfer: the declared size is the wire size,
                    // not the file on disk — unknown until completion.
                    0
                } else {
                    job.task.size_bytes
                };
                job.task.speed_bytes_per_sec = speed_u64;
                job.task.elapsed_seconds = job.start_time.elapsed().as_secs();
                job.task.time_left_seconds =
                    if speed > 0.0 && effective_total > effective_downloaded {
                        ((effective_total - effective_downloaded) as f64 / speed).ceil() as u64
                    } else {
                        0
                    };
                let task = job.task.clone();
                drop(jobs);
                lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
                state.mark_dirty();
            }
        }
    };
    log::info!("Task {id}: starting curl multi drive loop (on_disk_before={on_disk_before})");
    // Use libcurl's wait/perform driver for every configured event-loop mode.
    // It is the verified path for real transfers and invokes bounded progress
    // ticks while the request is active.
    drive_multi_wait_perform(
        guard.multi()?,
        &handles,
        &cancel,
        "transfer",
        &mut tick,
        state.bandwidth_manager.paused_flag(),
    )?;
    let response = handles[0]
        .response_code()
        .map_err(|e| format!("Could not read HTTP response code: {e}"))?;
    log::info!("Task {id}: curl transfer finished — HTTP response={response}");
    if response == 304 {
        // 304 Not Modified is only a valid completion when the local file
        // actually holds the (unchanged) object. If the partial file is
        // missing or empty, the conditional request was satisfied against
        // data we no longer have; retry once WITHOUT the validator so the
        // server returns the full body instead of another 304.
        let on_disk = FileWriter::current_size(&plan.output_path)?;
        if on_disk == 0 && plan.validator.is_some() {
            log::info!(
                "304 Not Modified but no local data for {}; retrying without conditional headers",
                plan.output_path.display()
            );
            let mut unconditional = plan.clone();
            unconditional.validator = None;
            unconditional.validator_is_etag = false;
            return run_single_libcurl(
                state,
                id,
                &unconditional,
                cancel,
                retry_after,
                streaming_digest_out,
            );
        }
        if on_disk == 0 {
            return Err(
                "Server replied 304 Not Modified but no local file exists to validate against"
                    .to_owned(),
            );
        }
        let (captured, encoded) = capture.lock().ok().map_or((None, false), |cap| {
            (cap.validator.clone(), cap.content_encoded)
        });
        return Ok(TransferOutcome {
            size: on_disk,
            validator: captured,
            content_encoded: encoded,
        });
    }
    if response == 412 {
        let existing = FileWriter::current_size(&plan.output_path)?;
        if existing > 0 {
            log::info!(
                "412 Precondition Failed: resource changed, discarding {} bytes of partial data for {}",
                existing,
                plan.output_path.display()
            );
            let _ = std::fs::remove_file(&plan.output_path);
        }
        return Err("resource-changed-412".to_owned());
    }
    if response == 416 {
        let existing = FileWriter::current_size(&plan.output_path)?;
        if existing > 0 {
            log::info!(
                "416 Range Not Satisfiable: discarding {} bytes of partial data for {}",
                existing,
                plan.output_path.display()
            );
            let _ = std::fs::remove_file(&plan.output_path);
        }
        return Err("range-not-satisfiable-416".to_owned());
    }
    if response == 200 && resume_existing > 0 {
        log::warn!(
            "Server returned 200 OK instead of 206 on resume ({} bytes), \
             truncating corrupted file {}",
            resume_existing,
            plan.output_path.display()
        );
        if let Ok(f) = std::fs::OpenOptions::new()
            .write(true)
            .open(&plan.output_path)
        {
            let _ = f.set_len(0);
        }
        return Err("resume-corrupted-200".to_owned());
    }
    if response >= 400 {
        return Err(format!("HTTP error {response}"));
    }
    // response == 0 means no HTTP response was received at all — the transfer
    // failed before reaching the server (DNS failure, connection refused, TLS
    // handshake error, etc.). Without this check, the download is silently
    // marked as "completed" with 0 bytes, which is exactly the bug where
    // "NOVA detects the file size but never downloads the file."
    // This guard applies only to HTTP-family URLs: FTP/SFTP/SCP transfers
    // legitimately report response_code()==0 on success.
    if response == 0 && is_http_family(&plan.url) {
        // Use the atomic counter (actual curl-written bytes) NOT file size,
        // which may be inflated by anything that resizes the file ahead of the
        // real data and would mask a zero-byte transfer as "complete".
        let curl_written = downloaded_counter.load(Ordering::Acquire);
        log::warn!(
            "Task {id}: HTTP response=0 — curl_written={curl_written}, on_disk={}, total_size={}",
            FileWriter::current_size(&plan.output_path).unwrap_or(0),
            plan.total_size
        );
        if curl_written == 0 {
            return Err(
                "Transfer failed: no HTTP response received (DNS, connection, or TLS error). \
                 The download engine could not reach the server."
                    .to_owned(),
            );
        }
        // Partial data was received but the connection dropped before a complete
        // response. Treat this as an error so retry logic can kick in.
        if plan.total_size > 0 && curl_written < plan.total_size {
            return Err(format!(
                "Transfer interrupted: received {} of {} bytes before connection lost (HTTP response code: 0)",
                curl_written, plan.total_size
            ));
        }
        // Unknown-size HTTP transfer whose connection dropped mid-body: with
        // no Content-Length there is no way to prove completeness. Fail
        // loudly so the user can retry instead of trusting a truncated file.
        if plan.total_size == 0 && curl_written > 0 {
            return Err(format!(
                "Transfer ended without an HTTP response after {curl_written} bytes; the file may be incomplete"
            ));
        }
    }
    let (captured, encoded) = capture.lock().ok().map_or((None, false), |cap| {
        (cap.validator.clone(), cap.content_encoded)
    });
    Ok(TransferOutcome {
        size: FileWriter::current_size(&plan.output_path)?,
        validator: captured,
        content_encoded: encoded,
    })
}

fn run_segmented_libcurl(
    state: &SharedState,
    id: &str,
    plan: &DirectDownloadPlan,
    cancel: Arc<AtomicBool>,
    retry_after: Arc<AtomicU64>,
    streaming_digest_out: Arc<Mutex<Option<String>>>,
    preflight: &PreflightData,
) -> Result<TransferOutcome, String> {
    let _phase_ctx = crate::logging::push_context("phase", "segmented");
    FileWriter::ensure_parent(&plan.output_path)?;
    if !plan.allow_overwrite && plan.output_path.exists() {
        let existing = FileWriter::current_size(&plan.output_path)?;
        if existing == plan.total_size
            && plan.total_size > 0
            && plan.config.bool_("skipExisting").unwrap_or(false)
        {
            return Ok(TransferOutcome::plain(existing, None));
        }
        return Err(format!(
            "Destination already exists: {}",
            plan.output_path.display()
        ));
    }
    if !plan.resumable {
        let _ = std::fs::remove_file(&plan.output_path);
        remove_stale_parts_for(&plan.output_path);
    }
    // A pre-existing output file whose size matches the remote size is NOT
    // treated as "already complete" — it may be a leftover preallocated file
    // whose real content is missing. Let the segment/merge flow rebuild it.

    let task_limit = state.bandwidth_manager.allowed_speed_for_task(id);
    let cfg = global_config();
    let effective_connections = CurlTransferConfig::bandwidth_aware_connections(
        plan.connections,
        cfg.max_connections_per_download,
        task_limit,
    );

    let ranges = split_ranges(plan.total_size, effective_connections, &plan.output_path);
    let live_connections = u32::try_from(ranges.len()).unwrap_or(u32::MAX).max(1);

    let segment_scheduler = crate::daemon::engine::dynamic_segments::DynamicSegmentScheduler::new(
        plan.total_size,
        effective_connections,
        cfg.max_connections_per_download,
    );

    let telemetry_bus = Arc::new(crate::daemon::engine::adaptive::TelemetryBus::new());
    let adaptive_engine = {
        let host = reqwest::Url::parse(&plan.url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| "unknown".into());
        let protocol = match preflight.protocol.as_str() {
            "h2" | "h2c" => {
                crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Http2
            }
            "h3" => crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Http3,
            "HTTP/1.1" => crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Http11,
            "HTTP/1.0" => crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Http11,
            _ => crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Unknown,
        };
        let rie_connections = plan
            .config
            .rie_connections
            .unwrap_or(effective_connections)
            .clamp(1, cfg.max_connections_per_download.max(1));
        let mut engine = crate::daemon::engine::adaptive::AdaptiveEngine::new(
            host,
            plan.total_size,
            rie_connections,
            protocol,
            cfg.min_segment_bytes,
        );
        // Honor the adaptiveEvalMs option. This was previously parsed into the
        // config but never applied, so tests that set a fast evaluation
        // interval were silently ignored (the engine kept its 2s default).
        if let Some(eval_ms) = plan.config.adaptive_eval_ms {
            let interval = std::time::Duration::from_millis(eval_ms.clamp(100, 60_000));
            engine.set_tick_interval(interval);
            engine.segment_ctrl.set_eval_interval(interval);
        }
        // C-1 (root cause): seed the engine's segment geometry with the
        // EXACT ranges the transfer planner created for the part files on
        // disk. The engine constructor seeds a single whole-file segment;
        // if we left it that way, per-segment progress updates for ids > 0
        // would be silently dropped (no such segment exists in the engine)
        // and the first adaptive rebuild would produce a geometry that does
        // not correspond to part000..part0NN on disk — the corruption the
        // audit flagged. Seeding from the plan keeps engine ids/ranges
        // ≡ part files on disk from the very first tick.
        {
            let plan_ranges: Vec<(u32, u64, u64)> = ranges
                .iter()
                .map(|r| (r.index as u32, r.start, r.end))
                .collect();
            engine
                .segment_ctrl
                .seed_from_ranges(plan.total_size, &plan_ranges);
        }
        if preflight.initial_rtt_us > 0 || preflight.ttfb_us > 0 {
            engine.seed_profile(
                protocol,
                preflight.supports_range,
                plan.resumable,
                None,
                if preflight.uses_tls {
                    Some("TLS".into())
                } else {
                    None
                },
                None,
                preflight.initial_rtt_us,
                preflight.tls_handshake_us,
                preflight.ttfb_us,
            );
        }
        if let Some(ref strat) = plan.config.rie_strategy {
            log::info!(
                "Task {id}: RIE strategy={strat} rie_conns={rie_connections} effective_conns={effective_connections}"
            );
        }
        engine
    };

    {
        let mut trackers = match state.engine_trackers.write() {
            Ok(g) => g,
            Err(e) => {
                log::error!("engine_trackers lock poisoned: {e}");
                return Err("engine_trackers lock poisoned".into());
            }
        };
        trackers.insert(
            id.to_owned(),
            crate::daemon::state::TaskEngineTracker {
                adaptive:
                    crate::daemon::engine::adaptive_connections::AdaptiveConnectionManager::new(
                        live_connections,
                        Default::default(),
                    ),
                segments: Some(segment_scheduler.clone()),
                retry_state: crate::daemon::engine::retry::RetryState::new(),
                adaptive_engine: Mutex::new(Some(adaptive_engine)),
            },
        );
    }

    // Phase 5/1.2: record the preflight into the unified profile store so the
    // adaptive DecisionContext has real stability/throughput data.
    {
        if let Ok(mut die) = state.die_orchestrator.lock() {
            let host = reqwest::Url::parse(&plan.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_else(|| "unknown".into());
            let profile = crate::daemon::engine::adaptive::server_profiler::ServerProfile {
                host: host.clone(),
                protocol: match preflight.protocol.as_str() {
                    "h2" | "h2c" => {
                        crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Http2
                    }
                    "h3" => {
                        crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Http3
                    }
                    _ => crate::daemon::engine::adaptive::server_profiler::ProtocolVersion::Http11,
                },
                initial_rtt_us: preflight.initial_rtt_us,
                handshake_time_us: preflight.tls_handshake_us,
                initial_ttfb_us: preflight.ttfb_us,
                ..Default::default()
            };
            die.record_preflight(&host, &profile);
        }
    }

    let mut active: Vec<(ByteRange, Arc<AtomicU64>, u64)> = Vec::new();
    let mut guard = CurlMultiGuard::new();
    guard.configure_limits(
        global_config().connection_limits_for(effective_connections, &plan.url),
    )?;
    guard
        .multi()?
        .pipelining(false, true)
        .map_err(|e| format!("Could not enable libcurl multiplexing: {e}"))?;

    let mut handles = Vec::new();
    let mut seg_captures: Vec<Arc<Mutex<ResponseCapture>>> = Vec::new();
    // C-2: shared flag — when any segment's header callback sees a 200 in
    // answer to a partial-range request, every segment stops writing.
    let range_rejected = Arc::new(AtomicBool::new(false));
    // C-5: shared flag — when any segment's header callback sees a real
    // Content-Encoding (gzip/br/deflate) on a byte-range response, every
    // segment stops writing so the corrupted (offset-shifted) parts are never
    // merged; the attempt then falls back to a single connection.
    let encoding_rejected = Arc::new(AtomicBool::new(false));
    let per_segment_limit_bps = if task_limit > 0 {
        Some((task_limit * 1024) / u64::from(effective_connections.max(1)))
    } else {
        None
    };
    // Real bytes written per segment in the previous run (persisted with the
    // task snapshot). Used to confirm that a full-size on-disk part is
    // genuinely complete rather than a leftover preallocated part.
    let persisted_segment_bytes: Vec<u64> = state
        .curl_jobs
        .lock()
        .ok()
        .map(|jobs| {
            jobs.get(id)
                .map(|job| {
                    job.task
                        .segments
                        .iter()
                        .map(|s| s.downloaded_bytes)
                        .collect()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default();
    for range in ranges.iter().cloned() {
        let _segment_ctx = crate::logging::push_context("segment", &range.index.to_string());
        let expected = part_size(&range);
        let actual = FileWriter::current_size(&range.path)?;
        log::debug!(
            "[SEGMENT] task={id} index={} expected={} on_disk={} start={} end={} path={}",
            range.index,
            expected,
            actual,
            range.start,
            range.end,
            range.path.display()
        );
        let mut existing = if actual > expected {
            let _ = std::fs::remove_file(&range.path);
            0
        } else {
            actual
        };
        if existing >= expected {
            // A full-size part is only trusted when the persisted per-segment
            // progress confirms it was fully downloaded. Otherwise it may be a
            // leftover preallocated part whose real content is missing, so
            // restart that segment instead of merging garbage.
            let confirmed = persisted_segment_bytes
                .get(range.index)
                .copied()
                .unwrap_or(0)
                >= expected;
            if confirmed {
                log::debug!(
                    "[DECISION] task={id} segment={} action=resume-complete expected={} on_disk={} persisted={} confirmed=true",
                    range.index,
                    expected,
                    actual,
                    persisted_segment_bytes
                        .get(range.index)
                        .copied()
                        .unwrap_or(0)
                );
                active.push((range, Arc::new(AtomicU64::new(0)), expected));
                continue;
            }
            log::info!(
                "[DECISION] task={id} segment={} action=restart-fullsize-unverified expected={} on_disk={} persisted={} confirmed=false",
                range.index,
                expected,
                actual,
                persisted_segment_bytes
                    .get(range.index)
                    .copied()
                    .unwrap_or(0)
            );
            let _ = std::fs::remove_file(&range.path);
            existing = 0;
        } else {
            log::debug!(
                "[DECISION] task={id} segment={} action=resume-partial existing={} expected={}",
                range.index,
                existing,
                expected
            );
        }
        let start = range.start + existing;
        let progress = Arc::new(AtomicU64::new(0));
        let seg_capture = Arc::new(Mutex::new(ResponseCapture::default()));
        seg_captures.push(seg_capture.clone());
        let easy = create_easy_for_range_ext(
            plan,
            &range.path,
            SegmentProgress {
                downloaded: progress.clone(),
                abort: cancel.clone(),
                retry_after: retry_after.clone(),
                capture: seg_capture,
                streaming_digest_out: streaming_digest_out.clone(),
                range_rejected: range_rejected.clone(),
                encoding_rejected: encoding_rejected.clone(),
                expects_206: start > 0 || ranges.len() > 1,
            },
            Some((start, range.end)),
            per_segment_limit_bps,
        )?;
        let handle = guard
            .add2(easy)
            .map_err(|e| format!("Could not add segment {}: {e}", range.index))?;
        handles.push(handle);
        active.push((range, progress, existing));
    }

    if handles.is_empty() {
        return merge_parts(&plan.output_path, &ranges).map(|s| TransferOutcome::plain(s, None));
    }

    // Shared state between the tick closure and the rebuild loop (phase 5).
    // RefCell/Cell let the closure borrow immutably while the outer loop
    // mutates through the cell after a drive pass finishes.
    let handles_cell: std::cell::RefCell<
        Vec<Easy2Handle<crate::daemon::curl::easy_config::SegmentWriter>>,
    > = std::cell::RefCell::new(handles);
    let active_cell: std::cell::RefCell<Vec<(ByteRange, Arc<AtomicU64>, u64)>> =
        std::cell::RefCell::new(active);
    let last_total_cell: std::cell::Cell<u64> = std::cell::Cell::new(
        active_cell
            .borrow()
            .iter()
            .map(|(r, p, initial)| (*initial + p.load(Ordering::Relaxed)).min(part_size(r)))
            .sum(),
    );
    let last_tick_cell: std::cell::Cell<Instant> = std::cell::Cell::new(Instant::now());
    // H-3: dedicated cells for update_curl_task_progress's internal speed/ETA
    // bookkeeping. The tick closure resets last_tick_cell on every call, so
    // update_curl_task_progress must keep its OWN last_total/last_tick state
    // here (read into locals, pass by &mut, write back).
    let progress_total_cell: std::cell::Cell<u64> = std::cell::Cell::new(
        active_cell
            .borrow()
            .iter()
            .map(|(r, p, initial)| (*initial + p.load(Ordering::Relaxed)).min(part_size(r)))
            .sum(),
    );
    let progress_tick_cell: std::cell::Cell<Instant> = std::cell::Cell::new(Instant::now());
    let prev_seg_bytes_cell: std::cell::RefCell<Vec<u64>> =
        std::cell::RefCell::new(vec![0; active_cell.borrow().len()]);
    // Live rate-limit tracking for the segmented path (M6).
    let bandwidth_for_segments = state.bandwidth_manager.clone();
    let segment_task_id = id.to_owned();
    let mut last_segment_rate: Option<u64> = per_segment_limit_bps.map(|v| v.max(1));
    // Phase 5: set by the tick when the adaptive engine requests a geometry
    // change; the outer loop rebuilds handles and resumes driving. Debounced
    // to at most one rebuild per 10s to prevent oscillation.
    let pending_rebuild = std::cell::Cell::new(false);
    let last_rebuild_at = std::cell::Cell::new(std::time::Instant::now());
    // H-1: last time per-tick telemetry was persisted to the profile store.
    let last_telemetry_cell = std::cell::Cell::new(std::time::Instant::now());
    // Log a failed live rate-cap push only once (see single-path tick).
    let seg_rate_failure_logged = std::cell::Cell::new(false);
    let mut tick = || {
        // Live rate refresh: apply the current per-segment cap to every live
        // handle so limit changes take effect immediately (M6).
        let new_seg_rate = match bandwidth_for_segments.rate_limit_for(&segment_task_id) {
            crate::daemon::engine::bandwidth::RateLimit::Unlimited => None,
            crate::daemon::engine::bandwidth::RateLimit::Limit(kbps) => {
                Some((kbps * 1024) / u64::from(effective_connections.max(1)).max(1))
            }
            crate::daemon::engine::bandwidth::RateLimit::Paused => last_segment_rate,
        };
        if new_seg_rate != last_segment_rate {
            let mut all_ok = true;
            for handle in handles_cell.borrow().iter() {
                let raw = handle.raw();
                if crate::daemon::curl::easy_config::set_live_rate(raw, new_seg_rate).is_err() {
                    all_ok = false;
                }
            }
            if all_ok {
                seg_rate_failure_logged.set(false);
                last_segment_rate = new_seg_rate;
            } else if !seg_rate_failure_logged.replace(true) {
                log::warn!(
                    "Task {id}: could not apply live per-segment rate limit ({new_seg_rate:?})"
                );
            }
        }
        let now = Instant::now();
        let last_tick = last_tick_cell.get();
        let elapsed = now.duration_since(last_tick).as_secs_f64().max(0.001);
        last_tick_cell.set(now);
        let active = active_cell.borrow();
        let mut prev_seg_bytes = prev_seg_bytes_cell.borrow_mut();
        let mut seg_downloads = Vec::with_capacity(active.len());
        let mut seg_speeds = Vec::with_capacity(active.len());
        // C-1: collect the REAL segment id per active entry. The engine's
        // segment ids are not the array positions: after an adaptive split the
        // new segment gets id = max+1 (non-contiguous), so passing the array
        // index to update_progress would update the wrong segment or none.
        // Also report TOTAL bytes (on-disk resume offset + bytes written this
        // run), not just this run's bytes, so the engine's `downloaded` counter
        // matches what is actually on disk — otherwise a resumed segment would
        // undercount and the next rebuild would resume from the wrong offset.
        let mut seg_ids: Vec<u32> = Vec::with_capacity(active.len());
        for (i, (range, progress, initial)) in active.iter().enumerate() {
            let seg_new = progress.load(Ordering::Relaxed);
            let seg_downloaded = (*initial + seg_new).min(part_size(range));
            let seg_speed = if seg_new > prev_seg_bytes[i] {
                ((seg_new - prev_seg_bytes[i]) as f64 / elapsed) as u64
            } else {
                0
            };
            prev_seg_bytes[i] = seg_new;
            let seg_id = range.index as u32;
            segment_scheduler.update_segment(seg_id, seg_downloaded, seg_speed, true);
            telemetry_bus.report_bytes(i, seg_downloaded);
            telemetry_bus.report_speed(i, seg_speed);
            telemetry_bus.set_alive(i, true);
            seg_ids.push(seg_id);
            seg_downloads.push(seg_downloaded);
            seg_speeds.push(seg_speed);
        }
        drop(active);
        drop(prev_seg_bytes);
        if let Ok(trackers) = state.engine_trackers.read() {
            if let Some(tracker) = trackers.get(id) {
                if let Ok(mut engine_guard) = tracker.adaptive_engine.lock() {
                    if let Some(ref mut engine) = engine_guard.as_mut() {
                        for (i, (&downloaded, &speed)) in
                            seg_downloads.iter().zip(seg_speeds.iter()).enumerate()
                        {
                            engine
                                .segment_ctrl
                                .update_progress(seg_ids[i], downloaded, speed);
                        }
                        // Phase 5: drive the adaptive engine LIVE. When the
                        // decision asks for a geometry change we set
                        // pending_rebuild; the outer drive loop then rebuilds
                        // the easy handles from the new segment plan and
                        // resumes driving.
                        if plan.config.adaptive {
                            let decision = engine.evaluate(&telemetry_bus);
                            let mut geometry_changed = false;
                            for action in &decision.actions {
                                match action {
                                    crate::daemon::engine::adaptive::AdaptationAction::AdjustConnections { new_count, .. } => {
                                        let target = (*new_count)
                                            .clamp(1, cfg.max_connections_per_download);
                                        let current = u32::try_from(
                                            handles_cell.borrow().len(),
                                        )
                                        .unwrap_or(1)
                                        .max(1);
                                        if target != current {
                                            engine
                                                .segment_ctrl
                                                .redistribute_for_count(target);
                                            geometry_changed = true;
                                        }
                                    }
                                    crate::daemon::engine::adaptive::AdaptationAction::SplitSegment { .. }
                                    | crate::daemon::engine::adaptive::AdaptationAction::MergeSegments { .. }
                                    | crate::daemon::engine::adaptive::AdaptationAction::Redistribute { .. } => {
                                        geometry_changed = true;
                                    }
                                    _ => {}
                                }
                            }
                            if geometry_changed {
                                log::info!(
                                    "Task {id}: adaptive decision — {} ({} segments → {})",
                                    decision.reason,
                                    handles_cell.borrow().len(),
                                    engine.segment_ctrl.segment_count()
                                );
                                // Mirror the new geometry to the UI scheduler.
                                let new_geometry: Vec<(u32, u64, u64, u64, u64, bool)> = engine
                                    .segment_ctrl
                                    .segments()
                                    .iter()
                                    .map(|s| {
                                        (
                                            s.id,
                                            s.start_byte,
                                            s.end_byte,
                                            s.downloaded,
                                            s.speed,
                                            s.state
                                                == crate::daemon::engine::adaptive::segment_controller::SegmentState::Active,
                                        )
                                    })
                                    .collect();
                                segment_scheduler.replace_segments(&new_geometry);
                                let rebuild_debounce = plan
                                    .config
                                    .adaptive_rebuild_ms
                                    .map(|ms| {
                                        std::time::Duration::from_millis(ms.clamp(100, 600_000))
                                    })
                                    .unwrap_or(std::time::Duration::from_secs(10));
                                if last_rebuild_at.get().elapsed() >= rebuild_debounce {
                                    pending_rebuild.set(true);
                                    last_rebuild_at.set(std::time::Instant::now());
                                }
                            }
                        }
                    }
                }
            }
        }
        // Phase 5/1.2: persist per-tick telemetry into the unified profile
        // store so the adaptive engine's DecisionContext stays warm across
        // sessions. H-1: throttled to once per 5s — this used to run on every
        // tick (every ~50ms), locking the store and fsyncing the profile file
        // dozens of times per second per task.
        if last_telemetry_cell.get().elapsed() >= std::time::Duration::from_secs(5) {
            if let Ok(mut die) = state.die_orchestrator.lock() {
                let host = reqwest::Url::parse(&plan.url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .unwrap_or_else(|| "unknown".into());
                let agg: u64 = seg_speeds.iter().sum();
                die.record_telemetry(&host, 0, agg, 206);
            }
            last_telemetry_cell.set(Instant::now());
        }
        // H-3: update_curl_task_progress mutates its speed/ETA bookkeeping;
        // read the dedicated cells into locals and write them back (the old
        // `&mut cell.get()` passed a reference to a discarded temporary).
        let mut progress_total = progress_total_cell.get();
        let mut progress_tick = progress_tick_cell.get();
        update_curl_task_progress(
            state,
            id,
            plan.total_size,
            &active_cell.borrow(),
            &mut progress_total,
            &mut progress_tick,
        );
        progress_total_cell.set(progress_total);
        progress_tick_cell.set(progress_tick);
    };
    // Phase 5 outer drive loop: drive until completion, rebuilding the easy
    // handles whenever the adaptive engine changes the segment geometry.
    'drive: loop {
        let rebuild_requested = drive_multi_wait_perform_until(
            guard.multi()?,
            &handles_cell.borrow(),
            &cancel,
            "segment",
            &mut tick,
            state.bandwidth_manager.paused_flag(),
            || pending_rebuild.get(),
        )?;
        // The driver returns immediately after a tick requests a geometry
        // change, so rebuild while the old handle layout is still live.
        if !rebuild_requested {
            break 'drive;
        }
        pending_rebuild.set(false);
        log::info!("Task {id}: rebuilding segment handles after adaptive decision");
        // Rebuild: remove all current handles from the multi handle, then
        // recreate from the new geometry in segment_ctrl.
        {
            let mut handles = handles_cell.borrow_mut();
            let removed: Vec<_> = handles.drain(..).collect();
            for h in removed {
                let _ = guard.remove(h);
            }
        }
        let mut active = active_cell.borrow_mut();
        active.clear();
        let new_geometry: Vec<(u32, u64, u64, u64)> = engine_segments_for_rebuild(state, id);
        let new_geometry_len = new_geometry.len();
        // `_downloaded`: the engine's counter is deliberately NOT used as a
        // resume base (see C-1 comment below); the on-disk length is truth.
        for &(seg_id, start, end_excl, _downloaded) in &new_geometry {
            // C-1 (naming): the part path MUST use the same convention as
            // SegmentPlanner::plan (`<file>.partNNN`, not
            // `with_extension("partNNN")` which replaces the destination's
            // own extension). With with_extension, the rebuild wrote to
            // `rebuild.part000` while the planner had created
            // `rebuild.zip.part000` — the resume state was silently lost,
            // stale parts were orphaned, and the final merge read files that
            // never matched the initial geometry.
            let path = crate::daemon::direct::part_file_path(&plan.output_path, seg_id);
            // The engine reports segment ends EXCLUSIVE (one past the last
            // byte), while ByteRange and the HTTP Range header are INCLUSIVE.
            // Passing the exclusive end straight through would make every
            // rebuilt segment request one byte too far and report sizes one
            // byte too large — the final merge would then be off by the number
            // of segments. Convert once here.
            let end = end_excl.saturating_sub(1);
            let range = ByteRange {
                index: seg_id as usize,
                start,
                end,
                path: path.clone(),
            };
            // C-1: the on-disk part file length is the ONLY trustworthy resume
            // point. The engine's `downloaded` counter is a hint, NOT ground
            // truth: after a merge the survivor's counter sums both halves
            // while the second half's bytes still live in an orphaned part
            // file; after a split the counter can exceed the new, narrower
            // bounds. Crucially, the segment writer APPENDS at the file's
            // current end (seek-to-end resume), so the HTTP range requested
            // must start exactly at the on-disk length — otherwise new bytes
            // land at the wrong offset and the merge is silently corrupt.
            // `trusted = on_disk.min(seg_size)` is therefore the only safe
            // resume offset; the engine counter is never used here.
            let seg_size = end_excl.saturating_sub(start);
            if seg_size == 0 {
                // Defensive: a degenerate zero-length segment (end_excl <= start)
                // contributes nothing and must not produce a phantom 1-byte
                // ByteRange (end = 0.saturating_sub(1) == 0 has len 1) that
                // would corrupt the merge. The engine should never emit one,
                // but skip it rather than trust the invariant.
                log::debug!(
                    "Task {id}: rebuild — skipping degenerate empty segment {seg_id} (start={start}, end_excl={end_excl})"
                );
                continue;
            }
            let on_disk = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let mut trusted = on_disk.min(seg_size);
            if on_disk > seg_size {
                // Stale bytes from a previous, wider geometry: truncate so the
                // final merge reads exactly the planned range.
                log::warn!(
                    "Task {id}: rebuild — truncating stale part {seg_id} from {on_disk} to {seg_size} bytes"
                );
                let _ = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .and_then(|f| f.set_len(seg_size));
                trusted = seg_size;
            }
            let progress = Arc::new(AtomicU64::new(0));
            if trusted >= seg_size {
                // Segment already fully present on disk under the new geometry:
                // no handle needed, but it must still be counted toward the
                // final merge and the live totals.
                log::debug!(
                    "Task {id}: rebuild — segment {seg_id} already complete on disk ({trusted}/{seg_size})"
                );
                active.push((range, progress, trusted));
                continue;
            }
            let seg_capture = Arc::new(Mutex::new(ResponseCapture::default()));
            seg_captures.push(seg_capture.clone());
            let easy = create_easy_for_range_ext(
                plan,
                &path,
                SegmentProgress {
                    downloaded: progress.clone(),
                    abort: cancel.clone(),
                    retry_after: retry_after.clone(),
                    capture: seg_capture,
                    streaming_digest_out: streaming_digest_out.clone(),
                    range_rejected: range_rejected.clone(),
                    encoding_rejected: encoding_rejected.clone(),
                    expects_206: start + trusted > 0 || new_geometry_len > 1,
                },
                Some((start + trusted, end)),
                per_segment_limit_bps,
            )?;
            let handle = guard
                .add2(easy)
                .map_err(|e| format!("Could not add segment {seg_id}: {e}"))?;
            handles_cell.borrow_mut().push(handle);
            active.push((range, progress, trusted));
        }
        // Recompute totals for the new geometry.
        last_total_cell.set(
            active
                .iter()
                .map(|(r, p, initial)| (*initial + p.load(Ordering::Relaxed)).min(part_size(r)))
                .sum(),
        );
        last_tick_cell.set(Instant::now());
        *prev_seg_bytes_cell.borrow_mut() = vec![0; active.len()];
        drop(active);
        if let Ok(trackers) = state.engine_trackers.read() {
            if let Some(tracker) = trackers.get(id) {
                let live_count = u32::try_from(handles_cell.borrow().len()).unwrap_or(u32::MAX);
                tracker.adaptive.set_connections(live_count);
            }
        }
        if handles_cell.borrow().is_empty() {
            break 'drive;
        }
    }
    // C-2: the server answered 200 (not 206) to a partial-range request on at
    // least one segment, so every segment stopped writing via the shared
    // range_rejected flag. Fail fast with a clear error instead of merging
    // truncated or overlapping part files.
    if range_rejected.load(Ordering::Acquire) {
        for r in active_cell.borrow().iter() {
            let _ = std::fs::remove_file(&r.0.path);
        }
        return Err(
            "Server returned 200 OK instead of 206 Partial Content to a byte-range request; \
             the server does not honor range requests. Retry with a single connection or \
             disable segmented mode."
                .to_owned(),
        );
    }
    // C-5: at least one segment received a byte-range response with a real
    // Content-Encoding, so every segment stopped writing via the shared
    // encoding_rejected flag. Each segment would have decompressed an
    // independent compressed stream, breaking the byte offsets the merge
    // relies on — fail fast and let the retry loop fall back to a single
    // connection (which handles Content-Encoding correctly).
    if encoding_rejected.load(Ordering::Acquire) {
        for r in active_cell.borrow().iter() {
            let _ = std::fs::remove_file(&r.0.path);
        }
        return Err(
            "Server applied Content-Encoding to byte-range responses; segmented download \
             would corrupt the output. Retrying with a single connection."
                .to_owned(),
        );
    }
    for (idx, handle) in handles_cell.borrow().iter().enumerate() {
        let code = handle
            .response_code()
            .map_err(|e| format!("Segment {idx}: could not read HTTP response code: {e}"))?;
        if code == 304 {
            continue;
        }
        if code == 412 {
            for r in active_cell.borrow().iter() {
                let _ = std::fs::remove_file(&r.0.path);
            }
            return Err("resource-changed-412".to_owned());
        }
        if code == 416 {
            for r in active_cell.borrow().iter() {
                let _ = std::fs::remove_file(&r.0.path);
            }
            return Err("range-not-satisfiable-416".to_owned());
        }
        if is_http_family(&plan.url) && code != 206 && code != 200 {
            return Err(format!(
                "Segment {idx} finished with unexpected HTTP status {code}"
            ));
        }
        if code == 200 && active_cell.borrow().len() > 1 && is_http_family(&plan.url) {
            for r in active_cell.borrow().iter() {
                let _ = std::fs::remove_file(&r.0.path);
            }
            return Err("Server did not honor byte-range requests; retry with one connection or probe the URL again.".to_owned());
        }
    }
    // H-3: update_curl_task_progress mutates last_total/last_tick to compute
    // speed and ETA. Read the cells into locals and write them back — the old
    // `&mut cell.get()` passed a mutable reference to a discarded temporary,
    // so speed was recomputed against the initial baseline every tick.
    let mut last_total = progress_total_cell.get();
    let mut last_tick = progress_tick_cell.get();
    update_curl_task_progress(
        state,
        id,
        plan.total_size,
        &active_cell.borrow(),
        &mut last_total,
        &mut last_tick,
    );
    progress_total_cell.set(last_total);
    progress_tick_cell.set(last_tick);
    let (captured_validator, encoded) = seg_captures
        .first()
        .and_then(|cap| cap.lock().ok())
        .map_or((None, false), |cap| {
            (cap.validator.clone(), cap.content_encoded)
        });
    // C-1: merge using the CURRENT segment geometry. The original `ranges`
    // were captured before any adaptive rebuild split/merged segments, so
    // they may reference stale part files and byte offsets, causing a failed
    // merge or a silently corrupted output file. Read the live geometry from
    // active_cell instead.
    let mut final_ranges: Vec<ByteRange> = active_cell
        .borrow()
        .iter()
        .map(|(range, _, _)| range.clone())
        .collect();
    // C-1 (ordering): the adaptive engine stores segments in creation order
    // (split appends new ids at the end), NOT sorted by start byte. The merge
    // concatenates part files in the order of this slice, so an unsorted
    // geometry would produce a byte-swapped output file even though every
    // part is complete and correct. Sort by start offset — the merge is only
    // valid when parts are concatenated in ascending byte order.
    final_ranges.sort_by_key(|r| r.start);
    merge_parts(&plan.output_path, &final_ranges).map(|s| TransferOutcome {
        size: s,
        validator: captured_validator,
        content_encoded: encoded,
    })
}

/// Phase 5: read the adaptive engine's current segment geometry
/// (id, start, end, downloaded) for a task. Empty when the engine is gone.
fn engine_segments_for_rebuild(state: &SharedState, id: &str) -> Vec<(u32, u64, u64, u64)> {
    let Ok(trackers) = state.engine_trackers.read() else {
        return Vec::new();
    };
    let Some(tracker) = trackers.get(id) else {
        return Vec::new();
    };
    let Ok(engine_guard) = tracker.adaptive_engine.lock() else {
        return Vec::new();
    };
    let Some(engine) = engine_guard.as_ref() else {
        return Vec::new();
    };
    engine
        .segment_ctrl
        .segments()
        .iter()
        .map(|s| (s.id, s.start_byte, s.end_byte, s.downloaded))
        .collect()
}

/// H-4: RAII lease that registers this download's connection usage with the
/// DieOrchestrator when created and releases it when dropped, so every exit
/// path (success, error, cancel, panic unwind) releases the budget exactly
/// once. Registered once per generation in run_libcurl_download.
struct DownloadConnectionLease {
    state: SharedState,
    host: String,
    count: u32,
}

impl Drop for DownloadConnectionLease {
    fn drop(&mut self) {
        if let Ok(mut die) = self.state.die_orchestrator.lock() {
            die.release_connections(&self.host, self.count);
        }
    }
}

fn run_libcurl_download(
    state: &SharedState,
    id: &str,
    mut plan: DirectDownloadPlan,
    cancel: Arc<AtomicBool>,
) -> Result<u64, String> {
    // Safety cap: no single download should retry for more than 24 hours,
    // regardless of how the retry policy is configured or dynamically adapted.
    const MAX_RETRY_WALL_TIME: std::time::Duration = std::time::Duration::from_secs(86400);
    let _dispatch_ctx = crate::logging::push_context("phase", "dispatch");
    log::info!(
        "Task {id}: run_libcurl_download entered — url={}, total_size={}, segmented={}, output={}",
        plan.url,
        plan.total_size,
        plan.segmented,
        plan.output_path.display()
    );
    // Structured plan snapshot: a full reproduction record of how this transfer
    // was configured, so any later failure can be replayed from logs alone.
    log::debug!(
        "[PLAN] task={id} url={} total_size={} resumable={} segmented={} connections={} allow_overwrite={} skip_existing={:?} remove_on_error={} follow_redirects={} retry_attempts={} retry_max_delay_ms={:?} preflight_resolved={} mirrors={} output={}",
        plan.url,
        plan.total_size,
        plan.resumable,
        plan.segmented,
        plan.connections,
        plan.allow_overwrite,
        plan.config.bool_("skipExisting"),
        plan.remove_on_error,
        plan.follow_redirects,
        plan.config.retry_policy().attempts,
        plan.config.retry_policy().max_delay.as_millis(),
        plan.preflight_resolved,
        plan.link_mirrors.len(),
        plan.output_path.display()
    );
    // Register every candidate before the first attempt. Link analysis can
    // populate `link_mirrors` without visiting the explicit mirror-management
    // route, so lazy creation inside the failure branch used to leave that
    // first failure with no manager to switch through. This is deliberately
    // internal: the engine selects and retries sources without adding UI noise.
    if !plan.link_mirrors.is_empty() {
        if let Ok(mut managers) = state.mirror_managers.lock() {
            let manager = managers
                .entry(id.to_owned())
                .or_insert_with(|| crate::daemon::engine::mirror::MirrorManager::new(&plan.url));
            for (index, mirror_url) in plan.link_mirrors.iter().enumerate() {
                if mirror_url == &plan.url {
                    continue;
                }
                manager.add_mirror(crate::daemon::engine::mirror::MirrorSource {
                    url: mirror_url.clone(),
                    priority: plan.mirror_priorities.get(index).copied().unwrap_or(1),
                    region: None,
                    bandwidth_estimate: None,
                    last_checked: None,
                    healthy: true,
                });
            }
        }
    }

    // C-4: when the user did not explicitly configure retry options for this
    // task, inherit the daemon-wide default retry policy instead of silently
    // disabling retries (per-task config defaults to attempts=1 = no retries).
    let retry_policy = if plan.config.retry_count.is_some()
        || plan.config.retry_delay_sec.is_some()
        || plan.config.retry_max_time_sec.is_some()
        || plan.config.retry_all_errors.is_some()
        || plan.config.retry_max_delay_sec.is_some()
        || plan.config.retry_jitter.is_some()
        || plan.config.backoff_multiplier.is_some()
        || plan.config.retry_conn_refused
    {
        plan.config.retry_policy()
    } else {
        match state.default_retry_policy.read() {
            Ok(default) => {
                let d = default.clone();
                RetryPolicy {
                    attempts: u64::from(d.max_retries).saturating_add(1).min(50),
                    delay: d.base_delay,
                    max_total_time: None,
                    retry_all_errors: false,
                    backoff_multiplier: d.backoff_multiplier,
                    max_delay: d.max_delay,
                    jitter: d.jitter,
                }
            }
            Err(_) => plan.config.retry_policy(),
        }
    };
    let start_time = std::time::Instant::now();
    let mut last_error = String::new();
    let retry_after = Arc::new(AtomicU64::new(0));
    let streaming_digest_out = Arc::new(Mutex::new(None::<String>));
    // H-4: account for this download's connection usage in the orchestrator
    // so concurrent downloads respect the global connection budget. Released
    // automatically on every exit path via the RAII lease.
    let lease_host = crate::daemon::direct::host_key(&plan.url).unwrap_or_else(|| "unknown".into());
    let lease_count = plan.connections.max(1);
    if let Ok(mut die) = state.die_orchestrator.lock() {
        die.register_connection(&lease_host, lease_count);
    }
    let _connection_lease = DownloadConnectionLease {
        state: state.clone(),
        host: lease_host,
        count: lease_count,
    };
    if plan.segmented && crate::daemon::direct::learned_host_ceiling(&plan.url) == Some(1) {
        plan.segmented = false;
    }
    #[allow(unused_assignments)]
    let mut supports_range = true;
    #[allow(unused_assignments)]
    let mut preflight = PreflightData::default();
    {
        if let Ok(mut jobs) = state.curl_jobs.lock() {
            if let Some(job) = jobs.get_mut(id) {
                job.task.engine_status = Some("resolving-url".to_owned());
            }
        }
        state.mark_dirty();

        let resolved = resolve_effective_target(&plan);
        let effective_url = resolved.0;
        supports_range = resolved.1;
        preflight = resolved.2;

        if let Ok(mut jobs) = state.curl_jobs.lock() {
            if let Some(job) = jobs.get_mut(id) {
                job.task.engine_status = Some("running-libcurl-multi".to_owned());
            }
        }
        state.mark_dirty();

        if effective_url != plan.url {
            log::info!(
                "Task {}: resolved effective URL {} -> {}",
                id,
                plan.url,
                effective_url
            );
            plan.url = effective_url;
        }
        // The preflight discovered a real total size for a download that
        // started with an unknown size (fast path). Apply it to the plan and
        // the task snapshot before dispatch so the UI shows a live progress
        // percentage from byte one — not a fake 0% that jumps to 100% at
        // completion.
        if plan.total_size == 0 && preflight.total_size > 0 {
            log::info!(
                "Task {id}: preflight learned total size {} bytes for unknown-size download",
                preflight.total_size
            );
            plan.total_size = preflight.total_size;
            // Lock order: curl_jobs → task_snapshot (documented order).
            if let Ok(mut jobs) = state.curl_jobs.lock() {
                if let Some(job) = jobs.get_mut(id) {
                    if job.task.size_bytes == 0 {
                        job.task.size_bytes = preflight.total_size;
                    }
                }
            }
            if let Ok(mut tasks) = state.task_snapshot.lock() {
                if let Some(task) = tasks.get_mut(id) {
                    if task.size_bytes == 0 {
                        task.size_bytes = preflight.total_size;
                    }
                }
            }
            state.priority_queue.update_size(id, preflight.total_size);
            state.mark_dirty();
        }
        if plan.segmented && !supports_range {
            log::info!("Task {id}: server does not honour byte ranges; using a single connection");
            plan.segmented = false;
        }
        // A size learned from the preflight may now qualify the download for
        // segmented multi-connection transfer (plan_from_job saw size 0 and
        // fell back to a single connection). Re-evaluate with the same gates:
        // segmented opt-in, not force-single, resumable, >1 connection, size
        // above the minimum, and the server honouring byte ranges.
        if !plan.segmented
            && supports_range
            && plan.config.bool_("segmented").unwrap_or(true)
            && !plan.config.bool_("forceSingleConnection").unwrap_or(false)
            && plan.resumable
            && plan.connections > 1
            && plan.total_size >= global_config().min_segment_bytes
        {
            log::info!(
                "Task {id}: enabling segmented transfer after preflight size discovery ({})",
                plan.total_size
            );
            plan.segmented = true;
        }
    }
    // Auto-resolve filename conflicts before downloading. Professional download
    // managers (IDM, browser built-in) never block the user with "file exists"
    // errors; they append " (1)", " (2)" etc. to the filename. This also fixes
    // the reported bug where NOVA "detects size but never downloads" because a
    // stale partial file from a previous failed attempt blocked the new one.
    if !plan.allow_overwrite && plan.output_path.exists() {
        let existing_size = FileWriter::current_size(&plan.output_path)?;
        // A full-size file is only trusted as "already complete" when the user
        // explicitly opted in via skipExisting. Otherwise an on-disk file whose
        // size matches the remote size may be a leftover preallocated file with
        // no real content (the reported fake-100% bug), so treat it as a
        // conflict to rename and download fresh, preserving the existing file.
        let is_complete = plan.total_size > 0
            && existing_size == plan.total_size
            && plan.config.bool_("skipExisting").unwrap_or(false);
        if !is_complete {
            if let Some(renamed) = auto_rename_path(&plan.output_path) {
                log::info!(
                    "Task {}: auto-renamed {} -> {} (conflict resolution)",
                    id,
                    plan.output_path.display(),
                    renamed.display()
                );
                plan.output_path = renamed;
                // Update the task snapshot so the UI shows the new filename.
                // Lock order: curl_jobs → task_snapshot (to match the rest of the codebase)
                if let Ok(mut jobs) = state.curl_jobs.lock() {
                    if let Some(job) = jobs.get_mut(id) {
                        job.task.save_path = plan.output_path.to_string_lossy().to_string();
                    }
                }
                if let Ok(mut tasks) = state.task_snapshot.lock() {
                    if let Some(task) = tasks.get_mut(id) {
                        task.save_path = plan.output_path.to_string_lossy().to_string();
                    }
                }
                state.mark_dirty();
            }
        }
    }

    for attempt in 0..retry_policy.attempts {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        log::debug!(
            "[RETRY] task={id} attempt={} max_attempts={} elapsed_ms={} last_error={}",
            attempt + 1,
            retry_policy.attempts,
            start_time.elapsed().as_millis(),
            last_error.chars().take(160).collect::<String>()
        );
        if start_time.elapsed() >= MAX_RETRY_WALL_TIME {
            log::warn!(
                "Task {id}: retry wall-time limit ({MAX_RETRY_WALL_TIME:?}) exceeded, giving up"
            );
            break;
        }
        if let Some(max_time) = retry_policy.max_total_time {
            if start_time.elapsed() >= max_time {
                log::info!("Task {id}: retry max_total_time ({max_time:?}) exceeded, giving up");
                break;
            }
        }
        let result = if plan.segmented {
            run_segmented_libcurl(
                state,
                id,
                &plan,
                cancel.clone(),
                retry_after.clone(),
                streaming_digest_out.clone(),
                &preflight,
            )
        } else {
            run_single_libcurl(
                state,
                id,
                &plan,
                cancel.clone(),
                retry_after.clone(),
                streaming_digest_out.clone(),
            )
        };
        match result {
            Ok(outcome) => {
                let size = outcome.size;
                let captured_validator = outcome.validator.clone();
                if let Ok(mut trackers) = state.engine_trackers.write() {
                    if let Some(tracker) = trackers.get_mut(id) {
                        tracker.retry_state.reset();
                    }
                }
                if let Ok(managers) = state.mirror_managers.lock() {
                    if let Some(mgr) = managers.get(id) {
                        mgr.report_success(&plan.url);
                    }
                }
                // Size validation is skipped only when the server ACTUALLY
                // used Content-Encoding for this transfer (captured from the
                // response headers) — never merely assumed from config.
                validate_transfer_size(plan.total_size, outcome.content_encoded, size)?;
                if let Some(ref expected_raw) = plan.digest_sha256 {
                    let actual_hex = verify_output_sha256(&plan.output_path, expected_raw)
                        .map_err(|error| {
                            log::warn!("Task {id}: {error}");
                            error
                        })?;
                    log::info!(
                        "Task {}: Content-Digest verified from complete output (sha-256={})",
                        id,
                        &actual_hex[..16]
                    );
                }
                if cancel.load(Ordering::Acquire) {
                    return Err("cancelled".to_owned());
                }
                if let Some(etag_file) = plan.config.str_("etagSave") {
                    if let Some(ref captured) = captured_validator {
                        if let Err(e) = std::fs::write(etag_file, captured) {
                            log::warn!(
                                "Task {id}: failed to persist ETag to {etag_file}: {e} — next resume will re-download"
                            );
                        }
                    }
                }
                return Ok(size);
            }
            Err(error) if error == "cancelled" || cancel.load(Ordering::Acquire) => {
                return Err("cancelled".to_owned())
            }
            Err(error) => {
                // ── Self-healer + policy engine ──────────────────────────
                // The self-healer analyzes the failure pattern and recommends
                // a recovery action. The policy engine records the decision
                // for analytics. We then use the recovery decision to
                // influence the actual retry behavior below.
                let mut healer_abort = false;
                let mut healer_pause: Option<Duration> = None;
                {
                    let failure_count = state
                        .engine_trackers
                        .read()
                        .ok()
                        .and_then(|t| t.get(id).map(|tr| tr.retry_state.attempt))
                        .unwrap_or(0);
                    let ctx =
                        build_decision_context(state, id, &plan, failure_count, 0, supports_range);
                    if let Ok(mut healer) = state.self_healer.lock() {
                        let recovery = healer.on_failure(&ctx.host, &error, &ctx);
                        log::info!("Task {id}: self-healer recovery decision: {recovery:?}");
                        // Wire the recovery decision into the retry loop.
                        if let crate::daemon::engine::policy_engine::PolicyDecision::Recovery {
                            ref action,
                            ..
                        } = recovery
                        {
                            use crate::daemon::engine::policy_engine::RecoveryAction;
                            match action {
                                RecoveryAction::Abort => {
                                    log::warn!("Task {id}: self-healer recommends abort — {error}");
                                    healer_abort = true;
                                }
                                RecoveryAction::RetryConnection => {
                                    // Single transient failure: the retry loop
                                    // below performs the actual retry. Keep the
                                    // current connection count — do not shrink
                                    // it — and surface the decision so the
                                    // recovery is visible in the logs instead of
                                    // being swallowed by a catch-all arm.
                                    log::info!(
                                        "Task {id}: self-healer recommends retry connection after transient failure"
                                    );
                                }
                                RecoveryAction::ReduceConnections => {
                                    let new_conns = (plan.connections / 2).max(1);
                                    log::info!(
                                        "Task {}: self-healer reducing connections {} -> {}",
                                        id,
                                        plan.connections,
                                        new_conns
                                    );
                                    plan.connections = new_conns;
                                }
                                RecoveryAction::RestartSegment(_seg) => {
                                    // Segment-level retries are owned by the
                                    // adaptive segment controller (which resumes
                                    // from disk truth); this policy hint is
                                    // logged for observability and does not need
                                    // a whole-download restart.
                                    log::info!(
                                        "Task {id}: self-healer suggests segment restart; segment-level retries are handled by the adaptive controller"
                                    );
                                }
                                RecoveryAction::ResumeFromCheckpoint => {
                                    // Persistent failures with resume support:
                                    // keep the partial data on disk and make the
                                    // next attempt resume from the checkpoint
                                    // instead of re-downloading or restarting.
                                    log::info!(
                                        "Task {id}: self-healer recommends resuming from checkpoint — keeping partial data"
                                    );
                                    plan.resumable = true;
                                }
                                RecoveryAction::PauseAndRetry(dur) => {
                                    log::info!(
                                        "Task {id}: self-healer pausing {dur:?} before retry"
                                    );
                                    healer_pause = Some(*dur);
                                }
                                RecoveryAction::RestartDownload => {
                                    // M-4: actually restart from scratch —
                                    // discard the partial file and its parts so
                                    // the next attempt starts at byte 0 instead
                                    // of resuming a possibly corrupted partial.
                                    log::info!(
                                        "Task {id}: self-healer restarting download from scratch"
                                    );
                                    let _ = std::fs::remove_file(&plan.output_path);
                                    remove_stale_parts_for(&plan.output_path);
                                    plan.resumable = false;
                                }
                            }
                        }
                    }
                    if let Ok(mut pe) = state.policy_engine.lock() {
                        let retry_decision = pe.decide_retry(&ctx, &error);
                        pe.record_decision(&retry_decision, &error);
                    }
                }
                if healer_abort {
                    return Err(error);
                }
                if let Ok(mut trackers) = state.engine_trackers.write() {
                    if let Some(tracker) = trackers.get_mut(id) {
                        tracker.retry_state.record_failure(error.clone());
                    }
                }
                if let Ok(managers) = state.mirror_managers.lock() {
                    if let Some(mgr) = managers.get(id) {
                        if let Some(new_url) = mgr.report_failure(&plan.url, &error) {
                            log::info!(
                                "Mirror failover for task {}: {} -> {}",
                                id,
                                plan.url,
                                new_url
                            );
                            plan.url = new_url;
                        }
                    }
                }
                if plan.segmented {
                    log::info!(
                        "Segmented attempt failed for task {id}; trying single-connection fallback"
                    );
                    plan.segmented = false;
                    if cancel.load(Ordering::Acquire) {
                        return Err("cancelled".to_owned());
                    }
                    match run_single_libcurl(
                        state,
                        id,
                        &plan,
                        cancel.clone(),
                        retry_after.clone(),
                        streaming_digest_out.clone(),
                    ) {
                        Ok(fb) => {
                            crate::daemon::direct::record_host_ceiling(&plan.url, 1);
                            validate_transfer_size(plan.total_size, fb.content_encoded, fb.size)?;
                            return Ok(fb.size);
                        }
                        Err(fb_error)
                            if fb_error == "cancelled" || cancel.load(Ordering::Acquire) =>
                        {
                            return Err("cancelled".to_owned());
                        }
                        Err(fb_error) => {
                            log::warn!(
                                "Single-connection fallback also failed for task {id}: {fb_error}"
                            );
                        }
                    }
                }
                if RetryPolicy::is_permanent_error(&error)
                    || !retry_policy.should_retry_error(&error)
                {
                    return Err(error);
                }
                last_error = error;
                if attempt + 1 < retry_policy.attempts {
                    let hinted = retry_after.swap(0, Ordering::AcqRel);
                    // Use the self-healer's recommended pause if available,
                    // otherwise fall back to Retry-After header or exponential backoff.
                    let backoff_delay = if let Some(pause) = healer_pause {
                        pause
                    } else if hinted > 0 {
                        Duration::from_secs(hinted)
                    } else {
                        retry_policy.delay_for_attempt(attempt as u32 + 1)
                    };
                    let actual_delay = if let Some(max_time) = retry_policy.max_total_time {
                        let remaining = max_time.saturating_sub(start_time.elapsed());
                        backoff_delay.min(remaining)
                    } else {
                        backoff_delay
                    };
                    // Sleep in 500ms chunks to check the cancel token
                    // periodically, preventing delayed cancellation.
                    let mut elapsed = Duration::ZERO;
                    while elapsed < actual_delay {
                        if cancel.load(Ordering::Acquire) {
                            return Err("cancelled".to_owned());
                        }
                        let chunk = Duration::from_millis(500)
                            .min(actual_delay.checked_sub(elapsed).unwrap_or(Duration::ZERO));
                        std::thread::sleep(chunk);
                        elapsed += chunk;
                    }
                }
            }
        }
    }
    Err(last_error)
}

pub fn mark_curl_task_finished(state: &SharedState, id: &str, final_size: u64, generation: u64) {
    log::info!("Task {id}: download completed (final_size={final_size}, generation={generation})");
    // C-3: verify the generation BEFORE any side effects. A stale worker that
    // finished after a newer run started must not release the queue slot or
    // bump stats that belong to the current run.
    {
        let jobs = lock_or_err!(state.curl_jobs);
        let Some(job) = jobs.get(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            log::info!("Task {id}: stale completion (generation {generation}) ignored",);
            return;
        }
    }
    state.priority_queue.stop_download(id);
    // download_stats scoped to this block and released before curl_jobs
    // is acquired below, preventing AB-BA deadlock with persist's
    // build_snapshot (which acquires curl_jobs → download_stats).
    {
        if let Ok(mut stats) = state.download_stats.lock() {
            stats.total_completed += 1;
            stats.total_downloaded_bytes += final_size;
        }
    }
    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        job.task.status = "completed".to_owned();
        job.task.downloaded_bytes = final_size;
        // A Content-Encoding transfer (gzip/br/deflate) decompresses the body
        // before writing it, so the real on-disk size may differ from the
        // probed Content-Length (which describes the compressed wire size).
        // Reconcile size_bytes to the ACTUAL file size so the completed task
        // never reports downloaded_bytes > size_bytes (progress > 100%).
        if job.task.size_bytes != final_size {
            job.task.size_bytes = final_size;
        }
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.engine_status = Some("completed".to_owned());
        job.task.error_message = None;
        job.task.segments =
            build_segments(job.task.connections, job.task.size_bytes, final_size, 0);
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
        state.mark_dirty();
    }
}

pub fn mark_curl_task_failed(
    state: &SharedState,
    id: &str,
    message: String,
    cancelled: bool,
    generation: u64,
) {
    let _task_ctx = crate::logging::push_context("task", id);
    let _path_ctx = crate::logging::push_context("phase", "error-path");
    if cancelled {
        log::info!("Task {id}: download cancelled (generation={generation})");
    } else {
        log::error!("Task {id}: download failed: {message} (generation={generation})");
    }
    // C-3: verify generation BEFORE any side effects — a stale worker must
    // not decrement active_downloads or bump failure stats for a newer run.
    {
        let jobs = lock_or_err!(state.curl_jobs);
        let Some(job) = jobs.get(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            log::info!("Task {id}: stale failure (generation {generation}) ignored");
            return;
        }
    }
    // Both cancellation and failure release an active slot. A user pause is a
    // temporary cancellation, however, so retain its queue entry: resume then
    // restores the same priority and bandwidth allocation instead of becoming
    // an untracked active transfer. Terminal failures still remove the entry.
    if cancelled {
        state.priority_queue.release_active_slot();
    } else {
        state.priority_queue.stop_download(id);
    }
    // download_stats scoped here; guard released before curl_jobs below
    // (see build_snapshot in persist.rs for lock-ordering rationale).
    if !cancelled {
        {
            if let Ok(mut stats) = state.download_stats.lock() {
                stats.total_failed += 1;
            }
        }
    }
    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        job.task.status = if cancelled { "paused" } else { "error" }.to_owned();
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.engine_status = Some(if cancelled { "paused" } else { "failed" }.to_owned());
        job.task.error_message = if cancelled {
            None
        } else {
            Some(message.clone())
        };
        let task = job.task.clone();
        if !cancelled {
            let segment_summary: Vec<String> = task
                .segments
                .iter()
                .map(|s| format!("{}:{}", s.id, s.downloaded_bytes))
                .collect();
            log::error!(
                "[ERROR-PATH] task={id} generation={generation} url={} save_path={} downloaded_bytes={} size_bytes={} status={} engine_status={:?} segments=[{}] error={message}",
                task.url,
                task.save_path,
                task.downloaded_bytes,
                task.size_bytes,
                task.status,
                task.engine_status,
                segment_summary.join(",")
            );
        }
        let remove_on_error = job
            .direct_options
            .get("removeOnError")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let path = std::path::PathBuf::from(&job.task.save_path);
        drop(jobs);
        if !cancelled && remove_on_error {
            let _ = std::fs::remove_file(&path);
            remove_stale_parts_for(&path);
        }
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
        state.mark_dirty();
    }
}

pub fn start_curl_process(state: &SharedState, id: &str) {
    let record = {
        let mut jobs = lock_or_err!(state.curl_jobs);
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.task.status == "completed" {
            return;
        }
        let worker_was_started = job.run_generation.load(Ordering::Acquire) > 0;
        if worker_was_started
            && matches!(
                job.task.status.as_str(),
                "downloading" | "pausing" | "stopping"
            )
        {
            return;
        }
        job.cancel_token = Arc::new(AtomicBool::new(false));
        let generation = job
            .run_generation
            .fetch_add(1, Ordering::Release)
            .saturating_add(1);
        job.task.status = "downloading".to_owned();
        job.task.engine_status = Some("running-libcurl-multi".to_owned());
        job.task.error_message = None;
        job.start_time = Instant::now();
        let plan = plan_from_job(job);
        let token = job.cancel_token.clone();
        log::info!(
            "Task {id}: plan_from_job — url={}, total_size={}, resumable={}, output_path={}, connections={}",
            plan.url, plan.total_size, plan.resumable, plan.output_path.display(), plan.connections
        );
        (plan, token, generation)
    };
    state.mark_dirty();
    state.priority_queue.start_download();

    let watchdog_cancel = record.1.clone();
    let watchdog_generation = record.2;
    let watchdog_id = id.to_owned();
    let watchdog_state = state.clone();
    let watchdog_expected = record.0.total_size;

    let state2 = state.clone();
    let id2 = id.to_owned();
    std::thread::spawn(move || {
        let (plan, cancel, generation) = record;
        let _task_ctx = crate::logging::push_context("task", &id2);
        let _url_ctx = crate::logging::push_context("url", &plan.url);
        log::info!("Starting libcurl multi transfer for task {id2} generation {generation}");
        let remove_on_error = plan.remove_on_error;
        let output_path = plan.output_path.clone();
        let expected_size = plan.total_size;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_libcurl_download(&state2, &id2, plan, cancel.clone())
        }));
        match result {
            Ok(Ok(0)) => {
                log::error!(
                    "Task {id2}: download produced 0-byte file (expected {expected_size}); refusing to mark as complete"
                );
                if remove_on_error {
                    let _ = std::fs::remove_file(&output_path);
                    remove_stale_parts_for(&output_path);
                }
                mark_curl_task_failed(
                    &state2,
                    &id2,
                    if expected_size > 0 {
                        format!(
                            "Transfer produced an empty file but {expected_size} bytes were expected; refusing to mark the download as complete"
                        )
                    } else {
                        "Download produced an empty file (0 bytes). The server may have rejected the request or TLS may have failed.".to_owned()
                    },
                    false,
                    generation,
                );
            }
            Ok(Ok(final_size)) => mark_curl_task_finished(&state2, &id2, final_size, generation),
            Ok(Err(error)) => {
                let cancelled = cancel.load(Ordering::Relaxed) || error == "cancelled";
                if !cancelled && remove_on_error {
                    let _ = std::fs::remove_file(&output_path);
                    remove_stale_parts_for(&output_path);
                }
                if cancelled {
                    let watchdog_set_error = state2.curl_jobs.lock().ok().is_some_and(|j| {
                        j.get(&id2)
                            .is_some_and(|job| job.task.error_message.is_some())
                    });
                    if watchdog_set_error {
                        log::info!(
                            "Task {id2}: watchdog already set error; preserving instead of marking cancelled"
                        );
                        // The watchdog's force_error_status already released the
                        // queue slot (and bumped stats) — do NOT decrement again,
                        // otherwise active_downloads is double-released.
                        return;
                    }
                }
                mark_curl_task_failed(&state2, &id2, error, cancelled, generation);
            }
            Err(panic_info) => {
                let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                    format!("Worker thread panicked: {s}")
                } else if let Some(s) = panic_info.downcast_ref::<String>() {
                    format!("Worker thread panicked: {s}")
                } else {
                    "Worker thread panicked with unknown payload".to_owned()
                };
                log::error!("{msg} (task: {id2})");
                mark_curl_task_failed(&state2, &id2, msg, false, generation);
            }
        }
    });

    // Watchdog thread: monitors the transfer independently of the curl
    // multi loop. If the multi socket interface blocks inside multi.action()
    // (which prevents tick() and the in-loop stall detector from firing),
    // this watchdog detects the stall from OUTSIDE and force-sets the cancel
    // token so the curl thread exits as soon as it checks it.
    // Small (< 1 MiB) downloads finish in seconds and are fully covered by the
    // in-loop stall detector, so the extra watchdog thread is skipped for them.
    if watchdog_expected >= 1_048_576 {
        let hard_deadline_secs = if watchdog_expected > 0 {
            let estimated = (watchdog_expected / 10_000) + 120;
            estimated.clamp(300, 10800)
        } else {
            7200
        };
        let watchdog_handle = std::thread::spawn(move || {
            log::info!(
                "Watchdog started for task {watchdog_id} (hard deadline: {hard_deadline_secs}s)"
            );
            let start = Instant::now();
            let mut last_downloaded: u64 = 0;
            let mut last_progress_time = Instant::now();
            let stall_timeout = Duration::from_secs(60);

            loop {
                std::thread::sleep(Duration::from_secs(3));

                if watchdog_state.shutdown_requested.load(Ordering::Acquire) {
                    log::info!("Watchdog for {watchdog_id}: daemon shutting down, exiting");
                    return;
                }

                if watchdog_cancel.load(Ordering::Acquire) {
                    log::info!("Watchdog for {watchdog_id}: cancel token already set, exiting");
                    return;
                }

                let (status, downloaded, speed) = {
                    let jobs = match watchdog_state.curl_jobs.lock() {
                        Ok(j) => j,
                        Err(_) => {
                            log::error!("Watchdog for {watchdog_id}: curl_jobs lock poisoned, force-cancelling");
                            watchdog_cancel.store(true, Ordering::Release);
                            return;
                        }
                    };
                    if let Some(job) = jobs.get(&watchdog_id) {
                        (
                            job.task.status.clone(),
                            job.task.downloaded_bytes,
                            job.task.speed_bytes_per_sec,
                        )
                    } else {
                        log::info!(
                            "Watchdog for {watchdog_id}: job removed from curl_jobs, exiting"
                        );
                        return;
                    }
                };

                if status != "downloading" {
                    log::info!("Watchdog for {watchdog_id}: status is '{status}', exiting");
                    return;
                }

                // H-2: global pause must not count toward the stall timeout;
                // otherwise a long pause would look like a stall and the
                // watchdog would force-cancel the transfer.
                if watchdog_state
                    .bandwidth_manager
                    .paused_flag()
                    .load(Ordering::Relaxed)
                {
                    last_progress_time = Instant::now();
                }

                if downloaded > last_downloaded {
                    last_downloaded = downloaded;
                    last_progress_time = Instant::now();
                }

                let elapsed = start.elapsed().as_secs();

                // Stall check: no bytes received for stall_timeout seconds
                if last_progress_time.elapsed() >= stall_timeout {
                    log::warn!(
                        "Watchdog: task {watchdog_id} stalled for {}s with 0 bytes/s — force-cancelling transfer (downloaded={downloaded})",
                        stall_timeout.as_secs()
                    );
                    watchdog_cancel.store(true, Ordering::Release);
                    force_error_status(
                        &watchdog_state,
                        &watchdog_id,
                        watchdog_generation,
                        format!(
                            "Download stalled: no data received for {} seconds. The connection may have hung or the server stopped responding.",
                            stall_timeout.as_secs()
                        ),
                    );
                    return;
                }

                // Hard deadline: total elapsed time exceeded
                if elapsed >= hard_deadline_secs {
                    log::warn!(
                        "Watchdog: task {watchdog_id} exceeded hard deadline of {hard_deadline_secs}s — force-cancelling transfer (downloaded={downloaded})"
                    );
                    watchdog_cancel.store(true, Ordering::Release);
                    force_error_status(
                        &watchdog_state,
                        &watchdog_id,
                        watchdog_generation,
                        format!(
                            "Download timed out after {hard_deadline_secs} seconds. The transfer did not complete within the allowed time limit."
                        ),
                    );
                    return;
                }

                // Periodic heartbeat log every 30s
                if elapsed > 0 && elapsed % 30 == 0 {
                    log::info!(
                        "Watchdog heartbeat: task {watchdog_id} — {elapsed}s elapsed, downloaded={downloaded}, speed={speed} B/s, status={status}"
                    );
                }
            }
        });
        match state.watchdog_handles.lock() {
            Ok(mut handles) => {
                handles.retain(|h| !h.is_finished());
                handles.push(watchdog_handle);
            }
            Err(e) => log::error!("watchdog_handles lock poisoned: {e}"),
        }
    }
}

/// Force a task to "error" status from an external thread (watchdog).
/// This is used when the curl worker thread is stuck and cannot update
/// the status itself. Checks the generation to prevent a stale watchdog
/// from overwriting a restarted task's state.
fn force_error_status(state: &SharedState, id: &str, generation: u64, message: String) {
    log::error!("Watchdog force-error for task {id}: {message}");
    // C-3: verify generation before side effects — a stale watchdog from an
    // old run must not release the slot or bump stats for the current run.
    {
        let jobs = lock_or_err!(state.curl_jobs);
        let Some(job) = jobs.get(id) else {
            return;
        };
        if job.task.status == "completed" || job.task.status == "paused" {
            return;
        }
        if generation > 0 && job.run_generation.load(Ordering::Acquire) != generation {
            log::info!(
                "Watchdog for {id}: generation mismatch (ours={generation}, current={}), skipping",
                job.run_generation.load(Ordering::Acquire)
            );
            return;
        }
    }
    state.priority_queue.stop_download(id);
    {
        if let Ok(mut stats) = state.download_stats.lock() {
            stats.total_failed += 1;
        }
    }
    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        if job.task.status == "completed" || job.task.status == "paused" {
            return;
        }
        if generation > 0 && job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        job.task.status = "error".to_owned();
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.engine_status = Some("watchdog-timeout".to_owned());
        job.task.error_message = Some(message);
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
        state.mark_dirty();
    }
}

/// Generate a unique filename by appending " (1)", " (2)", etc. before the
/// extension, mirroring the browser's `uniquify` conflict resolution.
/// Returns `None` only if the original path has no filename component.
/// Uses atomic `create_new` to prevent TOCTOU races across concurrent tasks.
fn auto_rename_path(original: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = original.parent()?;
    let stem = original.file_stem()?.to_str()?;
    let ext = original.extension().and_then(|e| e.to_str());

    // Keep the zero-byte file created with `create_new` as the reservation.
    // Deleting it before the transfer opens its output would reintroduce the
    // very TOCTOU race this helper is meant to prevent: another task could
    // claim the same name in that gap. The download writer safely reuses this
    // empty reservation and starts from offset zero.
    let try_claim = |candidate: &std::path::PathBuf| -> bool {
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(candidate)
            .map(drop)
            .is_ok()
    };

    for counter in 1u32..=9999 {
        let new_stem = format!("{stem} ({counter})");
        let new_name = match ext {
            Some(e) => format!("{new_stem}.{e}"),
            None => new_stem,
        };
        let candidate = parent.join(&new_name);
        if !candidate.exists() && try_claim(&candidate) {
            return Some(candidate);
        }
    }
    // Exhausted the friendly counter. Preserve the atomic claim invariant
    // even in this rare path; never return a path that this task failed to
    // reserve. Nanoseconds + PID make a collision unlikely, and the suffix
    // loop makes it deterministic if one still occurs.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    for suffix in 0u32..=9999 {
        let new_stem = format!("{}_{}_{}_{}", stem, ts, std::process::id(), suffix);
        let new_name = match ext {
            Some(e) => format!("{new_stem}.{e}"),
            None => new_stem,
        };
        let candidate = parent.join(&new_name);
        if try_claim(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_rename_reserves_distinct_output_names_until_the_writer_opens_them() {
        let dir = std::env::temp_dir().join(format!(
            "nova_auto_rename_reservation_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("asset.zip");
        std::fs::write(&original, b"existing").unwrap();

        let first = auto_rename_path(&original).expect("first conflict name must reserve");
        let second = auto_rename_path(&original).expect("second conflict name must reserve");
        assert_ne!(
            first, second,
            "two tasks must not receive the same output path"
        );
        assert!(first.exists(), "first reservation must remain held");
        assert!(second.exists(), "second reservation must remain held");
        assert_eq!(std::fs::metadata(&first).unwrap().len(), 0);
        assert_eq!(std::fs::metadata(&second).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_output_sha256_hashes_complete_output_not_a_single_segment() {
        use sha2::Digest;

        let dir = std::env::temp_dir().join(format!(
            "nova_complete_digest_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("merged.bin");
        let first_segment = b"first-segment-";
        let final_segment = b"final-segment";
        let complete_content = [first_segment.as_slice(), final_segment.as_slice()].concat();
        std::fs::write(&output, &complete_content).unwrap();

        let whole_digest = format!("{:x}", sha2::Sha256::digest(&complete_content));
        let final_segment_digest = format!("{:x}", sha2::Sha256::digest(final_segment));

        assert_eq!(
            verify_output_sha256(&output, &whole_digest).unwrap(),
            whole_digest
        );
        assert!(
            verify_output_sha256(&output, &final_segment_digest).is_err(),
            "a digest for only the last segment must never validate the merged output"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preflight_data_defaults() {
        let p = PreflightData::default();
        assert!(p.protocol.is_empty());
        assert_eq!(p.initial_rtt_us, 0);
        assert_eq!(p.tls_handshake_us, 0);
        assert_eq!(p.connect_us, 0);
        assert_eq!(p.ttfb_us, 0);
        assert!(!p.uses_tls);
        assert!(!p.supports_range);
    }

    #[test]
    #[allow(clippy::field_reassign_with_default)]
    fn preflight_data_clones() {
        let mut p = PreflightData::default();
        p.protocol = "h2".into();
        p.initial_rtt_us = 50000;
        p.tls_handshake_us = 12000;
        p.connect_us = 8000;
        p.ttfb_us = 55000;
        p.uses_tls = true;
        p.supports_range = true;
        let p2 = p.clone();
        assert_eq!(p2.protocol, "h2");
        assert_eq!(p2.initial_rtt_us, 50000);
        assert_eq!(p2.tls_handshake_us, 12000);
        assert_eq!(p2.connect_us, 8000);
        assert_eq!(p2.ttfb_us, 55000);
        assert!(p2.uses_tls);
        assert!(p2.supports_range);
    }

    #[test]
    fn preflight_propagates_range_support_to_adaptive_metadata() {
        let payload = std::sync::Arc::new(vec![42_u8; 4096]);
        let addr = spawn_slow_range_server(payload, 1024, 0);
        let url = format!("http://{addr}/range-metadata.bin");
        let body = download_body(&url, "range-metadata.bin", 4096, 2);
        let output = std::env::temp_dir().join(format!(
            "nova_preflight_range_metadata_{}",
            std::process::id()
        ));
        let job = task_from_body(
            &body,
            "preflight-range-metadata",
            "range-metadata.bin".to_owned(),
            &output,
            std::collections::HashMap::new(),
            Vec::new(),
        );

        let (_, supports_range, metadata) = resolve_effective_target(&plan_from_job(&job));

        assert!(
            supports_range,
            "range probe must report a 206-capable server"
        );
        assert!(
            metadata.supports_range,
            "adaptive metadata must match the preflight range result"
        );
    }

    #[test]
    fn update_curl_task_progress_sums_per_segment_write_pointers() {
        // Regression: `downloadedBytes` must equal the SUM of per-segment
        // (on-disk resume bytes + bytes written this run), each clamped to
        // its segment size — never a single whole-file write cursor. This is
        // what makes the progress bar move continuously with real disk
        // writes instead of jumping 0% → 100% at merge time.
        let dir =
            std::env::temp_dir().join(format!("nova_test_progress_sum_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "progress-sum-test";
        let out = dir.join("sample.bin");
        let body = download_body("http://127.0.0.1:1/sample.bin", "sample.bin", 1000, 2);
        let job = task_from_body(
            &body,
            id,
            "sample.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        // Two segments of 500 bytes each. Segment 0 resumed with 100 bytes
        // on disk and wrote 300 this run; segment 1 started empty and wrote
        // 250. The atomic counters mirror SegmentWriter::write increments.
        let ranges: Vec<(ByteRange, Arc<AtomicU64>, u64)> = vec![
            (
                ByteRange {
                    index: 0,
                    start: 0,
                    end: 499,
                    path: out.clone(),
                },
                Arc::new(AtomicU64::new(300)),
                100,
            ),
            (
                ByteRange {
                    index: 1,
                    start: 500,
                    end: 999,
                    path: out.clone(),
                },
                Arc::new(AtomicU64::new(250)),
                0,
            ),
        ];
        let mut last_total = 0u64;
        let mut last_tick = Instant::now();
        update_curl_task_progress(&state, id, 1000, &ranges, &mut last_total, &mut last_tick);

        let task = {
            let jobs = state.curl_jobs.lock().unwrap();
            jobs.get(id).unwrap().task.clone()
        };
        // 100+300 + 0+250 = 650 — the sum of the actual write pointers.
        assert_eq!(task.downloaded_bytes, 650);
        assert_eq!(task.size_bytes, 1000);
        assert_eq!(task.segments.len(), 2);
        assert_eq!(task.segments[0].downloaded_bytes, 400);
        assert_eq!(task.segments[1].downloaded_bytes, 250);
        assert_eq!(task.segments[0].total_bytes, 500);
        assert_eq!(task.segments[1].total_bytes, 500);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_curl_task_progress_clamps_segment_overrun() {
        // A segment whose counter exceeds its planned size (server sent extra
        // bytes, or a stale counter after an adaptive rebuild) must be
        // clamped to its part size so the task total never overshoots the
        // real file size — otherwise the UI would show >100%.
        let dir =
            std::env::temp_dir().join(format!("nova_test_progress_clamp_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "progress-clamp-test";
        let out = dir.join("sample.bin");
        let body = download_body("http://127.0.0.1:1/sample.bin", "sample.bin", 1000, 2);
        let job = task_from_body(
            &body,
            id,
            "sample.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        // Segment 0 claims 100 + 600 = 700 bytes into a 500-byte range; the
        // effective total must be clamped to 500, so the task total stays at
        // the real file size (500 + 500).
        let ranges: Vec<(ByteRange, Arc<AtomicU64>, u64)> = vec![
            (
                ByteRange {
                    index: 0,
                    start: 0,
                    end: 499,
                    path: out.clone(),
                },
                Arc::new(AtomicU64::new(600)),
                100,
            ),
            (
                ByteRange {
                    index: 1,
                    start: 500,
                    end: 999,
                    path: out.clone(),
                },
                Arc::new(AtomicU64::new(500)),
                0,
            ),
        ];
        let mut last_total = 0u64;
        let mut last_tick = Instant::now();
        update_curl_task_progress(&state, id, 1000, &ranges, &mut last_total, &mut last_tick);

        let task = {
            let jobs = state.curl_jobs.lock().unwrap();
            jobs.get(id).unwrap().task.clone()
        };
        assert_eq!(task.downloaded_bytes, 1000, "clamped to the file size");
        assert_eq!(task.segments[0].downloaded_bytes, 500);
        assert_eq!(task.segments[1].downloaded_bytes, 500);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn next_progress_total_transitions_unknown_to_known_without_backward_jump() {
        // The UI handoff this function exists for: a download starts with an
        // unknown size (indeterminate bar), then the response headers reveal
        // the real Content-Length. The reported total must jump 0 → known
        // exactly once and then stay FROZEN — changing it afterwards (shrink
        // OR grow) would make downloaded / size jump backward.

        // Unknown size, no headers yet → stays unknown (indeterminate).
        assert_eq!(next_progress_total(0, None, false), 0);
        // Headers arrive → the size becomes known.
        assert_eq!(next_progress_total(0, Some(1000), false), 1000);
        // A later, smaller header value must NOT shrink the reported total.
        assert_eq!(next_progress_total(1000, Some(800), false), 1000);
        // A later, larger header value must NOT grow it either (a grow would
        // also drop the percentage — e.g. 50% of 1000 → 25% of 2000).
        assert_eq!(next_progress_total(1000, Some(2000), false), 1000);
        // No headers at all after discovery → stays frozen.
        assert_eq!(next_progress_total(1000, None, false), 1000);
        // Unknown stays unknown even if a bogus 0 length is seen.
        assert_eq!(next_progress_total(0, Some(0), false), 0);
        // Content-encoded responses (gzip/br/deflate) always report unknown,
        // overriding even a size the preflight already seeded: the wire size
        // is the compressed size, not the on-disk file.
        assert_eq!(next_progress_total(1000, Some(2000), true), 0);
        assert_eq!(next_progress_total(0, Some(500), true), 0);
    }
    #[test]
    fn next_progress_total_keeps_percentage_monotonic_under_random_headers() {
        // Property test over many random header discoveries: once the total
        // is non-zero it is frozen, downloaded only grows and never exceeds
        // it, so the percentage the UI computes can never jump backward.
        // Content-encoding is a property of the RESPONSE (stable for the whole
        // transfer), so the model makes it sticky once seen — matching reality
        // where a gzip response stays gzip for every tick.
        let mut total = 0u64;
        let mut downloaded = 0u64;
        let mut encoded = false;
        let mut last_percent: Option<u64> = None;
        let mut seed: u64 = 0x9E3779B97F4A7C15;
        for tick in 0..10_000u64 {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let discovered = if seed % 3 == 0 {
                Some((seed >> 8) % 2_000_000)
            } else {
                None
            };
            // The server either always encodes or never encodes this transfer.
            encoded |= seed % 17 == 0;
            total = next_progress_total(total, discovered, encoded);
            downloaded = (downloaded + (seed % 1024)).min(if total > 0 { total } else { u64::MAX });
            if let Some(percent) = downloaded
                .checked_mul(100)
                .and_then(|scaled| scaled.checked_div(total))
            {
                if let Some(prev) = last_percent {
                    assert!(
                        percent >= prev,
                        "tick {tick}: percentage fell {prev}% -> {percent}% (total={total}, downloaded={downloaded})"
                    );
                }
                last_percent = Some(percent);
            }
        }
    }

    // ── Local HTTP server with byte-range support (206) ──────────────────
    fn spawn_range_server(payload: std::sync::Arc<Vec<u8>>) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payload = payload.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let total = payload.len() as u64;
                    let mut range = None;
                    for line in req.lines() {
                        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            range = Some(rest.trim().to_string());
                            break;
                        }
                    }
                    let send = |stream: &mut std::net::TcpStream, head: String, body: &[u8]| {
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(body);
                        let _ = stream.shutdown(Shutdown::Write);
                    };
                    match range {
                        Some(r) => {
                            let (s, e) = r.split_once('-').unwrap_or((r.as_str(), ""));
                            let start: u64 = s.trim().parse().unwrap_or(0);
                            if start >= total {
                                send(
                                    &mut stream,
                                    format!(
                                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                    ),
                                    b"",
                                );
                                return;
                            }
                            let end: u64 = if e.is_empty() {
                                total - 1
                            } else {
                                e.trim().parse().unwrap_or(total - 1)
                            };
                            let end = end.min(total - 1);
                            let body = &payload[start as usize..=end as usize];
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n",
                                    body.len()
                                ),
                                body,
                            );
                        }
                        None => send(
                            &mut stream,
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n"
                            ),
                            &payload,
                        ),
                    }
                });
            }
        });
        addr
    }

    /// Like `spawn_range_server` but dribbles the body out in small chunks
    /// with a sleep between writes, so a transfer takes long enough for the
    /// adaptive engine to evaluate and rebuild geometry mid-flight.
    fn spawn_slow_range_server(
        payload: std::sync::Arc<Vec<u8>>,
        chunk: usize,
        sleep_ms: u64,
    ) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payload = payload.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let total = payload.len() as u64;
                    let mut range = None;
                    for line in req.lines() {
                        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            range = Some(rest.trim().to_string());
                            break;
                        }
                    }
                    match range {
                        Some(r) => {
                            let (s, e) = r.split_once('-').unwrap_or((r.as_str(), ""));
                            let start: u64 = s.trim().parse().unwrap_or(0);
                            if start >= total {
                                let _ = stream.write_all(
                                    format!(
                                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                    )
                                    .as_bytes(),
                                );
                                let _ = stream.shutdown(Shutdown::Write);
                                return;
                            }
                            let end: u64 = if e.is_empty() {
                                total - 1
                            } else {
                                e.trim().parse().unwrap_or(total - 1)
                            };
                            let end = end.min(total - 1);
                            let body = &payload[start as usize..=end as usize];
                            let head = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            for piece in body.chunks(chunk.max(1)) {
                                if stream.write_all(piece).is_err() {
                                    return;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                            }
                            let _ = stream.shutdown(Shutdown::Write);
                        }
                        None => {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n"
                            );
                            let _ = stream.write_all(head.as_bytes());
                            for piece in payload.chunks(chunk.max(1)) {
                                if stream.write_all(piece).is_err() {
                                    return;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                            }
                            let _ = stream.shutdown(Shutdown::Write);
                        }
                    }
                });
            }
        });
        addr
    }

    /// Serves `payload` as an HTTP/1.1 **chunked** response with NO
    /// Content-Length header — the streaming mode that declares no size at
    /// all. The engine must keep the bar indeterminate (size stays 0 while
    /// downloaded_bytes grows honestly) and must not fabricate a percentage
    /// from an unknown total.
    fn spawn_chunked_server(
        payload: std::sync::Arc<Vec<u8>>,
        chunk: usize,
        sleep_ms: u64,
    ) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payload = payload.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let _n = stream.read(&mut buf).unwrap_or(0);
                    // No Content-Length: chunked transfer encoding only.
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                    );
                    for piece in payload.chunks(chunk.max(1)) {
                        if stream
                            .write_all(format!("{:x}\r\n", piece.len()).as_bytes())
                            .is_err()
                        {
                            return;
                        }
                        if stream.write_all(piece).is_err() {
                            return;
                        }
                        let _ = stream.write_all(b"\r\n");
                        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                    }
                    let _ = stream.write_all(b"0\r\n\r\n");
                    let _ = stream.shutdown(Shutdown::Write);
                });
            }
        });
        addr
    }

    /// Serves a gzip-compressed body with `Content-Encoding: gzip` and a
    /// Content-Length equal to the COMPRESSED size. libcurl decompresses
    /// transparently, so far more bytes land on disk than Content-Length
    /// declared — the exact case where the old code let downloaded_bytes
    /// outrun size_bytes (progress > 100%).
    fn spawn_gzip_server(
        payload: std::sync::Arc<Vec<u8>>,
        chunk: usize,
        sleep_ms: u64,
    ) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let gz = gzip_bytes(&payload);
        assert!(
            gz.len() < payload.len(),
            "test payload must actually compress"
        );
        let gz = std::sync::Arc::new(gz);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let gz = gz.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let _n = stream.read(&mut buf).unwrap_or(0);
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                            gz.len()
                        )
                        .as_bytes(),
                    );
                    for piece in gz.chunks(chunk.max(1)) {
                        if stream.write_all(piece).is_err() {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                    }
                    let _ = stream.shutdown(Shutdown::Write);
                });
            }
        });
        addr
    }

    /// Serves `payload` with byte-range support (206 Partial Content) AND
    /// `Content-Encoding: gzip` on every response — the pathological combo
    /// that breaks segmented downloads: each segment decompresses an
    /// independent compressed stream, so the decompressed bytes no longer
    /// align with the requested file offsets and merging the parts would
    /// silently corrupt the output. The engine must detect the encoding on
    /// the range responses, stop all segments, discard the parts, and fall
    /// back to a single connection (which decompresses the whole body once
    /// and writes the correct bytes).
    fn spawn_range_gzip_server(
        payload: std::sync::Arc<Vec<u8>>,
    ) -> (std::net::SocketAddr, Arc<AtomicBool>) {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let gz = gzip_bytes(&payload);
        let gz = std::sync::Arc::new(gz);
        // Set once a byte-range request arrives — proves the engine actually
        // ATTEMPTED a segmented download (and was forced back to a single
        // connection by the Content-Encoding rejection). Without this the
        // test could pass even if segmentation were silently disabled.
        let saw_range = Arc::new(AtomicBool::new(false));
        let saw_range_thread = saw_range.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let gz = gz.clone();
                let saw_range_thread = saw_range_thread.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let mut range = None;
                    for line in req.lines() {
                        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            range = Some(rest.trim().to_string());
                            saw_range_thread.store(true, Ordering::Release);
                            break;
                        }
                    }
                    let send = |stream: &mut std::net::TcpStream, head: String, body: &[u8]| {
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(body);
                        let _ = stream.shutdown(Shutdown::Write);
                    };
                    match range {
                        Some(r) => {
                            // Range request: serve a 206 of the COMPRESSED
                            // stream (a misbehaving but real-world behavior
                            // for pre-compressed files behind a CDN). Each
                            // segment therefore receives its own gzip body.
                            let (s, e) = r.split_once('-').unwrap_or((r.as_str(), ""));
                            let start: u64 = s.trim().parse().unwrap_or(0);
                            let max_index = (gz.len() as u64).saturating_sub(1);
                            // The engine initially plans ranges against the advertised
                            // uncompressed size. When a server then applies gzip to its
                            // ranged responses, later segment starts can legitimately be
                            // beyond the compressed representation. A real HTTP server
                            // must report that as an unsatisfiable range rather than let
                            // the test fixture panic in a detached request thread.
                            if start > max_index {
                                send(
                                    &mut stream,
                                    format!(
                                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                        gz.len()
                                    ),
                                    &[],
                                );
                                return;
                            }
                            let end: u64 = if e.is_empty() {
                                max_index
                            } else {
                                e.trim().parse().unwrap_or(max_index)
                            };
                            let end = end.min(max_index);
                            let body = &gz[start as usize..=end as usize];
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Encoding: gzip\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                    gz.len(),
                                    body.len()
                                ),
                                body,
                            );
                        }
                        None => {
                            // Plain GET: serve the whole gzip body once.
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                                    gz.len()
                                ),
                                &gz,
                            );
                        }
                    }
                });
            }
        });
        (addr, saw_range)
    }

    /// Serves byte ranges but answers every range request with MORE bytes
    /// than requested: the Content-Length is `range_len + extra` and the body
    /// includes the surplus. A misbehaving server that sends extra bytes past
    /// the requested range must not push progress past 100% (the engine
    /// clamps each segment to its planned size) and the merged file must
    /// truncate the surplus back to the exact payload.
    fn spawn_overrange_server(
        payload: std::sync::Arc<Vec<u8>>,
        extra: usize,
        chunk: usize,
        sleep_ms: u64,
    ) -> std::net::SocketAddr {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payload = payload.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let total = payload.len() as u64;
                    let mut range = None;
                    for line in req.lines() {
                        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            range = Some(rest.trim().to_string());
                            break;
                        }
                    }
                    let send = |stream: &mut std::net::TcpStream, head: String, body: &[u8]| {
                        let _ = stream.write_all(head.as_bytes());
                        for piece in body.chunks(chunk.max(1)) {
                            if stream.write_all(piece).is_err() {
                                return;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                        }
                        let _ = stream.shutdown(Shutdown::Write);
                    };
                    match range {
                        Some(r) => {
                            let (s, e) = r.split_once('-').unwrap_or((r.as_str(), ""));
                            let start: u64 = s.trim().parse().unwrap_or(0);
                            if start >= total {
                                send(
                                    &mut stream,
                                    format!(
                                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                    ),
                                    b"",
                                );
                                return;
                            }
                            let end: u64 = if e.is_empty() {
                                total - 1
                            } else {
                                e.trim().parse().unwrap_or(total - 1)
                            };
                            let end = end.min(total - 1);
                            let want = (end - start + 1) as usize + extra;
                            // Build a body with the requested range PLUS `extra`
                            // surplus bytes (cycling the payload so the surplus
                            // is deterministic). The Content-Length below must
                            // advertise the ACTUAL sent length so curl doesn't
                            // stall waiting for bytes that never come.
                            let mut body = Vec::with_capacity(want);
                            for i in 0..want {
                                let idx = (start as usize + i) % payload.len();
                                body.push(payload[idx]);
                            }
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n",
                                    body.len()
                                ),
                                &body,
                            );
                        }
                        None => send(
                            &mut stream,
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n"
                            ),
                            &payload,
                        ),
                    }
                });
            }
        });
        addr
    }

    fn gzip_bytes(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    fn download_body(
        url: &str,
        name: &str,
        size: u64,
        connections: u32,
    ) -> crate::daemon::types::CreateDownloadBody {
        crate::daemon::types::CreateDownloadBody {
            url: Some(url.to_string()),
            name: Some(name.to_string()),
            file_type: Some("other".to_string()),
            size_bytes: Some(size),
            category: Some("tests".to_string()),
            queue_id: Some("main".to_string()),
            connections: Some(connections),
            resumable: Some(true),
            save_path: None,
            description: Some("integration test".to_string()),
            referer: None,
            start_immediately: Some(true),
            direct_options: None,
            media_options: None,
        }
    }

    fn run_task_to_completion(
        state: &SharedState,
        id: &str,
        timeout: std::time::Duration,
    ) -> crate::daemon::types::Task {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let task = {
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(job) = jobs.get(id) else {
                    panic!("task {id} vanished");
                };
                job.task.clone()
            };
            match task.status.as_str() {
                "completed" => return task,
                "error" => panic!(
                    "task {id} failed: {:?} (size={}, downloaded={})",
                    task.error_message, task.size_bytes, task.downloaded_bytes
                ),
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "task {id} timed out (status={}, downloaded={}, size={})",
                        task.status,
                        task.downloaded_bytes,
                        task.size_bytes
                    );
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        }
    }

    #[test]
    fn failed_primary_fails_over_to_link_mirror_and_preserves_content() {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};

        let payload: Vec<u8> = (0..(1024 * 1024))
            .map(|index| (index % 251) as u8)
            .collect();
        let backup_addr =
            spawn_slow_range_server(std::sync::Arc::new(payload.clone()), 32 * 1024, 1);
        let backup_url = format!("http://{backup_addr}/mirror.bin");

        // The primary accepts the request but rejects the transfer. Preflight
        // is explicitly marked as resolved below so this status exercises the
        // libcurl retry loop, where link-mirror failover must happen.
        let primary_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let primary_addr = primary_listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in primary_listener.incoming() {
                let Ok(mut stream) = stream else { break };
                std::thread::spawn(move || {
                    let mut request = [0u8; 4096];
                    let _ = stream.read(&mut request);
                    let _ = stream.write_all(
                        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    let _ = stream.shutdown(Shutdown::Write);
                });
            }
        });
        let primary_url = format!("http://{primary_addr}/primary.bin");

        let dir =
            std::env::temp_dir().join(format!("nova_test_mirror_failover_{}", std::process::id()));
        let out = dir.join("mirror.bin");
        std::fs::create_dir_all(&dir).unwrap();
        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "link-mirror-failover";
        let body = download_body(&primary_url, "mirror.bin", payload.len() as u64, 1);
        let direct_options = std::collections::HashMap::from([
            (
                "preflightResolved".to_owned(),
                serde_json::Value::Bool(true),
            ),
            (
                "preflightSupportsRange".to_owned(),
                serde_json::Value::Bool(false),
            ),
            (
                "linkMirrors".to_owned(),
                serde_json::Value::Array(vec![serde_json::Value::String(backup_url.clone())]),
            ),
            (
                "forceSingleConnection".to_owned(),
                serde_json::Value::Bool(true),
            ),
            ("retryCount".to_owned(), serde_json::Value::from(3u64)),
            ("retryAllErrors".to_owned(), serde_json::Value::Bool(true)),
            ("retryDelaySec".to_owned(), serde_json::Value::from(0u64)),
        ]);
        let job = task_from_body(
            &body,
            id,
            "mirror.bin".to_owned(),
            &out,
            direct_options,
            Vec::new(),
        );
        state.curl_jobs.lock().unwrap().insert(id.to_owned(), job);
        state.mark_dirty();

        let transfer_state = state.clone();
        std::thread::spawn(move || start_curl_process(&transfer_state, id));
        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(45));

        assert_eq!(task.status, "completed");
        assert_eq!(std::fs::read(&out).unwrap(), payload);
        let manager = state
            .mirror_managers
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .expect("link mirrors must be registered before the first attempt");
        assert_eq!(manager.active_url(), backup_url);
        assert!(manager
            .mirrors()
            .iter()
            .find(|source| source.url == primary_url)
            .is_some_and(|source| !source.healthy));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_single_download_reports_intermediate_progress_and_full_content() {
        let payload: Vec<u8> = (0..(4 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        // Use the throttled server: a plain localhost transfer can complete
        // between the 5ms polling ticks under parallel load, making the
        // "intermediate progress observed" assertion a race. Dribbling the
        // body out over several hundred ms makes the observation deterministic.
        let addr = spawn_slow_range_server(std::sync::Arc::new(payload.clone()), 64 * 1024, 2);
        let url = format!("http://{addr}/sample.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_fresh_{}", std::process::id()));
        let out = dir.join("sample.zip");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "fresh-progress-test";
        let body = download_body(&url, "sample.zip", payload.len() as u64, 1);
        let job = task_from_body(
            &body,
            id,
            "sample.zip".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut saw_intermediate = false;
        loop {
            let (status, downloaded, size) = {
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(j) = jobs.get(id) else { break };
                (
                    j.task.status.clone(),
                    j.task.downloaded_bytes,
                    j.task.size_bytes,
                )
            };
            if downloaded > 0 && downloaded < size {
                saw_intermediate = true;
            } else if downloaded > 0 && size == 0 {
                // Progress with unknown size still proves live updates are
                // flowing (the header may not have been parsed yet).
                saw_intermediate = true;
            }
            if status == "completed" || status == "error" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timeout status={status}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(30));
        assert_eq!(task.size_bytes, payload.len() as u64);
        assert!(
            saw_intermediate,
            "no intermediate progress observed (downloaded stuck at 0, then jump to 100%)"
        );
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "output content mismatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capable_hosts_execute_more_than_32_parallel_range_segments() {
        // This is deliberately capability-gated: a two-core CI runner should
        // not be forced into unsafe parallelism merely to satisfy a test. On
        // a host whose autonomous ceiling exceeds 32, however, the real curl
        // path must create and complete that many range-backed part files.
        let target_connections = crate::daemon::engine::config::global_config()
            .max_connections_per_download
            .min(48);
        if target_connections <= 32 {
            return;
        }

        let payload: Vec<u8> = (0..(usize::try_from(target_connections).unwrap() * 512 * 1024))
            .map(|index| (index % 251) as u8)
            .collect();
        let addr = spawn_slow_range_server(std::sync::Arc::new(payload.clone()), 32 * 1024, 12);
        let url = format!("http://{addr}/parallel.bin");
        let dir = std::env::temp_dir().join(format!(
            "nova_test_parallel_{}_{}",
            std::process::id(),
            target_connections
        ));
        let out = dir.join("parallel.bin");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "parallel-over-32-test";
        let body = download_body(
            &url,
            "parallel.bin",
            payload.len() as u64,
            target_connections,
        );
        let direct_options = std::collections::HashMap::from([
            (
                "preflightResolved".to_owned(),
                serde_json::Value::Bool(true),
            ),
            (
                "preflightSupportsRange".to_owned(),
                serde_json::Value::Bool(true),
            ),
        ]);
        let job = task_from_body(
            &body,
            id,
            "parallel.bin".to_owned(),
            &out,
            direct_options,
            Vec::new(),
        );
        state.curl_jobs.lock().unwrap().insert(id.to_owned(), job);
        state.mark_dirty();

        let transfer_state = state.clone();
        std::thread::spawn(move || start_curl_process(&transfer_state, id));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut peak_part_files = 0usize;
        while std::time::Instant::now() < deadline {
            let part_files = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("parallel.bin.part")
                })
                .count();
            peak_part_files = peak_part_files.max(part_files);
            let status = state
                .curl_jobs
                .lock()
                .unwrap()
                .get(id)
                .map(|job| job.task.status.clone())
                .unwrap_or_default();
            if status == "completed" || status == "error" {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(45));
        assert_eq!(task.status, "completed");
        assert!(
            peak_part_files >= target_connections as usize,
            "expected at least {target_connections} live range parts, observed {peak_part_files}"
        );
        assert_eq!(std::fs::read(&out).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_size_download_learns_total_from_content_length_for_live_progress() {
        let payload: Vec<u8> = (0..(4 * 1024 * 1024)).map(|i| (i % 257) as u8).collect();
        // Use the throttled server: a plain localhost transfer can complete
        // between the 5ms polling ticks under parallel load, making the
        // "intermediate progress observed" assertion a race (the same flake
        // the fresh_download sibling test guards against). Dribbling the
        // body out over several hundred ms makes the observation deterministic.
        let addr = spawn_slow_range_server(std::sync::Arc::new(payload.clone()), 64 * 1024, 2);
        let url = format!("http://{addr}/unknown.bin");
        let dir = std::env::temp_dir().join(format!("nova_test_unknown_{}", std::process::id()));
        let out = dir.join("unknown.bin");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "unknown-size-progress-test";
        // The reported bug: task created with an unknown total size (0). The
        // UI computed progress as downloaded/0 = 0%, then jumped to 100% only
        // when mark_curl_task_finished finally filled size_bytes. The transfer
        // must instead learn Content-Length during the response and expose a
        // real intermediate percentage.
        let body = download_body(&url, "unknown.bin", 0, 1);
        let job = task_from_body(
            &body,
            id,
            "unknown.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut saw_intermediate = false;
        loop {
            let (status, downloaded, size) = {
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(j) = jobs.get(id) else { break };
                (
                    j.task.status.clone(),
                    j.task.downloaded_bytes,
                    j.task.size_bytes,
                )
            };
            if downloaded > 0 && downloaded < size {
                saw_intermediate = true;
            }
            if status == "completed" || status == "error" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timeout status={status} downloaded={downloaded} size={size}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(30));
        assert_eq!(task.size_bytes, payload.len() as u64);
        assert!(
            saw_intermediate,
            "no intermediate progress: size_bytes stayed 0 during transfer (0% then 100% bug)"
        );
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "output content mismatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preflight_discovers_total_size_before_transfer_for_unknown_size_download() {
        // The 0% → 100% bug's missing link: the engine's own preflight
        // (resolve_effective_target) performs a real HTTP request but used to
        // throw away the Content-Length/Content-Range it received, so a
        // fast-path download that started with size 0 stayed at 0% until
        // completion. The preflight must capture the total size and the
        // dispatch must apply it BEFORE the transfer so the UI shows a live
        // percentage from byte one.
        let payload: Vec<u8> = (0..(2 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_slow_range_server(std::sync::Arc::new(payload.clone()), 128 * 1024, 1);
        let url = format!("http://{addr}/preflight-unknown.bin");
        let dir =
            std::env::temp_dir().join(format!("nova_test_preflight_size_{}", std::process::id()));
        let out = dir.join("preflight-unknown.bin");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "preflight-size-test";
        let body = download_body(&url, "preflight-unknown.bin", 0, 1);
        let job = task_from_body(
            &body,
            id,
            "preflight-unknown.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut saw_size_before_completion = false;
        let mut saw_intermediate_percent = false;
        loop {
            let (status, downloaded, size) = {
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(j) = jobs.get(id) else { break };
                (
                    j.task.status.clone(),
                    j.task.downloaded_bytes,
                    j.task.size_bytes,
                )
            };
            if status == "downloading" && size == payload.len() as u64 {
                saw_size_before_completion = true;
            }
            if status == "downloading" && size > 0 && downloaded > 0 && downloaded < size {
                saw_intermediate_percent = true;
            }
            if status == "completed" || status == "error" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timeout status={status} downloaded={downloaded} size={size}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(30));
        assert_eq!(task.size_bytes, payload.len() as u64);
        assert!(
            saw_size_before_completion,
            "preflight did not surface the total size while the transfer was still running"
        );
        assert!(
            saw_intermediate_percent,
            "no real intermediate percentage: downloaded/size never observed mid-transfer"
        );
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "output content mismatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preflight_size_upgrades_unknown_size_download_to_segmented() {
        // A fast-path download that starts with an unknown size (0) and
        // requests >1 connection must be upgraded to a segmented transfer once
        // the preflight learns the real size (Content-Length/Content-Range) —
        // previously it stayed single-connection forever, wasting the server's
        // range support and the user's bandwidth.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_slow_range_server(std::sync::Arc::new(payload.clone()), 128 * 1024, 1);
        let url = format!("http://{addr}/upgrade-unknown.bin");
        let dir =
            std::env::temp_dir().join(format!("nova_test_seg_upgrade_{}", std::process::id()));
        let out = dir.join("upgrade-unknown.bin");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "seg-upgrade-test";
        let body = download_body(&url, "upgrade-unknown.bin", 0, 4);
        let job = task_from_body(
            &body,
            id,
            "upgrade-unknown.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        // Watch for the engine tracker's segment scheduler to appear — it is
        // only registered by run_segmented_libcurl, so its presence proves the
        // transfer was actually segmented (not single-connection).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut saw_segmented_tracker = false;
        loop {
            let (status, has_tracker, size, downloaded) = {
                let trackers = state.engine_trackers.read().unwrap();
                let has = trackers.get(id).is_some_and(|t| t.segments.is_some());
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(j) = jobs.get(id) else { break };
                (
                    j.task.status.clone(),
                    has,
                    j.task.size_bytes,
                    j.task.downloaded_bytes,
                )
            };
            if has_tracker && size == payload.len() as u64 && downloaded > 0 {
                saw_segmented_tracker = true;
            }
            if status == "completed" || status == "error" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timeout status={status} size={size} downloaded={downloaded} segmented={has_tracker}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(30));
        assert_eq!(task.size_bytes, payload.len() as u64);
        assert!(
            saw_segmented_tracker,
            "preflight-discovered size did not upgrade the transfer to segmented mode"
        );
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "output content mismatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunked_response_without_content_length_keeps_progress_honest() {
        // Regression: a server streaming with Transfer-Encoding: chunked and
        // NO Content-Length. The total size is genuinely unknown, so the bar
        // must stay indeterminate (size_bytes 0) while downloaded_bytes grows
        // live, and the completed task must report the real file size.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_chunked_server(std::sync::Arc::new(payload.clone()), 64 * 1024, 2);
        let url = format!("http://{addr}/chunked.bin");
        let dir = std::env::temp_dir().join(format!("nova_test_chunked_{}", std::process::id()));
        let out = dir.join("chunked.bin");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "chunked-progress-test";
        let body = download_body(&url, "chunked.bin", 0, 1);
        let job = task_from_body(
            &body,
            id,
            "chunked.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut saw_live = false;
        loop {
            let (status, downloaded, size) = {
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(j) = jobs.get(id) else { break };
                (
                    j.task.status.clone(),
                    j.task.downloaded_bytes,
                    j.task.size_bytes,
                )
            };
            if status == "downloading" && downloaded > 0 {
                saw_live = true;
            }
            // Honesty invariant: whenever a size is known, downloaded must
            // never exceed it — and while the size is unknown it must stay 0
            // (the UI renders an indeterminate bar, not a fake percentage).
            assert!(
                size == 0 || downloaded <= size,
                "progress exceeded 100%: downloaded={downloaded} size={size}"
            );
            if status == "completed" || status == "error" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timeout status={status} downloaded={downloaded} size={size}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(30));
        assert_eq!(task.status, "completed");
        assert_eq!(task.size_bytes, payload.len() as u64);
        assert_eq!(task.downloaded_bytes, payload.len() as u64);
        assert!(
            saw_live,
            "no live progress observed during chunked transfer"
        );
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "chunked output content mismatch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_encoding_gzip_writes_decompressed_file_without_fake_percentage() {
        // Regression: a server that gzips on the fly. Content-Length
        // advertises the COMPRESSED size, but libcurl decompresses the body
        // before it is written, so far more bytes land on disk than were
        // declared. The engine must not report a percentage above 100% and
        // must reconcile size_bytes to the real (decompressed) size at
        // completion.
        let payload: Vec<u8> = (0..(2 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_gzip_server(std::sync::Arc::new(payload.clone()), 8 * 1024, 2);
        let url = format!("http://{addr}/app.gz");
        let dir = std::env::temp_dir().join(format!("nova_test_gzip_{}", std::process::id()));
        let out = dir.join("app.gz");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "gzip-progress-test";
        // Start with an unknown size; the preflight discovers the COMPRESSED
        // Content-Length, which is smaller than the decompressed file — the
        // exact trap that used to push the progress bar over 100%.
        let body = download_body(&url, "app.gz", 0, 1);
        let job = task_from_body(
            &body,
            id,
            "app.gz".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let (status, downloaded, size) = {
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(j) = jobs.get(id) else { break };
                (
                    j.task.status.clone(),
                    j.task.downloaded_bytes,
                    j.task.size_bytes,
                )
            };
            // Never exceed 100%: when a size is reported, downloaded must fit
            // under it; once Content-Encoding is detected the size correctly
            // becomes unknown (0 = indeterminate bar).
            assert!(
                size == 0 || downloaded <= size,
                "gzip progress exceeded 100%: downloaded={downloaded} size={size}"
            );
            if status == "completed" || status == "error" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timeout status={status} downloaded={downloaded} size={size}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(30));
        assert_eq!(task.status, "completed");
        assert_eq!(
            task.size_bytes,
            payload.len() as u64,
            "size_bytes must be the DECOMPRESSED file size, not the compressed Content-Length"
        );
        assert_eq!(task.downloaded_bytes, payload.len() as u64);
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "on-disk file must be the decompressed payload, not the gzip bytes"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn range_capable_gzip_server_falls_back_to_single_connection() {
        // Regression (C-5): a server that honors byte ranges AND applies
        // Content-Encoding: gzip to every response is pathological for
        // segmented downloads — each segment decompresses an independent
        // compressed stream whose byte offsets no longer match the file, so
        // merging the parts would silently corrupt the output. The engine
        // must detect the encoding on the range responses, stop every
        // segment, discard the parts, and fall back to a single connection,
        // which decompresses the whole body once and writes correct bytes.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let (addr, saw_range) = spawn_range_gzip_server(std::sync::Arc::new(payload.clone()));
        let url = format!("http://{addr}/app.bin");
        let dir = std::env::temp_dir().join(format!("nova_test_rangegz_{}", std::process::id()));
        let out = dir.join("app.bin");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "range-gzip-test";
        // Force a segmented attempt (4 connections, known size above the
        // segment minimum) so the encoding-rejection path is exercised.
        let body = download_body(&url, "app.bin", payload.len() as u64, 4);
        let job = task_from_body(
            &body,
            id,
            "app.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(60));
        assert_eq!(
            task.status, "completed",
            "range+gzip server must complete via single-connection fallback"
        );
        // The engine must have ATTEMPTED a segmented download (a byte-range
        // request reached the server) before being forced back to a single
        // connection — otherwise this test would pass even if segmentation
        // were silently disabled and the C-5 rejection never ran.
        assert!(
            saw_range.load(Ordering::Acquire),
            "engine never sent a byte-range request: the segmented attempt (and its \
             Content-Encoding rejection) was not exercised"
        );
        // Honesty: the completed task reports the real decompressed size and
        // never claims more downloaded than the on-disk file.
        assert_eq!(task.size_bytes, payload.len() as u64);
        assert_eq!(task.downloaded_bytes, payload.len() as u64);
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "range+gzip server: merged output must equal the payload"
        );
        assert_eq!(written.len(), payload.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn overrange_server_progress_stays_at_or_below_100_and_merge_truncates_surplus() {
        // Regression: a misbehaving server that answers each range request
        // with MORE bytes than requested. Each segment's part file therefore
        // grows beyond its planned size; the engine must clamp reported
        // progress to the planned segment size (never >100%) and the merge
        // must truncate the surplus so the final file matches the payload
        // byte-for-byte.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let extra = 64 * 1024;
        let addr =
            spawn_overrange_server(std::sync::Arc::new(payload.clone()), extra, 64 * 1024, 2);
        let url = format!("http://{addr}/over.bin");
        let dir = std::env::temp_dir().join(format!("nova_test_overrange_{}", std::process::id()));
        let out = dir.join("over.bin");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "overrange-progress-test";
        let body = download_body(&url, "over.bin", payload.len() as u64, 4);
        let job = task_from_body(
            &body,
            id,
            "over.bin".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut observed_live_progress = false;
        loop {
            let (status, downloaded, size, segments) = {
                let jobs = state.curl_jobs.lock().unwrap();
                let Some(j) = jobs.get(id) else { break };
                (
                    j.task.status.clone(),
                    j.task.downloaded_bytes,
                    j.task.size_bytes,
                    j.task.segments.clone(),
                )
            };
            // The local server emits bounded chunks. An intermediate byte count
            // proves the real transfer exposes live progress, not only zero and
            // the final completed total.
            if size > 0 && downloaded > 0 && downloaded < size {
                observed_live_progress = true;
            }
            // Task-level honesty: the total can never exceed the known size.
            assert!(
                size == 0 || downloaded <= size,
                "overrange progress exceeded 100%: downloaded={downloaded} size={size}"
            );
            // Segment-level honesty: no segment may report more than its
            // planned byte range, even though the server sends extra bytes.
            for seg in &segments {
                assert!(
                    seg.downloaded_bytes <= seg.total_bytes,
                    "segment {} over its range: downloaded={} total={}",
                    seg.id,
                    seg.downloaded_bytes,
                    seg.total_bytes
                );
            }
            if status == "completed" || status == "error" {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timeout status={status} downloaded={downloaded} size={size}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(30));
        assert!(
            observed_live_progress,
            "real local transfer never exposed an intermediate progress value"
        );
        assert_eq!(task.status, "completed");
        assert_eq!(task.size_bytes, payload.len() as u64);
        assert_eq!(task.downloaded_bytes, payload.len() as u64);
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "overrange merge must truncate the surplus bytes"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resume_of_preallocated_partial_file_repairs_content() {
        let payload: Vec<u8> = (0..(1024 * 1024)).map(|i| (i % 253) as u8).collect();
        let addr = spawn_range_server(std::sync::Arc::new(payload.clone()));
        let url = format!("http://{addr}/resume.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_resume_{}", std::process::id()));
        let out = dir.join("resume.zip");
        std::fs::create_dir_all(&dir).unwrap();

        // Simulate a leftover preallocated file: full size on disk but only a
        // fraction of the real payload written (the rest is zeros).
        let partial = 256 * 1024usize;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&out)
            .unwrap();
        f.set_len(payload.len() as u64).unwrap();
        use std::io::Write;
        f.write_all(&payload[..partial]).unwrap();
        f.sync_all().unwrap();
        drop(f);

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "resume-prealloc-test";
        let body = download_body(&url, "resume.zip", payload.len() as u64, 1);
        let mut direct_options = std::collections::HashMap::new();
        direct_options.insert(
            "etag".to_string(),
            serde_json::Value::String("nova-test".to_string()),
        );
        // Restart-in-place is the overwrite path; the no-clobber path auto-
        // renames the target instead (covered by the dispatcher logic).
        direct_options.insert("allowOverwrite".to_string(), serde_json::json!(true));
        let job = task_from_body(
            &body,
            id,
            "resume.zip".to_string(),
            &out,
            direct_options,
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(60));
        assert_eq!(task.size_bytes, payload.len() as u64);
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "preallocated partial file was treated as complete and left corrupted"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_clobber_full_size_leftover_is_renamed_and_redownloaded() {
        let payload: Vec<u8> = (0..(1024 * 1024)).map(|i| (i % 253) as u8).collect();
        let addr = spawn_range_server(std::sync::Arc::new(payload.clone()));
        let url = format!("http://{addr}/resume.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_noclob_{}", std::process::id()));
        let out = dir.join("resume.zip");
        std::fs::create_dir_all(&dir).unwrap();

        // Leftover preallocated file at the default (no-clobber) setting.
        let partial = 256 * 1024usize;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&out)
            .unwrap();
        f.set_len(payload.len() as u64).unwrap();
        use std::io::Write;
        f.write_all(&payload[..partial]).unwrap();
        f.sync_all().unwrap();
        drop(f);

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "noclob-prealloc-test";
        let body = download_body(&url, "resume.zip", payload.len() as u64, 1);
        let mut direct_options = std::collections::HashMap::new();
        direct_options.insert(
            "etag".to_string(),
            serde_json::Value::String("nova-test".to_string()),
        );
        let job = task_from_body(
            &body,
            id,
            "resume.zip".to_string(),
            &out,
            direct_options,
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(60));
        assert_eq!(task.size_bytes, payload.len() as u64);
        // The leftover is preserved, and a fresh copy is downloaded under a
        // conflict-suffixed name instead of being accepted as complete.
        let preserved = std::fs::read(&out).unwrap();
        assert_eq!(
            preserved.len(),
            payload.len(),
            "existing no-clobber file must not be overwritten"
        );
        assert_eq!(
            preserved[..partial],
            payload[..partial],
            "existing no-clobber file must not be overwritten"
        );
        let fresh = dir.join("resume (1).zip");
        assert!(fresh.exists(), "auto-renamed target was not created");
        let fresh_bytes = std::fs::read(&fresh).unwrap();
        assert_eq!(fresh_bytes, payload, "auto-renamed download is corrupt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn segmented_resume_of_preallocated_parts_repairs_content() {
        use crate::daemon::types::Segment;
        use std::io::Write;
        let payload: Vec<u8> = (0..(1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_range_server(std::sync::Arc::new(payload.clone()));
        let url = format!("http://{addr}/seg.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_seg_{}", std::process::id()));
        let out = dir.join("seg.zip");
        std::fs::create_dir_all(&dir).unwrap();

        // Legacy artifacts: both part files preallocated to their full segment
        // size while only half of each part's real content was written.
        let expected_part = 512 * 1024usize;
        for idx in 0..2usize {
            let part = dir.join(format!("seg.zip.part{idx:03}"));
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&part)
                .unwrap();
            f.set_len(expected_part as u64).unwrap();
            let seg_start = idx * expected_part;
            f.write_all(&payload[seg_start..seg_start + expected_part / 2])
                .unwrap();
            f.sync_all().unwrap();
            drop(f);
        }

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "seg-resume-test";
        let body = download_body(&url, "seg.zip", payload.len() as u64, 2);
        let mut job = task_from_body(
            &body,
            id,
            "seg.zip".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        // Persisted per-segment progress from the interrupted legacy run: each
        // part was only half-real, so persisted bytes are below the segment size.
        job.task.segments = vec![
            Segment {
                id: 0,
                progress: 0.5,
                downloaded_bytes: (expected_part / 2) as u64,
                total_bytes: expected_part as u64,
                active: false,
                speed: 0,
                start_byte: 0,
                end_byte: expected_part as u64,
            },
            Segment {
                id: 1,
                progress: 0.5,
                downloaded_bytes: (expected_part / 2) as u64,
                total_bytes: expected_part as u64,
                active: false,
                speed: 0,
                start_byte: expected_part as u64,
                end_byte: (expected_part * 2) as u64,
            },
        ];
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(60));
        assert_eq!(task.size_bytes, payload.len() as u64);
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "preallocated partial parts were merged as garbage"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_generation_does_not_overwrite_newer_task_state() {
        // Regression for H8/C10: a worker that finished with an old generation
        // (after a redownload bumped it) must NOT overwrite the current state.
        let dir = std::env::temp_dir().join(format!("nova_test_gen_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "gen-test";
        let body = download_body("http://127.0.0.1:1/x.zip", "x.zip", 100, 1);
        let job = task_from_body(
            &body,
            id,
            "x.zip".to_string(),
            &dir.join("x.zip"),
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        // The current generation is 5 (simulating several redownloads).
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            if let Some(job) = jobs.get_mut(id) {
                job.run_generation
                    .store(5, std::sync::atomic::Ordering::Release);
                job.task.status = "downloading".to_owned();
            }
        }

        // A stale worker (generation 2) reports completion.
        mark_curl_task_finished(&state, id, 100, 2);

        // The newer task state must be untouched.
        let jobs = state.curl_jobs.lock().unwrap();
        let job = jobs.get(id).unwrap();
        assert_eq!(
            job.task.status, "downloading",
            "stale completion must not win"
        );
        assert_eq!(
            job.run_generation
                .load(std::sync::atomic::Ordering::Acquire),
            5
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pause_actually_stalls_bytes_and_resume_completes() {
        // H1 regression: pause_all() must stop the transfer from moving bytes
        // (the old bug turned paused into "unlimited"). A large payload keeps
        // the transfer running long enough to sample the stall even when the
        // test binary shares the machine with other parallel tests.
        let payload: Vec<u8> = (0..(16 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_range_server(std::sync::Arc::new(payload.clone()));
        let url = format!("http://{addr}/pause.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_pause_{}", std::process::id()));
        let out = dir.join("pause.zip");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "pause-test";
        let body = download_body(&url, "pause.zip", payload.len() as u64, 1);
        let job = task_from_body(
            &body,
            id,
            "pause.zip".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        let worker = std::thread::spawn(move || start_curl_process(&st, id));

        // Wait until some bytes have been written.
        let mut seen_any = false;
        for _ in 0..200 {
            let written = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            if written > 0 {
                seen_any = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(seen_any, "transfer never started writing");

        // Pause and sample the on-disk size — it must not grow. Wait for the
        // pause gate to actually engage (the worker may be mid-perform when
        // pause_all() is called) by requiring two consecutive stable reads.
        state.bandwidth_manager.pause_all();
        let mut frozen = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        let mut stable_reads = 0;
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let now = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            if now == frozen {
                stable_reads += 1;
                if stable_reads >= 2 {
                    break;
                }
            } else {
                frozen = now;
                stable_reads = 0;
            }
        }
        assert!(stable_reads >= 2, "transfer never stalled after pause");
        let after_pause = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        assert_eq!(
            after_pause, frozen,
            "paused transfer kept writing: before={frozen} after={after_pause}"
        );

        // Resume and let it complete.
        state.bandwidth_manager.resume_all();
        worker.join().unwrap();
        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "resumed download is corrupt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_rate_limit_change_takes_effect() {
        // M6 regression: changing the bandwidth limit mid-transfer must apply
        // immediately to the running easy handle. A tiny limit makes the
        // transfer crawl; a generous limit lets it finish.
        let payload: Vec<u8> = (0..(2 * 1024 * 1024)).map(|i| (i % 253) as u8).collect();
        let addr = spawn_range_server(std::sync::Arc::new(payload.clone()));
        let url = format!("http://{addr}/rate.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_rate_{}", std::process::id()));
        let out = dir.join("rate.zip");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "rate-test";
        let body = download_body(&url, "rate.zip", payload.len() as u64, 1);
        let job = task_from_body(
            &body,
            id,
            "rate.zip".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        // Start with a modest per-task cap (64 KB/s) and record how much
        // downloads in a fixed window — the cap must visibly throttle.
        state.bandwidth_manager.set_task_limit(id.into(), 64);
        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        std::thread::sleep(std::time::Duration::from_millis(500));
        let capped_size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        // 64 KB/s over 500ms ≈ 32 KB. Allow generous slack, but the transfer
        // must NOT have completed the full 2 MiB while capped.
        assert!(
            capped_size < 512 * 1024,
            "64 KB/s cap was not applied: wrote {capped_size} bytes in 500ms"
        );

        // Remove the cap — the transfer should now speed up and finish.
        state.bandwidth_manager.remove_task_limit(id);
        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(60));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "rate-limited download is corrupt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adaptive_segmented_download_grows_and_completes() {
        // Phase 5: the adaptive engine must drive real geometry growth on a
        // segmented download and the final file must match byte-for-byte.
        let payload: Vec<u8> = (0..(8 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_range_server(std::sync::Arc::new(payload.clone()));
        let url = format!("http://{addr}/adaptive.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_adaptive_{}", std::process::id()));
        let out = dir.join("adaptive.zip");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "adaptive-test";
        let body = download_body(&url, "adaptive.zip", payload.len() as u64, 2);
        let mut direct_options = std::collections::HashMap::new();
        // Force a fast evaluation interval so a decision is made during the run.
        direct_options.insert(
            "adaptiveEvalMs".to_string(),
            serde_json::Value::from(100u64),
        );
        let mut job = task_from_body(
            &body,
            id,
            "adaptive.zip".to_string(),
            &out,
            direct_options,
            Vec::new(),
        );
        // Make the segments small enough that growth is possible: 8 MiB with
        // min_segment_bytes from config (256 KiB) allows up to 32 segments.
        job.task.connections = 2;
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "adaptive download is corrupt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adaptive_rebuild_mid_transfer_grows_geometry_and_merges_cleanly() {
        // C-1 hardening: force a REAL geometry rebuild while bytes are still
        // flowing. The adaptive engine starts at 2 connections on a throttled
        // server; its profile recommends more connections for a 16 MiB file,
        // so the first evaluation emits AdjustConnections 2→4. The drive loop
        // then tears down and recreates every easy handle from the NEW engine
        // geometry (ids/ranges that no longer match the initial part files),
        // resumes from the on-disk truth, and must merge a byte-for-byte
        // identical file. This exercises the rebuild path the fast localhost
        // tests never reach (engine seeding, exclusive→inclusive ends, stale
        // part truncation, disk-truth resume).
        let payload: Vec<u8> = (0..(16 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let addr = spawn_slow_range_server(std::sync::Arc::new(payload.clone()), 16 * 1024, 4);
        let url = format!("http://{addr}/rebuild.zip");
        let dir = std::env::temp_dir().join(format!("nova_test_rebuild_{}", std::process::id()));
        let out = dir.join("rebuild.zip");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "rebuild-test";
        let body = download_body(&url, "rebuild.zip", payload.len() as u64, 2);
        let mut direct_options = std::collections::HashMap::new();
        direct_options.insert(
            "adaptiveEvalMs".to_string(),
            serde_json::Value::from(100u64),
        );
        // Shorten the rebuild debounce so the first geometry change happens
        // mid-transfer instead of being swallowed by the 10s default.
        direct_options.insert(
            "adaptiveRebuildMs".to_string(),
            serde_json::Value::from(100u64),
        );
        let mut job = task_from_body(
            &body,
            id,
            "rebuild.zip".to_string(),
            &out,
            direct_options,
            Vec::new(),
        );
        job.task.connections = 2;
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        // Watch the engine live while the transfer runs: the segment count
        // must grow beyond the initial 2 (proof a rebuild actually happened).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let mut max_segments = 2usize;
        let mut max_live_connections = 2u32;
        let task = loop {
            if let Ok(trackers) = state.engine_trackers.read() {
                if let Some(tracker) = trackers.get(id) {
                    max_live_connections = max_live_connections.max(tracker.adaptive.connections());
                    if let Ok(guard) = tracker.adaptive_engine.lock() {
                        if let Some(engine) = guard.as_ref() {
                            max_segments = max_segments.max(engine.segment_ctrl.segment_count());
                        }
                    }
                }
            }
            let task = {
                let jobs = state.curl_jobs.lock().unwrap();
                jobs.get(id).map(|j| j.task.clone()).unwrap()
            };
            match task.status.as_str() {
                "completed" => break task,
                "error" => panic!("task failed: {:?}", task.error_message),
                _ => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "timed out (downloaded={}, size={})",
                        task.downloaded_bytes,
                        task.size_bytes
                    );
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        };
        assert_eq!(task.status, "completed");
        assert!(
            max_segments > 2,
            "adaptive engine never rebuilt geometry mid-transfer (max segments {max_segments})"
        );
        assert!(
            max_live_connections > 2,
            "live connection count was never refreshed after adaptive rebuild (max {max_live_connections})"
        );
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written.len(),
            payload.len(),
            "post-rebuild merge length mismatch (len={}, expected={})",
            written.len(),
            payload.len()
        );
        if written != payload {
            let first_diff = written
                .iter()
                .zip(payload.iter())
                .position(|(a, b)| a != b)
                .unwrap_or(usize::MAX);
            assert_eq!(
                written, payload,
                "post-rebuild merge is corrupt (first diff at byte {first_diff})"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What a test interstitial server should answer for a request path.
    #[derive(Clone, Debug)]
    enum InterstitialResponse {
        /// Serve the given HTML page (an interstitial "thank you" page).
        Html(String),
        /// Serve an HTTP 404 with a REAL HTML error-page body — a dead mirror
        /// whose error page has `<html>` boilerplate AND page-furniture links
        /// (exercises the code>=400-before-is_html ordering: the error page's
        /// own links must NOT be followed ahead of the live mirror).
        NotFoundHtml(String),
        /// Serve an HTTP 404 with a plain-text body — a dead mirror that
        /// answers non-HTML (exercises the `code >= 400` fallback branch).
        NotFoundPlain,
        /// Serve a small, distinct non-payload body (a decoy logo) so a wrong
        /// follow of an error page's furniture link fails the byte assertion
        /// instead of silently succeeding with the real payload.
        DecoyLogo,
        /// Serve the binary payload with range support (the real file).
        File,
    }

    /// Serves a configurable HTML interstitial (Sublime/SourceForge/GitHub
    /// style download pages) that links the real file via plain `<a href>`
    /// anchors — no meta-refresh, no redirect — plus the actual file behind a
    /// range-capable endpoint. The `respond` closure maps a request path (and
    /// the server address, so HTML can embed absolute links) to a response.
    fn spawn_interstitial_server_with<F>(
        payload: std::sync::Arc<Vec<u8>>,
        respond: F,
    ) -> std::net::SocketAddr
    where
        F: Fn(std::net::SocketAddr, &str) -> InterstitialResponse + Send + Sync + 'static,
    {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let respond = std::sync::Arc::new(respond);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payload = payload.clone();
                let respond = respond.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let total = payload.len() as u64;
                    let mut range = None;
                    for line in req.lines() {
                        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            range = Some(rest.trim().to_string());
                            break;
                        }
                    }
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let send = |stream: &mut std::net::TcpStream, head: String, body: &[u8]| {
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(body);
                        let _ = stream.shutdown(Shutdown::Write);
                    };
                    match respond(addr, path) {
                        InterstitialResponse::Html(html) => {
                            // Interstitial: ignore Range, always serve the
                            // HTML page (absolute URLs so the engine can
                            // resolve them without knowing the host).
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    html.len()
                                ),
                                html.as_bytes(),
                            );
                            return;
                        }
                        InterstitialResponse::NotFoundHtml(html) => {
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 404 Not Found\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    html.len()
                                ),
                                html.as_bytes(),
                            );
                            return;
                        }
                        InterstitialResponse::NotFoundPlain => {
                            send(
                                &mut stream,
                                "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Length: 13\r\nConnection: close\r\n\r\n".to_string(),
                                b"404 not found",
                            );
                            return;
                        }
                        InterstitialResponse::DecoyLogo => {
                            const DECOY: &[u8] = b"DECOY-LOGO-NOT-THE-PAYLOAD";
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    DECOY.len()
                                ),
                                DECOY,
                            );
                            return;
                        }
                        InterstitialResponse::File => {}
                    }
                    match range {
                        Some(r) => {
                            let (s, e) = r.split_once('-').unwrap_or((r.as_str(), ""));
                            let start: u64 = s.trim().parse().unwrap_or(0);
                            if start >= total {
                                send(
                                    &mut stream,
                                    format!(
                                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                    ),
                                    b"",
                                );
                                return;
                            }
                            let end: u64 = if e.is_empty() {
                                total - 1
                            } else {
                                e.trim().parse().unwrap_or(total - 1)
                            };
                            let end = end.min(total - 1);
                            let body = &payload[start as usize..=end as usize];
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n",
                                    body.len()
                                ),
                                body,
                            );
                        }
                        None => send(
                            &mut stream,
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n"
                            ),
                            &payload,
                        ),
                    }
                });
            }
        });
        addr
    }

    #[test]
    fn html_interstitial_with_direct_link_downloads_real_file() {
        // Sublime-style case: the engine must follow a plain <a href> download
        // link on an HTML "thank you" page (no meta-refresh) and produce a
        // byte-for-byte identical file — not download the HTML page itself.
        let payload: Vec<u8> = (0..(4 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let payload_arc = std::sync::Arc::new(payload.clone());
        let addr = spawn_interstitial_server_with(payload_arc, |addr, path| {
            if path.starts_with("/thanks") {
                // Sublime-style "thank you" page linking the real file.
                InterstitialResponse::Html(format!(
                    "<!DOCTYPE html><html><head><title>Thanks</title></head><body>\n\
                     <a href=\"http://{addr}/app_setup.exe\">Download</a>\n\
                     <a href=\"http://{addr}/app_setup.exe.sig\">sig</a>\n\
                     </body></html>"
                ))
            } else {
                InterstitialResponse::File
            }
        });
        // The pasted URL has no recognizable extension, so it goes through the
        // full preflight loop where the interstitial is detected and followed.
        // It must match the server's `/thanks` interstitial branch — otherwise
        // the server would serve the payload directly and the interstitial
        // resolution path would never be exercised.
        let url = format!("http://{addr}/thanks?target=win-x64");
        let dir =
            std::env::temp_dir().join(format!("nova_test_interstitial_{}", std::process::id()));
        let out = dir.join("app_setup.exe");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "interstitial-test";
        let body = download_body(&url, "app_setup.exe", payload.len() as u64, 2);
        let job = task_from_body(
            &body,
            id,
            "app_setup.exe".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "interstitial download is corrupt");
        // The saved file must be the real file, not the HTML page.
        assert_eq!(written.len(), payload.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_interstitial_sourceforge_download_suffix_downloads_real_file() {
        // SourceForge-style case: the interstitial anchors end in a trailing
        // `/download` segment (`.../files/foo.exe/download?use_mirror=...`)
        // with no extension of their own. The engine must recognize the file
        // name before the suffix, follow it, and download the real payload.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let payload_arc = std::sync::Arc::new(payload.clone());
        let addr = spawn_interstitial_server_with(payload_arc, |addr, path| {
            if path.starts_with("/sf/thanks") {
                InterstitialResponse::Html(format!(
                    "<!DOCTYPE html><html><head><title>SourceForge</title></head><body>\n\
                     <a href=\"http://{addr}/files/app_setup.exe/download?use_mirror=autoselect\">Direct link</a>\n\
                     <a href=\"http://{addr}/files/app_setup.exe/download?use_mirror=mirror2\">Mirror 2</a>\n\
                     <a href=\"http://{addr}/files/app_setup.dmg/download\">mac</a>\n\
                     </body></html>"
                ))
            } else {
                InterstitialResponse::File
            }
        });
        let url = format!("http://{addr}/sf/thanks?target=win-x64");
        let dir = std::env::temp_dir().join(format!("nova_test_sf_{}", std::process::id()));
        let out = dir.join("app_setup.exe");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "sf-interstitial-test";
        let body = download_body(&url, "app_setup.exe", payload.len() as u64, 2);
        let job = task_from_body(
            &body,
            id,
            "app_setup.exe".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "sourceforge /download interstitial is corrupt"
        );
        assert_eq!(written.len(), payload.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_interstitial_github_host_rooted_anchors_downloads_real_file() {
        // GitHub release-style case: the interstitial links the assets via
        // host-rooted relative anchors (`/owner/repo/releases/download/...`).
        // The engine must resolve them against the page URL and download the
        // real payload.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let payload_arc = std::sync::Arc::new(payload.clone());
        let addr = spawn_interstitial_server_with(payload_arc, |_addr, path| {
            if path.starts_with("/gh/releases/tag") {
                InterstitialResponse::Html(
                    "<!DOCTYPE html><html><head><title>Releases</title></head><body>\n\
                     <a href=\"/gh/releases/download/v1.2.3/app-1.2.3-win-x64.exe\">win</a>\n\
                     <a href=\"/gh/releases/download/v1.2.3/app-1.2.3-mac.dmg\">mac</a>\n\
                     </body></html>"
                        .to_string(),
                )
            } else {
                InterstitialResponse::File
            }
        });
        let url = format!("http://{addr}/gh/releases/tag/v1.2.3");
        let dir = std::env::temp_dir().join(format!("nova_test_gh_{}", std::process::id()));
        let out = dir.join("app.exe");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "gh-interstitial-test";
        let body = download_body(&url, "app.exe", payload.len() as u64, 2);
        let job = task_from_body(
            &body,
            id,
            "app.exe".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "github host-rooted interstitial is corrupt"
        );
        assert_eq!(written.len(), payload.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_interstitial_dead_first_candidate_falls_back() {
        // Multi-candidate fallback: the top-ranked direct link is dead (404),
        // but a second anchor on the page points at the real file. The engine
        // must fall back to the next candidate instead of failing the task.
        // The dead mirror answers with a REAL HTML error page (`<html>`
        // boilerplate plus a page-furniture link to a decoy logo): the resolve
        // loop must honor the 404 BEFORE parsing the error page, otherwise it
        // would follow the error page's own `logo.png` link and download the
        // decoy instead of the live mirror.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let payload_arc = std::sync::Arc::new(payload.clone());
        let addr = spawn_interstitial_server_with(payload_arc, |addr, path| {
            if path.starts_with("/thanks") {
                InterstitialResponse::Html(format!(
                    "<!DOCTYPE html><html><head><title>Mirrors</title></head><body>\n\
                     <a href=\"http://{addr}/dead/app_setup.exe\">dead mirror</a>\n\
                     <a href=\"http://{addr}/live/app_setup.exe\">live mirror</a>\n\
                     </body></html>"
                ))
            } else if path.starts_with("/dead/") {
                // A real HTML 404 error page: boilerplate AND a furniture link
                // to /logo.png. If the engine parsed the error page before
                // honoring the 404, it would follow the logo and download the
                // decoy bytes (test fails on the payload comparison).
                InterstitialResponse::NotFoundHtml(format!(
                    "<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>\n\
                     <h1>Not Found</h1>\n\
                     <a href=\"http://{addr}/logo.png\"><img src=\"http://{addr}/logo.png\"></a>\n\
                     </body></html>"
                ))
            } else if path.starts_with("/logo.png") {
                InterstitialResponse::DecoyLogo
            } else {
                InterstitialResponse::File
            }
        });
        let url = format!("http://{addr}/thanks?target=win-x64");
        let dir = std::env::temp_dir().join(format!("nova_test_fallback_{}", std::process::id()));
        let out = dir.join("app_setup.exe");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "fallback-test";
        let body = download_body(&url, "app_setup.exe", payload.len() as u64, 2);
        let job = task_from_body(
            &body,
            id,
            "app_setup.exe".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(written, payload, "dead-first fallback download is corrupt");
        assert_eq!(written.len(), payload.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_interstitial_dead_first_candidate_non_html_404_falls_back() {
        // Same fallback, but the dead mirror answers with a plain-text 404
        // (not an HTML error page). This exercises the `code >= 400` fallback
        // branch in the preflight loop, which must also skip to the next
        // ranked candidate instead of failing the task.
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let payload_arc = std::sync::Arc::new(payload.clone());
        let addr = spawn_interstitial_server_with(payload_arc, |addr, path| {
            if path.starts_with("/thanks") {
                InterstitialResponse::Html(format!(
                    "<!DOCTYPE html><html><head><title>Mirrors</title></head><body>\n\
                     <a href=\"http://{addr}/dead/app_setup.exe\">dead mirror</a>\n\
                     <a href=\"http://{addr}/live/app_setup.exe\">live mirror</a>\n\
                     </body></html>"
                ))
            } else if path.starts_with("/dead/") {
                InterstitialResponse::NotFoundPlain
            } else {
                InterstitialResponse::File
            }
        });
        let url = format!("http://{addr}/thanks?target=win-x64");
        let dir =
            std::env::temp_dir().join(format!("nova_test_fallback404_{}", std::process::id()));
        let out = dir.join("app_setup.exe");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "fallback404-test";
        let body = download_body(&url, "app_setup.exe", payload.len() as u64, 2);
        let job = task_from_body(
            &body,
            id,
            "app_setup.exe".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "non-html-404 fallback download is corrupt"
        );
        assert_eq!(written.len(), payload.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn meta_refresh_interstitial_follows_to_real_file() {
        // VideoLAN-style case: the download URL ends with .exe (fast-path
        // territory) but the server answers browser-like probes with an HTML
        // interstitial carrying a meta-refresh. The engine must follow the
        // refresh target and download the real file, not the HTML page.
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener};
        let payload: Vec<u8> = (0..(3 * 1024 * 1024)).map(|i| (i % 251) as u8).collect();
        let payload_arc = std::sync::Arc::new(payload.clone());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let payload = payload_arc.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let total = payload.len() as u64;
                    let send = |stream: &mut std::net::TcpStream, head: String, body: &[u8]| {
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(body);
                        let _ = stream.shutdown(Shutdown::Write);
                    };
                    if path.ends_with(".exe") || path.contains("vlc") {
                        // Interstitial for the .exe path (mirrors get.videolan.org
                        // behaviour): meta-refresh + direct mirror links.
                        let html = format!(
                            "<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" \
                             content=\"5;URL='http://{addr}/real/file.bin'\" /></head>\
                             <body><a href=\"http://{addr}/real/file.bin\">mirror</a></body></html>"
                        );
                        send(
                            &mut stream,
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                html.len()
                            ),
                            html.as_bytes(),
                        );
                        return;
                    }
                    let mut range = None;
                    for line in req.lines() {
                        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("range: bytes=")
                        {
                            range = Some(rest.trim().to_string());
                            break;
                        }
                    }
                    match range {
                        Some(r) => {
                            let (s, e) = r.split_once('-').unwrap_or((r.as_str(), ""));
                            let start: u64 = s.trim().parse().unwrap_or(0);
                            if start >= total {
                                send(
                                    &mut stream,
                                    format!(
                                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                    ),
                                    b"",
                                );
                                return;
                            }
                            let end: u64 = if e.is_empty() {
                                total - 1
                            } else {
                                e.trim().parse().unwrap_or(total - 1)
                            };
                            let end = end.min(total - 1);
                            let body = &payload[start as usize..=end as usize];
                            send(
                                &mut stream,
                                format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n",
                                    body.len()
                                ),
                                body,
                            );
                        }
                        None => send(
                            &mut stream,
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nAccept-Ranges: bytes\r\nETag: \"nova-test\"\r\nConnection: close\r\n\r\n"
                            ),
                            &payload,
                        ),
                    }
                });
            }
        });
        let url = format!("http://{addr}/vlc/3.0.23/win64/vlc-3.0.23-win64.exe");
        let dir = std::env::temp_dir().join(format!("nova_test_mrefresh_{}", std::process::id()));
        let out = dir.join("vlc.exe");
        std::fs::create_dir_all(&dir).unwrap();

        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));
        let id = "mrefresh-test";
        let body = download_body(&url, "vlc.exe", payload.len() as u64, 2);
        let job = task_from_body(
            &body,
            id,
            "vlc.exe".to_string(),
            &out,
            std::collections::HashMap::new(),
            Vec::new(),
        );
        {
            let mut jobs = state.curl_jobs.lock().unwrap();
            jobs.insert(id.to_string(), job);
        }
        state.mark_dirty();

        let st = state.clone();
        std::thread::spawn(move || start_curl_process(&st, id));

        let task = run_task_to_completion(&state, id, std::time::Duration::from_secs(120));
        assert_eq!(task.status, "completed");
        let written = std::fs::read(&out).unwrap();
        assert_eq!(
            written, payload,
            "meta-refresh interstitial download is corrupt"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
