use runx_contracts::{ExecutionEvent, ResolutionRequest, ResolutionResponse};

use crate::RuntimeError;

pub trait Host {
    fn report(&mut self, event: ExecutionEvent) -> Result<(), RuntimeError>;

    fn resolve(
        &mut self,
        request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError>;

    fn log(&mut self, message: String) -> Result<(), RuntimeError>;
}

#[derive(Default)]
pub struct NoopHost;

impl Host for NoopHost {
    fn report(&mut self, _event: ExecutionEvent) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn resolve(
        &mut self,
        _request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        Ok(None)
    }

    fn log(&mut self, _message: String) -> Result<(), RuntimeError> {
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct RejectingParallelHost;

impl Host for RejectingParallelHost {
    fn report(&mut self, _event: ExecutionEvent) -> Result<(), RuntimeError> {
        Err(parallel_host_error("report"))
    }

    fn resolve(
        &mut self,
        _request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        Err(parallel_host_error("resolve"))
    }

    fn log(&mut self, _message: String) -> Result<(), RuntimeError> {
        Err(parallel_host_error("log"))
    }
}

fn parallel_host_error(operation: &'static str) -> RuntimeError {
    RuntimeError::ParallelHostInteraction { operation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_host_fails_instead_of_discarding_runtime_events() {
        let mut host = RejectingParallelHost;
        assert!(matches!(
            host.log("unexpected".to_owned()),
            Err(RuntimeError::ParallelHostInteraction { operation: "log" })
        ));
    }
}
