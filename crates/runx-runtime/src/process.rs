#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
mod owned_process;
mod signals;
#[cfg(windows)]
mod windows_host_job;

/// Default retained bytes per stdout/stderr stream for general operator
/// processes. The supervisor continues draining and hashing the complete stream;
/// capability-specific contracts may choose a narrower or wider retained body.
#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
pub(crate) const STANDARD_PROCESS_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
mod capture;
#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
mod resource_limits;
#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
mod spec;
#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
mod supervisor;
#[cfg(feature = "mcp")]
mod tokio_supervisor;

#[cfg(feature = "cli-tool")]
pub(crate) use self::capture::CapturedOutput;
pub(crate) use self::signals::{ProcessSignal, configure_process_group, signal_process_group_id};
#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
pub(crate) use self::spec::{ProcessOutcome, ProcessSpec, ProcessStdin, ProcessSupervisorError};
#[cfg(any(
    feature = "cli-tool",
    feature = "external-adapter",
    feature = "thread-outbox-provider"
))]
pub(crate) use self::supervisor::run_process;
#[cfg(feature = "mcp")]
pub(crate) use self::tokio_supervisor::{OwnedTokioProcess, TokioProcessSpec, spawn_tokio_process};
#[cfg(windows)]
pub(crate) use self::windows_host_job::ensure_windows_host_job;

pub(crate) fn cleanup_paths_quietly(paths: &[std::path::PathBuf]) {
    for path in paths {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(not(windows))]
pub(crate) fn ensure_windows_host_job() -> std::io::Result<()> {
    Ok(())
}
