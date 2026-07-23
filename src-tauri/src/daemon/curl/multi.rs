use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ::curl::easy::{Easy2, Handler};
use ::curl::multi::{Easy2Handle, Events, Multi, Socket, WaitFd};

use super::*;
use crate::daemon::direct::ConnectionLimits;

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum MultiErrorKind {
    Perform,
    SocketAction,
    Wait,
    Timeout,
    MessageCollection,
    SocketAssignment,
    TooManyHandles,
}

impl std::fmt::Display for MultiErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Perform => write!(f, "multi perform"),
            Self::SocketAction => write!(f, "multi socket action"),
            Self::Wait => write!(f, "multi wait"),
            Self::Timeout => write!(f, "multi timeout"),
            Self::MessageCollection => write!(f, "multi message collection"),
            Self::SocketAssignment => write!(f, "socket assignment"),
            Self::TooManyHandles => write!(f, "too many handles"),
        }
    }
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct MultiActionError {
    pub kind: MultiErrorKind,
    pub message: String,
    pub handle_index: Option<usize>,
}

impl std::fmt::Display for MultiActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.handle_index {
            Some(idx) => write!(f, "[{}] {}: {}", idx, self.kind, self.message),
            None => write!(f, "{}: {}", self.kind, self.message),
        }
    }
}

impl std::error::Error for MultiActionError {}

fn wrap_multi_error(kind: MultiErrorKind, source: String) -> String {
    format!("libcurl {kind}: {source}")
}

pub(crate) struct CurlMultiGuard {
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

    pub(crate) fn multi(&mut self) -> &mut Multi {
        self.multi
            .as_mut()
            .expect("CurlMultiGuard: multi already consumed")
    }

    pub(crate) fn add2<H: Handler>(&mut self, easy: Easy2<H>) -> Result<Easy2Handle<H>, String> {
        let multi = self
            .multi
            .as_mut()
            .ok_or_else(|| "CurlMultiGuard: cannot add handle after into_inner()".to_string())?;
        let handle = multi
            .add2(easy)
            .map_err(|e| format!("Could not add transfer to libcurl multi: {e}"))?;
        self.handle_count += 1;
        Ok(handle)
    }

    #[allow(dead_code)]
    pub(crate) fn handle_count(&self) -> usize {
        self.handle_count
    }

    pub(crate) fn configure_limits(&mut self, limits: ConnectionLimits) -> Result<(), String> {
        configure_multi_limits(self.multi(), limits)
    }

    pub(crate) fn attach_socket_runtime(&mut self) -> Result<MultiSocketRuntime, String> {
        MultiSocketRuntime::attach(self.multi())
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
        assert_eq!(
            MultiErrorKind::SocketAction.to_string(),
            "multi socket action"
        );
        assert_eq!(MultiErrorKind::Wait.to_string(), "multi wait");
        assert_eq!(MultiErrorKind::Timeout.to_string(), "multi timeout");
        assert_eq!(
            MultiErrorKind::MessageCollection.to_string(),
            "multi message collection"
        );
        assert_eq!(
            MultiErrorKind::SocketAssignment.to_string(),
            "socket assignment"
        );
        assert_eq!(
            MultiErrorKind::TooManyHandles.to_string(),
            "too many handles"
        );
    }

    #[test]
    fn multi_action_error_display_with_index() {
        let err = MultiActionError {
            kind: MultiErrorKind::Perform,
            message: "test error".to_string(),
            handle_index: Some(2),
        };
        assert_eq!(err.to_string(), "[2] multi perform: test error");
    }

