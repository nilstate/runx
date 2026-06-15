// rust-style-allow: large-file -- process supervision keeps spawn, timeout,
// capture, cleanup, and rlimit wrapper invariants together until the supervisor
// API is split by backend.
mod capture;
mod signal;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use rustix::process::{Resource, Rlimit, getrlimit};
use thiserror::Error;
use wait_timeout::ChildExt;

pub(crate) use self::capture::CapturedOutput;
use self::capture::{CaptureHandle, capture_pipe, join_capture};
use self::signal::signal_timed_out_process;
use crate::process_signal::{ProcessSignal, configure_process_group};

const DEFAULT_FORCE_KILL_GRACE: Duration = Duration::from_millis(100);
#[cfg(unix)]
const RESOURCE_LIMIT_SHELL: &str = "/bin/sh";
#[cfg(unix)]
const RESOURCE_LIMIT_ARG0: &str = "runx-resource-limits";
#[cfg(unix)]
const RESOURCE_LIMIT_FILE_BLOCK_BYTES: u64 = 512;
#[cfg(any(target_os = "linux", target_os = "android"))]
const RESOURCE_LIMIT_MEMORY_KIB_BYTES: u64 = 1024;
#[cfg(unix)]
const CHILD_MAX_OPEN_FILES: u64 = 256;
#[cfg(unix)]
const CHILD_MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(unix)]
const CHILD_MAX_CPU_SECONDS: u64 = 60;
#[cfg(any(target_os = "linux", target_os = "android"))]
const CHILD_MAX_ADDRESS_SPACE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct ProcessSpec {
    label: &'static str,
    command: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    env: BTreeMap<String, String>,
    stdin: Option<ProcessStdin>,
    timeout: Option<Duration>,
    output_limit_bytes: usize,
    cleanup_paths: Vec<PathBuf>,
}

impl ProcessSpec {
    pub(crate) fn new(
        label: &'static str,
        command: impl Into<String>,
        output_limit_bytes: usize,
    ) -> Self {
        Self {
            label,
            command: command.into(),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            stdin: None,
            timeout: None,
            output_limit_bytes,
            cleanup_paths: Vec::new(),
        }
    }

    pub(crate) fn args(mut self, args: Vec<String>) -> Self {
        self.args = args;
        self
    }

    pub(crate) fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub(crate) fn env(mut self, env: BTreeMap<String, String>) -> Self {
        self.env = env;
        self
    }

    pub(crate) fn stdin(mut self, stdin: Option<ProcessStdin>) -> Self {
        self.stdin = stdin;
        self
    }

    pub(crate) fn timeout(mut self, timeout: Option<Duration>) -> Self {
        self.timeout = timeout;
        self
    }

