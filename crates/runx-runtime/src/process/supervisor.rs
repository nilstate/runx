use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use wait_timeout::ChildExt;

use super::capture::{CaptureHandle, capture_pipe, join_capture};
use super::configure_process_group;
#[cfg(unix)]
use super::resource_limits::{resource_limit_shell, resource_limit_shell_args};
use super::signals::ProcessSignal;
use super::timeout::signal_timed_out_process;
use super::{ProcessOutcome, ProcessSpec, ProcessStdin, ProcessSupervisorError};

const DEFAULT_FORCE_KILL_GRACE: Duration = Duration::from_millis(100);

pub(crate) fn run_process(spec: ProcessSpec) -> Result<ProcessOutcome, ProcessSupervisorError> {
    let started = Instant::now();
    let mut child = match spawn_process(&spec) {
        Ok(child) => child,
        Err(error) => {
            cleanup_paths_quietly(&spec.cleanup_paths);
            return Err(error);
        }
    };
    let stdout = match capture_pipe(
        child.stdout.take(),
        open_pipe_context(spec.label, "stdout"),
        spec.output_limit_bytes,
    ) {
        Ok(stdout) => stdout,
        Err(error) => {
            cleanup_child_after_startup_error(&mut child, &spec, None, None);
            return Err(error);
        }
    };
    let stderr = match capture_pipe(
        child.stderr.take(),
        open_pipe_context(spec.label, "stderr"),
        spec.output_limit_bytes,
    ) {
        Ok(stderr) => stderr,
        Err(error) => {
            cleanup_child_after_startup_error(&mut child, &spec, Some(stdout), None);
            return Err(error);
        }
    };

    if let Err(error) = write_stdin(&mut child, spec.stdin.as_ref()) {
        cleanup_child_after_startup_error(&mut child, &spec, Some(stdout), Some(stderr));
        return Err(error);
    }

    let (status, timed_out) = wait_for_exit(&mut child, &spec)?;
    let stdout = join_capture(stdout, collect_context(spec.label, "stdout"))?;
    let stderr = join_capture(stderr, collect_context(spec.label, "stderr"))?;
    let cleanup_errors = cleanup_paths(&spec.cleanup_paths);
    Ok(ProcessOutcome {
        status,
        timed_out,
        stdout,
        stderr,
        duration_ms: duration_ms(started),
        cleanup_errors,
    })
}

fn spawn_process(spec: &ProcessSpec) -> Result<Child, ProcessSupervisorError> {
    ensure_explicit_command_path_exists(spec)?;
    let mut command = process_command(spec);
    let stdin = if spec.stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    command
        .env_clear()
        .envs(&spec.env)
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = spec.cwd.as_ref() {
        command.current_dir(cwd);
    }
    configure_process_group(&mut command);
    command
        .spawn()
        .map_err(|source| ProcessSupervisorError::io(spawn_context(spec), source))
}

#[cfg(unix)]
fn ensure_explicit_command_path_exists(spec: &ProcessSpec) -> Result<(), ProcessSupervisorError> {
    if !spec.command.contains('/') {
        return Ok(());
    }
    let command_path = PathBuf::from(&spec.command);
    let exists = if command_path.is_absolute() {
        command_path.is_file()
    } else {
        spec.cwd
            .as_ref()
            .map(|cwd| cwd.join(&command_path).is_file())
            .unwrap_or_else(|| command_path.is_file())
    };
    if exists {
        return Ok(());
    }
    Err(ProcessSupervisorError::io(
        spawn_context(spec),
        std::io::Error::new(std::io::ErrorKind::NotFound, "command path not found"),
    ))
}

#[cfg(not(unix))]
fn ensure_explicit_command_path_exists(_spec: &ProcessSpec) -> Result<(), ProcessSupervisorError> {
    Ok(())
}

#[cfg(unix)]
fn process_command(spec: &ProcessSpec) -> Command {
    let mut command = Command::new(resource_limit_shell());
    command.args(resource_limit_shell_args(spec));
    command
}

#[cfg(not(unix))]
fn process_command(spec: &ProcessSpec) -> Command {
    let mut command = Command::new(&spec.command);
    command.args(&spec.args);
    command
}

fn write_stdin(
    child: &mut Child,
    stdin: Option<&ProcessStdin>,
) -> Result<(), ProcessSupervisorError> {
    let Some(stdin) = stdin else {
        return Ok(());
    };
    let Some(mut pipe) = child.stdin.take() else {
        return Ok(());
    };
    pipe.write_all(&stdin.bytes)
        .map_err(|source| ProcessSupervisorError::io(stdin.write_context, source))
}

