use std::any::Any;
use std::fmt;
use std::sync::Arc;

use runx_contracts::{AuthorityVerb, JsonObject};
use runx_core::state_machine::AuthorityAdmissionWitness;

#[derive(Clone)]
pub struct EffectAdmission {
    family: &'static str,
    verb: AuthorityVerb,
    witness: AuthorityAdmissionWitness,
    context: Arc<dyn Any + Send + Sync>,
}

impl EffectAdmission {
    #[must_use]
    pub fn new<T>(
        family: &'static str,
        verb: AuthorityVerb,
        witness: AuthorityAdmissionWitness,
        context: T,
    ) -> Self
    where
        T: Any + Send + Sync + 'static,
    {
        Self {
            family,
            verb,
            witness,
            context: Arc::new(context),
        }
    }

    #[must_use]
    pub fn family(&self) -> &'static str {
        self.family
    }

    #[must_use]
    pub fn verb(&self) -> AuthorityVerb {
        self.verb.clone()
    }

    #[must_use]
    pub fn witness(&self) -> &AuthorityAdmissionWitness {
        &self.witness
    }

    #[must_use]
    pub fn context<T: Any>(&self) -> Option<&T> {
        self.context.as_ref().downcast_ref::<T>()
    }

    #[must_use]
    pub(crate) fn with_context<T>(self, context: T) -> Self
    where
        T: Any + Send + Sync + 'static,
    {
        Self {
            family: self.family,
            verb: self.verb,
            witness: self.witness,
            context: Arc::new(context),
        }
    }
}

impl fmt::Debug for EffectAdmission {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectAdmission")
            .field("family", &self.family)
            .field("verb", &self.verb)
            .field("witness", &self.witness)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct EffectReplay {
    family: &'static str,
    receipt_ref: String,
    receipt_created_at: String,
    receipt_digest: String,
    outputs: JsonObject,
    context: Arc<dyn Any + Send + Sync>,
}

impl EffectReplay {
    #[must_use]
    pub fn new<T>(
        family: &'static str,
        receipt_ref: impl Into<String>,
        receipt_created_at: impl Into<String>,
        receipt_digest: impl Into<String>,
        outputs: JsonObject,
        context: T,
    ) -> Self
    where
        T: Any + Send + Sync + 'static,
    {
        Self {
            family,
            receipt_ref: receipt_ref.into(),
            receipt_created_at: receipt_created_at.into(),
            receipt_digest: receipt_digest.into(),
            outputs,
            context: Arc::new(context),
        }
    }

    #[must_use]
    pub fn family(&self) -> &'static str {
        self.family
    }

    #[must_use]
    pub fn receipt_ref(&self) -> &str {
        &self.receipt_ref
    }

    #[must_use]
    pub fn receipt_created_at(&self) -> &str {
        &self.receipt_created_at
    }

    #[must_use]
    pub fn receipt_digest(&self) -> &str {
        &self.receipt_digest
    }

    #[must_use]
    pub fn outputs(&self) -> &JsonObject {
        &self.outputs
    }

    #[must_use]
    pub fn context<T: Any>(&self) -> Option<&T> {
        self.context.as_ref().downcast_ref::<T>()
    }
}

impl fmt::Debug for EffectReplay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectReplay")
            .field("family", &self.family)
            .field("receipt_ref", &self.receipt_ref)
            .field("receipt_created_at", &self.receipt_created_at)
            .field("receipt_digest", &self.receipt_digest)
            .finish_non_exhaustive()
    }
}
