use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use ::curl::easy::{Easy2, Handler};
use ::curl::multi::{Easy2Handle, Multi};

use super::{AtomicBool, PROGRESS_INTERVAL_MS};
use crate::daemon::direct::ConnectionLimits;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MultiErrorKind {
    Perform,
    Wait,
}

impl std::fmt::Display for MultiErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Perform => write!(f, "multi perform"),
            Self::Wait => write!(f, "multi wait"),
        }
    }
}

fn wrap_multi_error(kind: MultiErrorKind, source: String) -> String {
    format!("libcurl {kind}: {source}")
}

pub struct CurlMultiGuard {
    multi: Option<Multi>,
    handle_count: usize,
}

impl CurlMultiGuard {
    pub(crate) fn new() -> Self {
        Self {
            multi: Some(Multi::new()),
            handle_count: 0,
        }
    }

    pub(crate) fn multi(&mut self) -> Result<&mut Multi, String> {
        self.multi.as_mut().ok_or_else(|| {
            "CurlMultiGuard: multi handle has already been consumed via into_inner()".to_owned()
        })
    }

    pub(crate) fn add2<H: Handler>(&mut self, easy: Easy2<H>) -> Result<Easy2Handle<H>, String> {
        let multi = self
            .multi
            .as_mut()
            .ok_or_else(|| "CurlMultiGuard: cannot add handle after into_inner()".to_owned())?;
        let mut handle = multi
            .add2(easy)
            .map_err(|e| format!("Could not add transfer to libcurl multi: {e}"))?;
        // Assign a per-handle token (1..=n in insertion order) so completion
        // messages can be mapped back to their handle in O(1) instead of
        // scanning every handle (see collect_multi_errors).
        handle
            .set_token(self.handle_count + 1)
            .map_err(|e| format!("Could not assign token to libcurl handle: {e}"))?;
        self.handle_count += 1;
        Ok(handle)
    }

    #[cfg(test)]
    pub(crate) fn handle_count(&self) -> usize {
        self.handle_count
    }

    pub(crate) fn configure_limits(&mut self, limits: ConnectionLimits) -> Result<(), String> {
        configure_multi_limits(self.multi()?, limits)
    }

    /// Remove a live easy handle from the multi handle, returning the easy
    /// handle for reuse/cleanup (phase 5: adaptive shrink).
    pub(crate) fn remove<H: Handler>(
        &mut self,
        handle: Easy2Handle<H>,
    ) -> Result<Easy2<H>, String> {
        let multi = self
            .multi
            .as_mut()
            .ok_or_else(|| "CurlMultiGuard: cannot remove handle after into_inner()".to_owned())?;
        multi
            .remove2(handle)
            .map_err(|e| format!("Could not remove handle from libcurl multi: {e}"))
    }
}

impl Drop for CurlMultiGuard {
    fn drop(&mut self) {
        if self.handle_count > 0 {
            log::debug!(
                "CurlMultiGuard dropping with {} handles still registered; \
                 libcurl will clean up automatically",
                self.handle_count
            );
        }
        self.multi.take();
    }
}

pub fn configure_multi_limits(multi: &mut Multi, limits: ConnectionLimits) -> Result<(), String> {
    multi
        .set_max_total_connections(limits.total)
        .map_err(|e| format!("Could not configure total libcurl connections: {e}"))?;
    multi
        .set_max_host_connections(limits.per_host)
        .map_err(|e| format!("Could not configure host libcurl connections: {e}"))?;
    multi
        .set_max_connects(limits.cache)
        .map_err(|e| format!("Could not configure libcurl connection cache: {e}"))?;
    Ok(())
}

fn collect_multi_errors<H: Handler>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    label: &str,
) -> Vec<String> {
    let mut errors = Vec::new();
    // `CurlMultiGuard::add2` assigns tokens 1..=n in insertion order, so the
    // token of `handles[idx]` is `idx + 1`. Building this map once turns the
    // message→handle lookup from O(handles) per message into O(1), avoiding
    // O(n*m) work with many segments.
    let by_token: HashMap<usize, usize> = (0..handles.len()).map(|idx| (idx + 1, idx)).collect();
    multi.messages(|message| {
        // Messages from handles that were never token-assigned carry token 0
        // and simply match no entry.
        let token = message.token().unwrap_or(0);
        if let Some(&idx) = by_token.get(&token) {
            if let Some(Err(error)) = message.result_for2(&handles[idx]) {
                if handles.len() == 1 {
                    errors.push(format!("[{label}] {error}"));
                } else {
                    errors.push(format!("[{label}:{idx}] {error}"));
                }
            }
        }
    });
    errors
}

