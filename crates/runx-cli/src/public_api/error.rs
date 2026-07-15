use std::fmt;

use runx_runtime::ConfigError;
use runx_runtime::registry::RuntimeHttpError;
use serde::Deserialize;

use super::TOKEN_ENV;

#[derive(Debug)]
pub(crate) enum ApiEnvironmentError {
    Config(ConfigError),
    RuntimeHttp(RuntimeHttpError),
    MissingToken,
    StoredCredentialEnvironmentMismatch { base_url: String },
    AuthenticationStatus { status: u16, detail: String },
    InvalidPrincipal(String),
    PrincipalMismatch { expected: String, actual: String },
}

impl fmt::Display for ApiEnvironmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(error) => write!(formatter, "{error}"),
            Self::RuntimeHttp(error) => write!(formatter, "{error}"),
            Self::MissingToken => write!(
                formatter,
                "missing public API token; run `runx login` or set {TOKEN_ENV}"
            ),
            Self::StoredCredentialEnvironmentMismatch { base_url } => write!(
                formatter,
                "stored login belongs to a different runx environment; login to {base_url} or provide {TOKEN_ENV} explicitly"
            ),
            Self::AuthenticationStatus { status, detail } => write!(
                formatter,
                "runx API authentication returned HTTP {status}: {detail}"
            ),
            Self::InvalidPrincipal(message) => {
                write!(
                    formatter,
                    "runx API returned an invalid principal: {message}"
                )
            }
            Self::PrincipalMismatch { expected, actual } => write!(
                formatter,
                "runx API principal mismatch: stored {expected}, authenticated {actual}"
            ),
        }
    }
}

impl std::error::Error for ApiEnvironmentError {}

impl From<ConfigError> for ApiEnvironmentError {
    fn from(error: ConfigError) -> Self {
        Self::Config(error)
    }
}

impl From<RuntimeHttpError> for ApiEnvironmentError {
    fn from(error: RuntimeHttpError) -> Self {
        Self::RuntimeHttp(error)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct ErrorPayload {
    pub code: String,
    pub detail: String,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub retry_after_seconds: Option<u32>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorPayload,
}

#[derive(Deserialize)]
struct PlainErrorEnvelope {
    error: PlainError,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PlainError {
    Message(String),
    Payload(ErrorPayload),
}

pub(crate) fn parse_error(body: &str) -> Option<ErrorPayload> {
    serde_json::from_str::<ErrorEnvelope>(body)
        .ok()
        .map(|envelope| envelope.error)
        .or_else(|| {
            serde_json::from_str::<PlainErrorEnvelope>(body)
                .ok()
                .map(|envelope| match envelope.error {
                    PlainError::Message(detail) => ErrorPayload {
                        code: plain_error_code(&detail).to_owned(),
                        detail,
                        hint: None,
                        retry_after_seconds: None,
                    },
                    PlainError::Payload(payload) => payload,
                })
        })
}

fn plain_error_code(detail: &str) -> &'static str {
    if detail.contains("Missing required scope") {
        "missing_scope"
    } else {
        "api_error"
    }
}