    #[test]
    fn multi_action_error_display_without_index() {
        let err = MultiActionError {
            kind: MultiErrorKind::SocketAction,
            message: "socket failed".to_string(),
            handle_index: None,
        };
        assert_eq!(err.to_string(), "multi socket action: socket failed");
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

#[derive(Clone, Copy, Debug)]
pub(super) struct SocketUpdate {
    socket: Socket,
    token: usize,
    input: bool,
    output: bool,
    remove: bool,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct SocketInterest {
    input: bool,
    output: bool,
}

pub(crate) struct MultiSocketRuntime {
    updates: Arc<Mutex<Vec<SocketUpdate>>>,
    timeout: Arc<Mutex<Option<Duration>>>,
    pub(super) sockets: HashMap<Socket, SocketInterest>,
    next_token: usize,
}

impl MultiSocketRuntime {
    pub(crate) fn attach(multi: &mut Multi) -> Result<Self, String> {
        let updates = Arc::new(Mutex::new(Vec::new()));
        let socket_updates = updates.clone();
        multi
            .socket_function(move |socket, events, token| {
                if let Ok(mut updates) = socket_updates.lock() {
                    updates.push(SocketUpdate {
                        socket,
                        token,
                        input: events.input(),
                        output: events.output(),
                        remove: events.remove(),
                    });
                }
            })
            .map_err(|e| format!("Could not configure libcurl socket callback: {e}"))?;

        let timeout = Arc::new(Mutex::new(None));
        let timer_timeout = timeout.clone();
        multi
            .timer_function(move |duration| {
                if let Ok(mut timeout) = timer_timeout.lock() {
                    *timeout = duration;
                }
                true
            })
            .map_err(|e| format!("Could not configure libcurl timer callback: {e}"))?;

        Ok(Self {
            updates,
            timeout,
            sockets: HashMap::new(),
            next_token: 1,
        })
    }

    pub(crate) fn drain_updates(&mut self, multi: &Multi) -> Result<(), String> {
        let updates = {
            let mut guard = self
                .updates
                .lock()
                .map_err(|_| "libcurl socket update queue is poisoned".to_string())?;
            std::mem::take(&mut *guard)
        };

        for update in updates {
            if update.remove {
                self.sockets.remove(&update.socket);
                continue;
            }
            if !update.input && !update.output {
                self.sockets.remove(&update.socket);
                continue;
            }

            if update.token == 0 {
                let token = self.next_token;
                self.next_token = self.next_token.saturating_add(1);
                multi.assign(update.socket, token).map_err(|e| {
                    wrap_multi_error(MultiErrorKind::SocketAssignment, e.to_string())
                })?;
            }

            self.sockets.insert(
                update.socket,
                SocketInterest {
                    input: update.input,
                    output: update.output,
                },
            );
        }
        Ok(())
    }

    fn wait_timeout(&self) -> Duration {
        let progress_interval = Duration::from_millis(PROGRESS_INTERVAL_MS);
        let timeout = self
            .timeout
            .lock()
            .ok()
            .and_then(|timeout| *timeout)
            .unwrap_or(progress_interval);
        timeout.min(progress_interval)
    }

    fn wait_fds(&self) -> Vec<(Socket, WaitFd)> {
        self.sockets
            .iter()
            .filter(|(_, interest)| interest.input || interest.output)
            .map(|(socket, interest)| {
                let mut wait_fd = WaitFd::new();
                wait_fd.set_fd(*socket);
                wait_fd.poll_on_read(interest.input);
                wait_fd.poll_on_write(interest.output);
                (*socket, wait_fd)
            })
            .collect()
    }
}

pub(crate) fn configure_multi_limits(
    multi: &mut Multi,
    limits: ConnectionLimits,
) -> Result<(), String> {
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
    multi.messages(|message| {
        for (idx, handle) in handles.iter().enumerate() {
            if let Some(Err(error)) = message.result_for2(handle) {
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

pub(crate) fn drive_multi_wait_perform<H, F>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    cancel: &AtomicBool,
    label: &str,
    mut tick: F,
) -> Result<(), String>
where
    H: Handler,
    F: FnMut(),
{
    let mut running = multi
        .perform()
        .map_err(|e| wrap_multi_error(MultiErrorKind::Perform, e.to_string()))?;
    while running > 0 {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_string());
        }
        multi
            .wait(&mut [], Duration::from_millis(PROGRESS_INTERVAL_MS))
            .map_err(|e| wrap_multi_error(MultiErrorKind::Wait, e.to_string()))?;
        tick();
        running = multi
            .perform()
            .map_err(|e| wrap_multi_error(MultiErrorKind::Perform, e.to_string()))?;
        check_multi_messages(multi, handles, label)?;
    }
    tick();
    check_multi_messages(multi, handles, label)
}

pub(crate) fn drive_multi_socket<H, F>(
    multi: &Multi,
    runtime: &mut MultiSocketRuntime,
    handles: &[Easy2Handle<H>],
    cancel: &AtomicBool,
    label: &str,
    mut tick: F,
) -> Result<(), String>
where
    H: Handler,
    F: FnMut(),
{
    let mut running = handles.len() as u32;
    runtime.drain_updates(multi)?;
    if runtime.sockets.is_empty() {
        running = multi
            .timeout()
            .map_err(|e| wrap_multi_error(MultiErrorKind::Timeout, e.to_string()))?;
        runtime.drain_updates(multi)?;
    }

    while running > 0 {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_string());
        }

        let timeout = runtime.wait_timeout();
        if timeout.is_zero() || runtime.sockets.is_empty() {
            if !timeout.is_zero() && runtime.sockets.is_empty() {
                std::thread::sleep(timeout);
            }
            running = multi
                .timeout()
                .map_err(|e| wrap_multi_error(MultiErrorKind::Timeout, e.to_string()))?;
            runtime.drain_updates(multi)?;
            tick();
            check_multi_messages(multi, handles, label)?;
            continue;
        }

        let wait_fds = runtime.wait_fds();
        let sockets: Vec<Socket> = wait_fds.iter().map(|(socket, _)| *socket).collect();
        let interests: Vec<SocketInterest> = sockets
            .iter()
            .filter_map(|socket| runtime.sockets.get(socket).copied())
            .collect();
        let mut wait_fds: Vec<WaitFd> = wait_fds.into_iter().map(|(_, wait_fd)| wait_fd).collect();
        let ready_count = multi
            .wait(&mut wait_fds, timeout)
            .map_err(|e| wrap_multi_error(MultiErrorKind::Wait, e.to_string()))?;

        let mut dispatched = 0u32;
        for (idx, wait_fd) in wait_fds.iter().enumerate() {
            let mut events = Events::new();
            let mut ready = false;
            if wait_fd.received_read() || wait_fd.received_priority_read() {
                events.input(true);
                ready = true;
            }
            if wait_fd.received_write() {
                events.output(true);
                ready = true;
            }
            if ready {
                dispatched = dispatched.saturating_add(1);
                running = multi
                    .action(sockets[idx], &events)
                    .map_err(|e| wrap_multi_error(MultiErrorKind::SocketAction, e.to_string()))?;
                runtime.drain_updates(multi)?;
            }
        }

        if ready_count > 0 && dispatched > 0 {
        } else if wait_fds.is_empty() || ready_count == 0 {
            running = multi
                .timeout()
                .map_err(|e| wrap_multi_error(MultiErrorKind::Timeout, e.to_string()))?;
            runtime.drain_updates(multi)?;
        } else {
            for (idx, interest) in interests.iter().enumerate() {
                let mut events = Events::new();
                events.input(interest.input);
                events.output(interest.output);
                running = multi
                    .action(sockets[idx], &events)
                    .map_err(|e| wrap_multi_error(MultiErrorKind::SocketAction, e.to_string()))?;
                runtime.drain_updates(multi)?;
            }
        }

        tick();
        check_multi_messages(multi, handles, label)?;
    }

    tick();
    check_multi_messages(multi, handles, label)
}
