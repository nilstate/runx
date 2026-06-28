use std::process::Child;

use super::{
    ProcessSignal, ProcessSpec, ProcessSupervisorError, kill_timed_out_context,
    poll_timed_out_context, signal_process_group_id,
};

#[cfg(unix)]
pub(super) fn signal_timed_out_process(
    child: &mut Child,
    signal: ProcessSignal,
    spec: &ProcessSpec,
) -> Result<(), ProcessSupervisorError> {
    if signal_process_group_id(child.id(), signal) {
        return Ok(());
    }
    if child
        .try_wait()
        .map_err(|source| ProcessSupervisorError::io(poll_timed_out_context(spec.label), source))?
        .is_some()
    {
        return Ok(());
    }
    kill_direct_child_if_running(child, spec)
}

#[cfg(not(unix))]
pub(super) fn signal_timed_out_process(
    child: &mut Child,
    _signal: ProcessSignal,
    spec: &ProcessSpec,
) -> Result<(), ProcessSupervisorError> {
    kill_direct_child_if_running(child, spec)
}

fn kill_direct_child_if_running(
    child: &mut Child,
    spec: &ProcessSpec,
) -> Result<(), ProcessSupervisorError> {
    if child
        .try_wait()
        .map_err(|source| ProcessSupervisorError::io(poll_timed_out_context(spec.label), source))?
        .is_some()
    {
        return Ok(());
    }
    child
        .kill()
        .map_err(|source| ProcessSupervisorError::io(kill_timed_out_context(spec.label), source))
}