fn wait_for_exit(
    child: &mut Child,
    spec: &ProcessSpec,
) -> Result<(ExitStatus, bool), ProcessSupervisorError> {
    let Some(timeout) = spec.timeout else {
        let status = child
            .wait()
            .map_err(|source| ProcessSupervisorError::io(wait_context(spec.label), source))?;
        return Ok((status, false));
    };

    match child
        .wait_timeout(timeout)
        .map_err(|source| ProcessSupervisorError::io(wait_timeout_context(spec.label), source))?
    {
        Some(status) => Ok((status, false)),
        None => {
            signal_timed_out_process(child, ProcessSignal::Terminate, spec)?;
            thread::sleep(DEFAULT_FORCE_KILL_GRACE);
            signal_timed_out_process(child, ProcessSignal::Force, spec)?;
            let status = child.wait().map_err(|source| {
                ProcessSupervisorError::io(wait_timed_out_context(spec.label), source)
            })?;
            Ok((status, true))
        }
    }
}

fn cleanup_child_after_startup_error(
    child: &mut Child,
    spec: &ProcessSpec,
    stdout: Option<CaptureHandle>,
    stderr: Option<CaptureHandle>,
) {
    let _ = signal_timed_out_process(child, ProcessSignal::Force, spec);
    let _ = child.wait();
    if let Some(stdout) = stdout {
        let _ = join_capture(stdout, collect_context(spec.label, "stdout"));
    }
    if let Some(stderr) = stderr {
        let _ = join_capture(stderr, collect_context(spec.label, "stderr"));
    }
    cleanup_paths_quietly(&spec.cleanup_paths);
}

fn cleanup_paths(paths: &[PathBuf]) -> Vec<String> {
    let mut errors = Vec::new();
    for path in paths {
        if let Err(error) = fs::remove_dir_all(path) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    errors
}

fn cleanup_paths_quietly(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_dir_all(path);
    }
}

fn duration_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn spawn_context(spec: &ProcessSpec) -> String {
    match spec.cwd.as_ref() {
        Some(cwd) => format!(
            "spawning {} process `{}` in {}",
            spec.label,
            spec.command,
            cwd.display()
        ),
        None => format!("spawning {} process `{}`", spec.label, spec.command),
    }
}

fn open_pipe_context(label: &str, stream: &str) -> String {
    format!("opening {label} {stream} pipe")
}

fn collect_context(label: &str, stream: &str) -> String {
    format!("collecting {label} {stream}")
}

fn wait_context(label: &str) -> String {
    format!("waiting for {label} process")
}

fn wait_timeout_context(label: &str) -> String {
    format!("waiting for {label} process with timeout")
}

fn wait_timed_out_context(label: &str) -> String {
    format!("waiting for timed out {label} process")
}

pub(super) fn poll_timed_out_context(label: &str) -> String {
    format!("polling timed out {label} process")
}

pub(super) fn kill_timed_out_context(label: &str) -> String {
    format!("killing timed out {label} process")
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::super::resource_limits::child_resource_limit_value;
    use super::*;

    #[cfg(unix)]
    #[test]
    fn run_process_applies_child_resource_limits() -> Result<(), String> {
        let expected_nofile =
            child_resource_limit_value("-n").ok_or("missing nofile resource limit")?;
        let expected_cpu = child_resource_limit_value("-t").ok_or("missing cpu resource limit")?;

        let outcome = run_process(
            ProcessSpec::new("resource-limit-test", "/bin/sh", 4096)
                .args(vec!["-c".to_owned(), "ulimit -n; ulimit -t".to_owned()])
                .timeout(Some(Duration::from_secs(5))),
        )
        .map_err(|error| error.to_string())?;

        assert!(
            outcome.status.success(),
            "resource-limit probe failed: {}",
            String::from_utf8_lossy(&outcome.stderr.bytes)
        );
        assert!(!outcome.timed_out);
        let stdout = String::from_utf8(outcome.stdout.bytes).map_err(|error| error.to_string())?;
        let actual = stdout
            .lines()
            .map(str::trim)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let expected = vec![expected_nofile.to_string(), expected_cpu.to_string()];
        assert_eq!(actual, expected);
        Ok(())
    }
}
