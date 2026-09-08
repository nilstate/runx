use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use runx_contracts::{JsonObject, JsonValue};
use runx_parser::SkillMcpServer;

use crate::credentials::SecretEnv;
use crate::process_invocation::PreparedProcessInvocation;

#[derive(Debug, PartialEq)]
pub struct McpToolCallRequest {
    pub server: SkillMcpServer,
    pub tool: String,
    pub arguments: JsonObject,
    pub timeout: Duration,
    pub process: PreparedProcessInvocation,
    pub secret_env: SecretEnv,
}

#[derive(Debug, PartialEq)]
pub struct McpListToolsRequest {
    pub server: SkillMcpServer,
    pub timeout: Duration,
    pub process: PreparedProcessInvocation,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpToolDescriptor {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<JsonObject>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpServerOptions {
    pub package_name: String,
    pub package_version: String,
    pub tools: Vec<McpServerTool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct McpServerExecutionOptions {
    pub runner: Option<String>,
    pub receipt_dir: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    /// Credential deliveries resolved once at server startup, keyed by the
    /// canonical skill path they may serve.
    pub credential_deliveries: BTreeMap<PathBuf, crate::credentials::CredentialDelivery>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpServerTool {
    pub name: String,
    pub description: String,
    pub input_schema: JsonObject,
    pub required_scopes: Vec<String>,
    pub result: McpServerToolBehavior,
}

#[derive(Clone, Debug, PartialEq)]
pub enum McpServerToolBehavior {
    Fixed(McpToolResult),
    Skill(Box<McpServerSkillExecution>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpServerSkillExecution {
    pub skill_path: PathBuf,
    pub skill_name: String,
    pub runner: String,
    pub package_digest: String,
    pub execution_closure_digest: String,
    pub receipt_dir: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub credential_delivery: crate::credentials::CredentialDelivery,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpToolResult {
    pub content: Vec<McpContent>,
    pub structured_content: Option<JsonObject>,
    pub is_error: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpContent {
    pub text: String,
}

#[derive(Debug)]
pub struct McpServerError {
    message: String,
}

impl McpServerError {
    pub(super) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for McpServerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for McpServerError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpTransportError {
    kind: McpTransportErrorKind,
    message: String,
}

impl McpTransportError {
    #[must_use]
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            kind: McpTransportErrorKind::Failed,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn tool_error(code: i64, message: impl Into<String>) -> Self {
        Self {
            kind: McpTransportErrorKind::ToolError(code),
            message: message.into(),
        }
    }

    #[must_use]
    pub fn timeout(timeout: Duration) -> Self {
        let timeout_ms = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
        Self {
            kind: McpTransportErrorKind::Timeout,
            message: format!("MCP call timed out after {timeout_ms}ms."),
        }
    }

    #[must_use]
    pub fn sanitized_message(&self) -> String {
        match self.kind {
            McpTransportErrorKind::ToolError(code) => {
                format!("MCP tool returned error {code}.")
            }
            McpTransportErrorKind::Timeout => self.message.clone(),
            McpTransportErrorKind::Failed => "MCP adapter failed.".to_owned(),
        }
    }

    #[cfg(all(test, feature = "mcp"))]
    #[must_use]
    pub(super) fn message_for_test(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum McpTransportErrorKind {
    ToolError(i64),
    Timeout,
    Failed,
}

pub trait McpTransport {
    fn call_tool(&self, request: McpToolCallRequest) -> Result<JsonValue, McpTransportError>;
}

impl<T> McpTransport for &T
where
    T: McpTransport + ?Sized,
{
    fn call_tool(&self, request: McpToolCallRequest) -> Result<JsonValue, McpTransportError> {
        (**self).call_tool(request)
    }
}