    #[cfg(feature = "cli-tool")]
    pub(crate) fn cleanup_paths(mut self, cleanup_paths: Vec<PathBuf>) -> Self {
        self.cleanup_paths = cleanup_paths;
        self
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProcessStdin {
    bytes: Vec<u8>,
    write_context: &'static str,
}

impl ProcessStdin {
    pub(crate) fn new(bytes: Vec<u8>, write_context: &'static str) -> Self {
        Self {
            bytes,
            write_context,
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessOutcome {
    pub(crate) status: ExitStatus,
    pub(crate) timed_out: bool,
    pub(crate) stdout: CapturedOutput,
    pub(crate) stderr: CapturedOutput,
    pub(crate) duration_ms: u64,
    pub(crate) cleanup_errors: Vec<String>,
}

#[derive(Debug, Error)]
pub(crate) enum ProcessSupervisorError {
    #[error("process I/O failed while {context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
}

impl ProcessSupervisorError {
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}

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
    let limits = child_resource_limits();
    let mut command = Command::new(RESOURCE_LIMIT_SHELL);
    command.args(resource_limit_shell_args(&limits, spec));
    command
}

#[cfg(not(unix))]
fn process_command(spec: &ProcessSpec) -> Command {
    let mut command = Command::new(&spec.command);
    command.args(&spec.args);
    command
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ChildResourceLimit {
    flag: &'static str,
    value: u64,
}

#[cfg(unix)]
fn child_resource_limits() -> Vec<ChildResourceLimit> {
    let mut limits = Vec::with_capacity(5);
    push_count_limit(&mut limits, "-n", Resource::Nofile, CHILD_MAX_OPEN_FILES);
    push_scaled_limit(
        &mut limits,
        "-f",
        Resource::Fsize,
        CHILD_MAX_FILE_BYTES,
        RESOURCE_LIMIT_FILE_BLOCK_BYTES,
    );
    push_count_limit(&mut limits, "-t", Resource::Cpu, CHILD_MAX_CPU_SECONDS);
    // POSIX sh does not guarantee a process-count ulimit flag, and Ubuntu dash
    // rejects `ulimit -u`. Keep this wrapper to flags supported by /bin/sh.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    push_scaled_limit(
        &mut limits,
        "-v",
        Resource::As,
        CHILD_MAX_ADDRESS_SPACE_BYTES,
        RESOURCE_LIMIT_MEMORY_KIB_BYTES,
    );
    limits
}

#[cfg(unix)]
fn push_count_limit(
    limits: &mut Vec<ChildResourceLimit>,
    flag: &'static str,
    resource: Resource,
    target: u64,
) {
    limits.push(ChildResourceLimit {
        flag,
        value: shell_limit_value(getrlimit(resource), target, 1),
    });
}

#[cfg(unix)]
fn push_scaled_limit(
    limits: &mut Vec<ChildResourceLimit>,
    flag: &'static str,
    resource: Resource,
    target: u64,
    unit_bytes: u64,
) {
    limits.push(ChildResourceLimit {
        flag,
        value: shell_limit_value(getrlimit(resource), target, unit_bytes),
    });
}

#[cfg(unix)]
fn shell_limit_value(current: Rlimit, target: u64, unit: u64) -> u64 {
    let hard_limit = current.maximum.unwrap_or(target);
    target.min(hard_limit) / unit
}

#[cfg(unix)]
fn resource_limit_shell_args(limits: &[ChildResourceLimit], spec: &ProcessSpec) -> Vec<String> {
    let mut script = String::new();
    for (index, limit) in limits.iter().enumerate() {
        if index > 0 {
            script.push_str(" && ");
        }
        script.push_str("ulimit ");
        script.push_str(limit.flag);
        script.push_str(" \"$");
        script.push_str(&(index + 1).to_string());
        script.push('"');
    }
    if !limits.is_empty() {
        script.push_str(" && shift ");
        script.push_str(&limits.len().to_string());
        script.push_str(" && ");
    }
    script.push_str("exec \"$@\"");

    let mut args = vec!["-c".to_owned(), script, RESOURCE_LIMIT_ARG0.to_owned()];
    args.extend(limits.iter().map(|limit| limit.value.to_string()));
    args.push(spec.command.clone());
    args.extend(spec.args.iter().cloned());
    args
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

fn poll_timed_out_context(label: &str) -> String {
    format!("polling timed out {label} process")
}

fn kill_timed_out_context(label: &str) -> String {
    format!("killing timed out {label} process")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn shell_limit_value_clamps_to_inherited_hard_limit() {
        let unlimited = Rlimit {
            current: None,
            maximum: None,
        };
        assert_eq!(shell_limit_value(unlimited, 128, 1), 128);

        let stricter_parent = Rlimit {
            current: Some(64),
            maximum: Some(64),
        };
        assert_eq!(shell_limit_value(stricter_parent, 128, 1), 64);

        let byte_limit = Rlimit {
            current: Some(1536),
            maximum: Some(1536),
        };
        assert_eq!(
            shell_limit_value(byte_limit, 4096, RESOURCE_LIMIT_FILE_BLOCK_BYTES),
            3
        );
    }

    #[cfg(unix)]
    #[test]
    fn resource_limit_shell_args_do_not_interpolate_requested_command() {
        let spec = ProcessSpec::new("test", "echo $(touch should-not-run)", 128)
            .args(vec!["hello; rm -rf /".to_owned()]);
        let limits = vec![
            ChildResourceLimit {
                flag: "-n",
                value: 256,
            },
            ChildResourceLimit {
                flag: "-t",
                value: 60,
            },
        ];

        let args = resource_limit_shell_args(&limits, &spec);

        assert_eq!(
            args,
            vec![
                "-c".to_owned(),
                "ulimit -n \"$1\" && ulimit -t \"$2\" && shift 2 && exec \"$@\"".to_owned(),
                RESOURCE_LIMIT_ARG0.to_owned(),
                "256".to_owned(),
                "60".to_owned(),
                "echo $(touch should-not-run)".to_owned(),
                "hello; rm -rf /".to_owned(),
            ]
        );
    }

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

    #[cfg(unix)]
    fn child_resource_limit_value(flag: &str) -> Option<u64> {
        child_resource_limits()
            .into_iter()
            .find(|limit| limit.flag == flag)
            .map(|limit| limit.value)
    }
}
