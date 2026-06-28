mod signals;

#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
mod capture;
#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
mod resource_limits;
#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
mod spec;
#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
mod supervisor;
#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
mod timeout;

#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
pub(crate) use self::capture::CapturedOutput;
pub(crate) use self::signals::{ProcessSignal, configure_process_group, signal_process_group_id};
#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
pub(crate) use self::spec::{ProcessOutcome, ProcessSpec, ProcessStdin, ProcessSupervisorError};
#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
pub(crate) use self::supervisor::run_process;
#[cfg(any(feature = "cli-tool", feature = "external-adapter"))]
use self::supervisor::{kill_timed_out_context, poll_timed_out_context};
