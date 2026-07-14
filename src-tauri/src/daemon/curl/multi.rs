use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ::curl::easy::Handler;
use ::curl::multi::{Easy2Handle, Events, Multi, Socket, WaitFd};

use super::*;
use crate::daemon::direct::ConnectionLimits;

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
                multi
                    .assign(update.socket, token)
                    .map_err(|e| format!("Could not assign libcurl socket token: {e}"))?;
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
                    errors.push(error.to_string());
                } else {
                    errors.push(format!("{} {}: {}", label, idx, error));
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
        .map_err(|e| format!("libcurl multi perform failed: {e}"))?;
    while running > 0 {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_string());
        }
        multi
            .wait(&mut [], Duration::from_millis(PROGRESS_INTERVAL_MS))
            .map_err(|e| format!("libcurl multi wait failed: {e}"))?;
        tick();
        running = multi
            .perform()
            .map_err(|e| format!("libcurl multi perform failed: {e}"))?;
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
            .map_err(|e| format!("libcurl multi timeout action failed: {e}"))?;
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
                .map_err(|e| format!("libcurl multi timeout action failed: {e}"))?;
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
            .map_err(|e| format!("libcurl multi socket wait failed: {e}"))?;

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
                    .map_err(|e| format!("libcurl multi socket action failed: {e}"))?;
                runtime.drain_updates(multi)?;
            }
        }

        if wait_fds.is_empty() || ready_count == 0 {
            running = multi
                .timeout()
                .map_err(|e| format!("libcurl multi timeout action failed: {e}"))?;
            runtime.drain_updates(multi)?;
        } else if dispatched == 0 {
            for (idx, interest) in interests.iter().enumerate() {
                let mut events = Events::new();
                events.input(interest.input);
                events.output(interest.output);
                running = multi
                    .action(sockets[idx], &events)
                    .map_err(|e| format!("libcurl multi socket action failed: {e}"))?;
                runtime.drain_updates(multi)?;
            }
        }

        tick();
        check_multi_messages(multi, handles, label)?;
    }

    tick();
    check_multi_messages(multi, handles, label)
}
