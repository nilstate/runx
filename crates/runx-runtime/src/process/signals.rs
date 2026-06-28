use std::process::Command;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[derive(Clone, Copy, Debug)]
pub(crate) enum ProcessSignal {
    #[cfg(any(feature = "cli-tool", feature = "external-adapter", feature = "mcp"))]
    Terminate,
    Force,
}

#[cfg(unix)]
impl ProcessSignal {
    const fn rustix_signal(self) -> rustix::process::Signal {
        match self {
            #[cfg(any(feature = "cli-tool", feature = "external-adapter", feature = "mcp"))]
            Self::Terminate => rustix::process::Signal::TERM,
            Self::Force => rustix::process::Signal::KILL,
        }
    }
}

#[cfg(unix)]
pub(crate) fn configure_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
pub(crate) fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn signal_process_group_id(process_id: u32, signal: ProcessSignal) -> bool {
    use rustix::process::{Pid, kill_process_group};

    let Ok(raw_pid) = i32::try_from(process_id) else {
        return false;
    };
    let Some(pid) = Pid::from_raw(raw_pid) else {
        return false;
    };
    kill_process_group(pid, signal.rustix_signal()).is_ok()
}

#[cfg(not(unix))]
pub(crate) fn signal_process_group_id(_process_id: u32, _signal: ProcessSignal) -> bool {
    false
}
