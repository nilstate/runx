use thiserror::Error;

#[cfg(target_os = "linux")]
use crate::protocol::WORKER_VIRTUAL_ADDRESS_SPACE_BYTES;
#[cfg(target_os = "windows")]
use crate::protocol::WORKER_WORKING_SET_BYTES;

#[derive(Debug, Error)]
pub(crate) enum WorkerLimitError {
    #[error("worker inherited an environment; the supervisor must spawn it with env_clear")]
    EnvironmentPresent,
    #[error("worker resource limits could not be installed: {0}")]
    Installation(String),
}

pub(crate) fn install() -> Result<(), WorkerLimitError> {
    if std::env::vars_os().next().is_some() {
        return Err(WorkerLimitError::EnvironmentPresent);
    }
    install_platform_limits()
}

#[cfg(unix)]
fn install_platform_limits() -> Result<(), WorkerLimitError> {
    set_unix_limit(rlimit::Resource::CORE, 0)?;
    set_unix_limit(rlimit::Resource::FSIZE, 0)?;
    set_unix_limit(rlimit::Resource::NOFILE, 32)?;
    #[cfg(target_os = "linux")]
    set_unix_limit(rlimit::Resource::AS, WORKER_VIRTUAL_ADDRESS_SPACE_BYTES)?;
    Ok(())
}

#[cfg(unix)]
fn set_unix_limit(resource: rlimit::Resource, value: u64) -> Result<(), WorkerLimitError> {
    resource
        .set(value, value)
        .map_err(|error| WorkerLimitError::Installation(format!("{resource:?}: {error}")))
}

#[cfg(windows)]
fn install_platform_limits() -> Result<(), WorkerLimitError> {
    use win32job::{ExtendedLimitInfo, Job, PriorityClass};

    let maximum = usize::try_from(WORKER_WORKING_SET_BYTES).map_err(|_| {
        WorkerLimitError::Installation("worker memory limit does not fit usize".to_owned())
    })?;
    let mut limits = ExtendedLimitInfo::new();
    limits
        .limit_working_memory(1024 * 1024, maximum)
        .limit_priority_class(PriorityClass::BelowNormal);
    let job = Job::create_with_limit_info(&mut limits)
        .map_err(|error| WorkerLimitError::Installation(error.to_string()))?;
    job.assign_current_process()
        .map_err(|error| WorkerLimitError::Installation(error.to_string()))?;
    let _job = Box::leak(Box::new(job));
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn install_platform_limits() -> Result<(), WorkerLimitError> {
    Err(WorkerLimitError::Installation(
        "this release target has no worker memory/process resource-limit backend".to_owned(),
    ))
}
