use runx_contracts::AuthorityVerb;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RuntimeEffectError {
    #[error("effect family {family} is already configured")]
    DuplicateFamily { family: String },
    #[error("effect family {family} is not configured")]
    MissingFamily { family: String },
    #[error("effect family {family} is invalid: {message}")]
    InvalidMetadata { family: String, message: String },
    #[error("effect family {family} rejected {verb:?}: {message}")]
    Denied {
        family: String,
        verb: AuthorityVerb,
        message: String,
    },
    #[error("effect family {family} failed during {operation}: {message}")]
    Failed {
        family: String,
        operation: &'static str,
        message: String,
    },
}
