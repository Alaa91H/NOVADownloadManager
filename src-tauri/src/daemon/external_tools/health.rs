use super::types::{ExternalTool, ToolId, ToolStatus};
use crate::daemon::utils::hide_command_window;
use std::io::Read;
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct HealthReport {
    pub tool_id: ToolId,
    pub status: ToolStatus,
    pub executable_works: bool,
    pub version_detected: Option<String>,
    pub version_compatible: bool,
    pub capabilities_detected: bool,
    pub error_message: Option<String>,
    pub check_duration: Duration,
}

pub fn check_health(tool: &dyn ExternalTool, path: &std::path::Path) -> HealthReport {
    let started = Instant::now();
    let mut report = HealthReport {
        tool_id: tool.id(),
        status: ToolStatus::Unknown,
        executable_works: false,
        version_detected: None,
        version_compatible: false,
        capabilities_detected: false,
        error_message: None,
        check_duration: Duration::ZERO,
    };

    if !path.exists() {
        report.status = ToolStatus::NotInstalled;
        report.error_message = Some(format!("Executable not found at {}", path.display()));
        report.check_duration = started.elapsed();
        return report;
    }

    match run_version_check(tool, path) {
        Ok(output) => {
            report.executable_works = true;
            if let Some(version) = tool.parse_version(&output) {
                report.version_detected = Some(version.to_string());
                report.version_compatible = version.is_compatible_with(&tool.minimum_version());
                if report.version_compatible {
                    report.status = ToolStatus::Installed;
                    report.capabilities_detected = true;
                } else {
                    report.status = ToolStatus::Incompatible;
                    report.error_message = Some(format!(
                        "Version {} is below minimum required {}",
                        version,
                        tool.minimum_version()
                    ));
                }
            } else {
                report.executable_works = true;
                report.status = ToolStatus::Broken;
                report.error_message = Some("Could not parse version from output".to_owned());
            }
        }
        Err(e) => {
            report.error_message = Some(e);
            if path.exists() {
                report.status = ToolStatus::Broken;
            } else {
                report.status = ToolStatus::NotInstalled;
            }
        }
    }

    report.check_duration = started.elapsed();
    report
}

fn run_version_check(tool: &dyn ExternalTool, path: &std::path::Path) -> Result<String, String> {
    let timeout = tool.version_command_timeout();
    let args = tool.version_args();

    let mut cmd = Command::new(path);
    cmd.args(args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    hide_command_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute {}: {}", path.display(), e))?;

    let deadline = Instant::now() + timeout;

    // Read stdout and stderr concurrently to prevent pipe-buffer deadlock
    let (tx, rx) = mpsc::channel();
    let stdout_thread = child.stdout.take().map(|mut r| {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            let _ = tx.send(("stdout", buf));
        })
    });
    let stderr_thread = child.stderr.take().map(|mut r| {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            let _ = tx.send(("stderr", buf));
        })
    });
    // Drop the original sender so the channel closes when reader threads finish
    drop(tx);

    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Join reader threads after kill/wait so pipes close and they unblock
                    if let Some(h) = stdout_thread {
                        let _ = h.join();
                    }
                    if let Some(h) = stderr_thread {
                        let _ = h.join();
                    }
                    return Err(format!("Version check timed out after {timeout:?}"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Version check failed: {e}")),
        }
    };

    // Join reader threads after the child has exited to ensure pipes are drained
    if let Some(h) = stdout_thread {
        let _ = h.join();
    }
    if let Some(h) = stderr_thread {
        let _ = h.join();
    }

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    for (kind, buf) in &rx {
        match kind {
            "stdout" => stdout_buf = buf,
            "stderr" => stderr_buf = buf,
            _ => {}
        }
    }
    let output = std::process::Output {
        status,
        stdout: stdout_buf,
        stderr: stderr_buf,
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            return Err(format!("Version command failed: {}", stderr.trim()));
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Err("Version command returned empty output".to_owned());
    }

    Ok(stdout)
}

#[allow(dead_code)]
pub fn probe_capabilities(tool: &dyn ExternalTool, path: &std::path::Path) -> Vec<String> {
    if !path.exists() {
        return Vec::new();
    }
    tool.capabilities().into_iter().map(|c| c.id).collect()
}
