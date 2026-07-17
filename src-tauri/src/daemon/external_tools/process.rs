use super::types::ProcessSpec;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
    pub exit_code: i32,
    pub duration: Duration,
}

pub fn run_tool(
    spec: &ProcessSpec,
    working_dir: Option<&PathBuf>,
) -> Result<ProcessOutput, String> {
    let started = Instant::now();

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", spec.program, e))?;

    let output = if let Some(_timeout) = spec.timeout {
        match child.wait_with_output() {
            Ok(o) => o,
            Err(e) => {
                return Err(format!("Process wait failed: {}", e));
            }
        }
    } else {
        child
            .wait_with_output()
            .map_err(|e| format!("Process wait failed: {}", e))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let elapsed = started.elapsed();
    if let Some(timeout) = spec.timeout {
        if elapsed > timeout {
            return Err(format!("Process timed out after {:?}", timeout));
        }
    }

    Ok(ProcessOutput {
        stdout,
        stderr,
        success: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        duration: elapsed,
    })
}

pub fn run_tool_capture(
    program: &str,
    args: &[&str],
    timeout: Option<Duration>,
) -> Result<ProcessOutput, String> {
    run_tool(
        &ProcessSpec {
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            timeout,
        },
        None,
    )
}
