use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::capture::{CaptureHandle, capture_pipe, join_capture};
use super::owned_process::OwnedProcess;
#[cfg(unix)]
use super::resource_limits::{resource_limit_shell, resource_limit_shell_args};
use super::signals::ProcessSignal;
use super::{
    ProcessOutcome, ProcessSpec, ProcessStdin, ProcessSupervisorError, cleanup_paths_quietly,
};

const DEFAULT_FORCE_KILL_GRACE: Duration = Duration::from_millis(100);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PROCESS_REAP_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn run_process(spec: ProcessSpec) -> Result<ProcessOutcome, ProcessSupervisorError> {
    let started = Instant::now();
    let mut child = match spawn_process(&spec) {
        Ok(child) => child,
        Err(error) => {
            cleanup_paths_quietly(&spec.cleanup_paths);
            return Err(error);
        }
    };
    let _active_process = crate::interrupt::ActiveProcessGroup::register(child.id());
    let stdout = match capture_pipe(
        child.take_stdout(),
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
        child.take_stderr(),
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

    let (status, timed_out) = match wait_for_exit(&mut child, &spec) {
        Ok(outcome) => outcome,
        Err(error) => {
            cleanup_child_after_startup_error(&mut child, &spec, Some(stdout), Some(stderr));
            return Err(error);
        }
    };
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

fn spawn_process(spec: &ProcessSpec) -> Result<OwnedProcess, ProcessSupervisorError> {
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
    OwnedProcess::spawn(command)
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
    let (program, args) = env_shimmed_process_parts(spec);
    let mut command = Command::new(program);
    command.args(args);
    command
}

#[cfg(any(not(unix), test))]
fn env_shimmed_process_parts(spec: &ProcessSpec) -> (&str, &[String]) {
    if spec.command == "/usr/bin/env"
        && let Some((program, args)) = spec.args.split_first()
    {
        return (program.as_str(), args);
    }
    (spec.command.as_str(), spec.args.as_slice())
}

fn write_stdin(
    child: &mut OwnedProcess,
    stdin: Option<&ProcessStdin>,
) -> Result<(), ProcessSupervisorError> {
    let Some(stdin) = stdin else {
        return Ok(());
    };
    let Some(mut pipe) = child.take_stdin() else {
        return Ok(());
    };
    pipe.write_all(&stdin.bytes)
        .map_err(|source| ProcessSupervisorError::io(stdin.write_context, source))
}

fn wait_for_exit(
    child: &mut OwnedProcess,
    spec: &ProcessSpec,
) -> Result<(ExitStatus, bool), ProcessSupervisorError> {
    let deadline = spec.timeout.map(|timeout| Instant::now() + timeout);
    loop {
        if crate::interrupt::was_interrupted() {
            signal_process(child, ProcessSignal::Force, spec)?;
            let status = child
                .reap_with_timeout(PROCESS_REAP_TIMEOUT)
                .map_err(|source| {
                    ProcessSupervisorError::io(wait_interrupted_context(spec.label), source)
                })?;
            return Ok((status, false));
        }

        let wait_for = deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .map(|remaining| remaining.min(PROCESS_POLL_INTERVAL))
            .unwrap_or(PROCESS_POLL_INTERVAL);
        if wait_for.is_zero() {
            signal_process(child, ProcessSignal::Terminate, spec)?;
            thread::sleep(DEFAULT_FORCE_KILL_GRACE);
            signal_process(child, ProcessSignal::Force, spec)?;
            let status = child
                .reap_with_timeout(PROCESS_REAP_TIMEOUT)
                .map_err(|source| {
                    ProcessSupervisorError::io(wait_timed_out_context(spec.label), source)
                })?;
            return Ok((status, true));
        }

        if let Some(status) = child.wait_timeout(wait_for).map_err(|source| {
            ProcessSupervisorError::io(wait_timeout_context(spec.label), source)
        })? {
            // The root process owns the execution result. Any descendant still
            // alive after it exits is execution residue, so terminate the owned
            // tree before joining inherited stdout/stderr handles.
            signal_process(child, ProcessSignal::Force, spec)?;
            return Ok((status, false));
        }
    }
}

fn cleanup_child_after_startup_error(
    child: &mut OwnedProcess,
    spec: &ProcessSpec,
    stdout: Option<CaptureHandle>,
    stderr: Option<CaptureHandle>,
) {
    let _ = signal_process(child, ProcessSignal::Force, spec);
    let _ = child.reap_with_timeout(PROCESS_REAP_TIMEOUT);
    if let Some(stdout) = stdout {
        let _ = join_capture(stdout, collect_context(spec.label, "stdout"));
    }
    if let Some(stderr) = stderr {
        let _ = join_capture(stderr, collect_context(spec.label, "stderr"));
    }
    cleanup_paths_quietly(&spec.cleanup_paths);
}

fn signal_process(
    child: &mut OwnedProcess,
    signal: ProcessSignal,
    spec: &ProcessSpec,
) -> Result<(), ProcessSupervisorError> {
    child
        .signal(signal)
        .map_err(|source| ProcessSupervisorError::io(kill_timed_out_context(spec.label), source))
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

fn wait_timeout_context(label: &str) -> String {
    format!("waiting for {label} process with timeout")
}

fn wait_timed_out_context(label: &str) -> String {
    format!("waiting for timed out {label} process")
}

fn wait_interrupted_context(label: &str) -> String {
    format!("waiting for interrupted {label} process")
}

pub(super) fn kill_timed_out_context(label: &str) -> String {
    format!("killing timed out {label} process")
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::super::resource_limits::child_resource_limit_value;
    use super::*;
    #[cfg(windows)]
    use std::process::Command;

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

    #[test]
    fn env_shim_process_parts_turns_portable_runner_into_windows_command() {
        let spec = ProcessSpec::new("env-shim-test", "/usr/bin/env", 128)
            .args(vec!["node".to_owned(), "run.mjs".to_owned()]);

        let (program, args) = env_shimmed_process_parts(&spec);

        assert_eq!(program, "node");
        assert_eq!(args, vec!["run.mjs".to_owned()].as_slice());
    }

    #[test]
    fn env_shim_process_parts_leaves_normal_commands_unchanged() {
        let spec = ProcessSpec::new("env-shim-test", "node", 128).args(vec!["run.mjs".to_owned()]);

        let (program, args) = env_shimmed_process_parts(&spec);

        assert_eq!(program, "node");
        assert_eq!(args, vec!["run.mjs".to_owned()].as_slice());
    }

    #[cfg(windows)]
    #[test]
    fn windows_timeout_terminates_the_owned_process_tree() -> Result<(), String> {
        let node = node_binary()?;
        let outcome = run_process(
            ProcessSpec::new("windows-timeout-tree", node.clone(), 4096)
                .args(vec![
                    "-e".to_owned(),
                    [
                        "const {spawn}=require('node:child_process');",
                        "const child=spawn(process.execPath,",
                        "['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
                        "process.stdout.write(`${child.pid}\\n`);",
                        "setInterval(()=>{},1000);",
                    ]
                    .join(""),
                ])
                .env(windows_process_env())
                .timeout(Some(Duration::from_millis(250))),
        )
        .map_err(|error| error.to_string())?;

        if !outcome.timed_out {
            return Err(format!(
                "Windows timeout fixture exited early with {}: {}",
                outcome.status,
                String::from_utf8_lossy(&outcome.stderr.bytes)
            ));
        }
        let descendant = output_pid(&outcome)?;
        assert_process_exits(&node, descendant)
    }

    #[cfg(windows)]
    #[test]
    fn windows_root_exit_reaps_a_live_descendant() -> Result<(), String> {
        let node = node_binary()?;
        let outcome = run_process(
            ProcessSpec::new("windows-root-exit-tree", node.clone(), 4096)
                .args(vec![
                    "-e".to_owned(),
                    [
                        "const {spawn}=require('node:child_process');",
                        "const child=spawn(process.execPath,",
                        "['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
                        "process.stdout.write(`${child.pid}\\n`);",
                        "child.unref();",
                    ]
                    .join(""),
                ])
                .env(windows_process_env())
                .timeout(Some(Duration::from_secs(5))),
        )
        .map_err(|error| error.to_string())?;

        if outcome.timed_out || !outcome.status.success() {
            return Err(format!(
                "Windows root-exit fixture failed with {} (timed_out={}): {}",
                outcome.status,
                outcome.timed_out,
                String::from_utf8_lossy(&outcome.stderr.bytes)
            ));
        }
        let descendant = output_pid(&outcome)?;
        assert_process_exits(&node, descendant)
    }

    #[cfg(windows)]
    fn windows_process_env() -> std::collections::BTreeMap<String, String> {
        ["PATH", "SystemRoot", "PATHEXT"]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
            .collect()
    }

    #[cfg(windows)]
    fn node_binary() -> Result<String, String> {
        let output = Command::new("where.exe")
            .arg("node.exe")
            .output()
            .map_err(|error| format!("locating node.exe: {error}"))?;
        if !output.status.success() {
            return Err("node.exe is required for Windows process-tree lifecycle tests".to_owned());
        }
        String::from_utf8(output.stdout)
            .map_err(|error| error.to_string())?
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .ok_or_else(|| "where.exe returned no node.exe path".to_owned())
    }

    #[cfg(windows)]
    fn output_pid(outcome: &ProcessOutcome) -> Result<u32, String> {
        String::from_utf8(outcome.stdout.bytes.clone())
            .map_err(|error| error.to_string())?
            .trim()
            .parse::<u32>()
            .map_err(|error| format!("parsing descendant pid: {error}"))
    }

    #[cfg(windows)]
    fn assert_process_exits(node: &str, process_id: u32) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let probe = [
            "try{process.kill(Number(process.argv[1]),0);process.exit(1)}",
            "catch(error){process.exit(error.code==='ESRCH'?0:2)}",
        ]
        .join("");
        let process_id = process_id.to_string();
        while Instant::now() < deadline {
            let status = Command::new(node)
                .args(["-e", probe.as_str(), process_id.as_str()])
                .status()
                .map_err(|error| format!("probing descendant {process_id}: {error}"))?;
            if status.success() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err(format!(
            "Windows Job Object left descendant {process_id} alive"
        ))
    }
}
