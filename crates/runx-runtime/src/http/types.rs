use std::fmt;

use super::RuntimeHttpError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeHttpHeader {
    pub name: String,
    pub value: String,
}

impl RuntimeHttpHeader {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }
}

impl fmt::Debug for RuntimeHttpHeader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeHttpHeader")
            .field("name", &self.name)
            .field(
                "value",
                &if sensitive_header_name(&self.name) {
                    "[redacted]"
                } else {
                    self.value.as_str()
                },
            )
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeHttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<RuntimeHttpHeader>,
    pub body: Option<String>,
}

impl fmt::Debug for RuntimeHttpRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeHttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &self.headers)
            .field(
                "body",
                &self.body.as_ref().map(|_| "[redacted body present]"),
            )
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct RuntimeHttpResponse {
    pub status: u16,
    pub body: String,
}

impl fmt::Debug for RuntimeHttpResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeHttpResponse")
            .field("status", &self.status)
            .field("body", &format_args!("{} bytes", self.body.len()))
            .finish()
    }
}

pub trait RuntimeHttpTransport {
    fn send(&self, request: RuntimeHttpRequest) -> Result<RuntimeHttpResponse, RuntimeHttpError>;
}

#[derive(Clone, Debug)]
pub struct ReqwestHttpTransport {
    #[cfg(feature = "async-http")]
    pub(super) client: reqwest::Client,
    #[cfg(feature = "async-http")]
    pub(super) allow_private_networks: bool,
}

pub(super) fn sensitive_header_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized == "authorization"
        || normalized == "proxy-authorization"
        || normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("api-key")
}