fn check_multi_messages<H: Handler>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    label: &str,
) -> Result<(), String> {
    let errors = collect_multi_errors(multi, handles, label);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Drive a libcurl multi handle until every transfer completes, cancellation
/// occurs, or `stop_when` requests that the caller reclaim the live handles.
///
/// A `true` result means the caller requested the stop. This is deliberately
/// checked immediately after `tick`: adaptive transfer logic records a new
/// segment geometry during that callback, and continuing with `perform` would
/// otherwise keep the old easy handles alive until the entire download ended.
pub fn drive_multi_wait_perform_until<H, F, S>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    cancel: &AtomicBool,
    label: &str,
    mut tick: F,
    paused: &AtomicBool,
    mut stop_when: S,
) -> Result<bool, String>
where
    H: Handler,
    F: FnMut(),
    S: FnMut() -> bool,
{
    let mut running = multi
        .perform()
        .map_err(|e| wrap_multi_error(MultiErrorKind::Perform, e.to_string()))?;
    while running > 0 {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        if paused.load(Ordering::Acquire) {
            // Pause gate: do NOT call perform/action so no bytes move while
            // paused. Sleep briefly and keep ticking so the UI stays fresh and
            // resume is detected promptly.
            std::thread::sleep(Duration::from_millis(PROGRESS_INTERVAL_MS));
            tick();
            if stop_when() {
                return Ok(true);
            }
            continue;
        }
        multi
            .wait(&mut [], Duration::from_millis(PROGRESS_INTERVAL_MS))
            .map_err(|e| wrap_multi_error(MultiErrorKind::Wait, e.to_string()))?;
        tick();
        // Stop before another perform call so the caller can remove/rebuild the
        // old handles while their byte ranges still correspond to disk state.
        if stop_when() {
            return Ok(true);
        }
        running = multi
            .perform()
            .map_err(|e| wrap_multi_error(MultiErrorKind::Perform, e.to_string()))?;
        check_multi_messages(multi, handles, label)?;
    }
    tick();
    check_multi_messages(multi, handles, label)?;
    Ok(false)
}

pub fn drive_multi_wait_perform<H, F>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    cancel: &AtomicBool,
    label: &str,
    tick: F,
    paused: &AtomicBool,
) -> Result<(), String>
where
    H: Handler,
    F: FnMut(),
{
    drive_multi_wait_perform_until(multi, handles, cancel, label, tick, paused, || false)
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_guard_new_has_zero_handles() {
        let guard = CurlMultiGuard::new();
        assert_eq!(guard.handle_count(), 0);
    }

    #[test]
    fn multi_guard_error_kind_display() {
        assert_eq!(MultiErrorKind::Perform.to_string(), "multi perform");
        assert_eq!(MultiErrorKind::Wait.to_string(), "multi wait");
    }

    #[test]
    fn multi_guard_drop_logs_when_handles_registered() {
        let guard = CurlMultiGuard::new();
        assert_eq!(guard.handle_count(), 0);
        drop(guard);
    }

    #[test]
    fn multi_guard_configure_limits_succeeds() {
        let mut guard = CurlMultiGuard::new();
        let limits = ConnectionLimits {
            total: 4,
            per_host: 2,
            cache: 8,
        };
        assert!(guard.configure_limits(limits).is_ok());
    }

    #[test]
    fn connection_limits_from_config() {
        use crate::daemon::engine::config::global_config;
        let limits = global_config().connection_limits_for(4, "https://example.com/file");
        assert!(limits.total >= 1);
        assert!(limits.total <= 128);
        assert!(limits.per_host >= 1);
        assert!(limits.cache >= limits.total);
    }

    #[test]
    fn connection_limits_clamp_to_config() {
        use crate::daemon::engine::config::global_config;
        let limits = global_config().connection_limits_for(1000, "https://example.com/file");
        let cfg = global_config();
        assert!(limits.total <= cfg.max_connections_per_download as usize);
        assert!(limits.per_host <= limits.total);
        assert!(limits.total >= 1);
        assert!(limits.per_host >= 1);
    }
}
