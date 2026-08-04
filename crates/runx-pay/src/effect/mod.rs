mod admission;
mod context;
mod errors;
mod finality;
mod output;
mod replay;
mod runtime;

use std::sync::Arc;

pub use finality::{
    DeterministicPaymentFinalitySupervisor, PaymentFinalitySupervisor,
    PaymentFinalitySupervisorError, PaymentFinalitySupervisorEvidence,
    PaymentFinalitySupervisorRequest,
};

pub const PAYMENT_EFFECT_FAMILY: &str = "payment";
pub const INFERENCE_EFFECT_FAMILY: &str = "inference";
const PAYMENT_FULFILL_SKILL: &str = "pay-fulfill-rail";

#[derive(Clone)]
pub struct PaymentRuntimeEffect {
    supervisor: Arc<dyn PaymentFinalitySupervisor>,
}

impl PaymentRuntimeEffect {
    pub fn new<T>(supervisor: T) -> Self
    where
        T: PaymentFinalitySupervisor + 'static,
    {
        Self {
            supervisor: Arc::new(supervisor),
        }
    }
}
