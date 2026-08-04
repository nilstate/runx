use std::time::Duration;

use runx_contracts::{JsonObject, JsonValue, sha256_hex};

use crate::RuntimeError;
use crate::adapter::{InvocationOutput, InvocationStatus, SkillAdapter, SkillInvocation};
use crate::adapter_pipeline::AdapterExecutionContext;
use crate::credentials::CredentialDelivery;
use crate::process_invocation::prepare_mcp_process_invocation;

use super::arguments::map_mcp_arguments;
use super::transport::ProcessMcpTransport;
use super::types::{McpToolCallRequest, McpTransport};

const DEFAULT_MCP_CALL_TIMEOUT_MS: u64 = 60_000;
const MIN_TIMEOUT_MS: u64 = 50;

#[derive(Clone, Debug)]
pub struct McpAdapter<T = ProcessMcpTransport> {
    transport: T,
}

impl<T> McpAdapter<T> {
    #[must_use]
    pub const fn new(transport: T) -> Self {
        Self { transport }
    }
}

impl Default for McpAdapter<ProcessMcpTransport> {
    fn default() -> Self {
        Self::new(ProcessMcpTransport::default())
    }
}

impl<T> SkillAdapter for McpAdapter<T>
where
    T: McpTransport,
{
    fn adapter_type(&self) -> &'static str {
        "mcp"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<InvocationOutput, RuntimeError> {
        let context = AdapterExecutionContext::start();
        let prepared = match prepare_mcp_tool_call(request, &context)? {
            Ok(prepared) => prepared,
            Err(output) => return Ok(output),
        };
        match self.transport.call_tool(prepared.request) {
            Ok(result) => {
                // MCP results are structured. Redact their decoded values and
                // keys before rendering; redacting the serialized form first can
                // be bypassed by JSON escapes that reconstruct a credential when
                // graph context or receipt projection parses stdout again.
                let projection = super::tool_result::project_mcp_tool_result(&result);
                let mut result = projection.value;
                let mut runx = projection.runx.map(JsonValue::Object);
                prepared.credential_delivery.redact_json_value(&mut result);
                if let Some(runx) = &mut runx {
                    prepared.credential_delivery.redact_json_value(runx);
                }
                let mut metadata = if projection.is_error {
                    prepared.failure_metadata
                } else {
                    prepared.success_metadata
                };
                if let Some(runx) = runx
                    && let Some(JsonValue::Object(mcp)) = metadata.get_mut("mcp")
                {
                    mcp.insert("runx".to_owned(), runx);
                }
                Ok(context.projection().runtime_output(
                    if projection.is_error {
                        InvocationStatus::Failure
                    } else {
                        InvocationStatus::Success
                    },
                    result,
                    projection
                        .is_error
                        .then(|| "MCP tool reported an error.".to_owned()),
                    metadata,
                ))
            }
            Err(error) => Ok(failure(
                prepared
                    .credential_delivery
                    .redact_text(error.sanitized_message()),
                &context,
                prepared.failure_metadata,
            )),
        }
    }
}

#[derive(Debug)]
struct PreparedMcpToolCall {
    request: McpToolCallRequest,
    credential_delivery: CredentialDelivery,
    success_metadata: JsonObject,
    failure_metadata: JsonObject,
}

fn prepare_mcp_tool_call(
    invocation: SkillInvocation,
    context: &AdapterExecutionContext,
) -> Result<Result<PreparedMcpToolCall, InvocationOutput>, RuntimeError> {
    let SkillInvocation {
        source,
        requirements,
        inputs,
        resolved_inputs,
        skill_directory,
        env,
        credential_delivery,
        ..
    } = invocation;
    if source.source_type != runx_parser::SourceKind::Mcp {
        return Err(RuntimeError::UnsupportedAdapter {
            adapter_type: source.source_type.as_str().to_owned(),
        });
    }
    let Some(server) = source.server.clone() else {
        return Ok(Err(missing_mcp_metadata(context)));
    };
    let Some(tool) = source.tool.clone().filter(|tool| !tool.is_empty()) else {
        return Ok(Err(missing_mcp_metadata(context)));
    };
    let arguments = map_mcp_arguments(source.arguments.as_ref(), &inputs, &resolved_inputs)?;
    let process =
        prepare_mcp_process_invocation(&requirements.environment, &server, &skill_directory, &env)?;
    let success_metadata = metadata_for(&source, &process.metadata)?;
    let failure_metadata = metadata_for(&source, &process.metadata)?;
    credential_delivery
        .ensure_environment_disjoint(&process.env)
        .map_err(|error| RuntimeError::InvalidProcessInvocation {
            message: error.to_string(),
        })?;
    Ok(Ok(PreparedMcpToolCall {
        request: McpToolCallRequest {
            server,
            tool,
            arguments,
            timeout: timeout_from_source(source.timeout_seconds),
            process,
            secret_env: credential_delivery.secret_env().clone(),
        },
        credential_delivery,
        success_metadata,
        failure_metadata,
    }))
}

fn missing_mcp_metadata(context: &AdapterExecutionContext) -> InvocationOutput {
    failure(
        "MCP source requires server and tool metadata.",
        context,
        JsonObject::new(),
    )
}

fn metadata_for(
    source: &runx_parser::SkillSource,
    execution_boundary: &JsonObject,
) -> Result<JsonObject, RuntimeError> {
    let mut mcp = JsonObject::new();
    mcp.insert(
        "tool".to_owned(),
        JsonValue::String(source.tool.clone().unwrap_or_default()),
    );
    let server = source.server.as_ref();
    mcp.insert(
        "server_command_hash".to_owned(),
        JsonValue::String(sha256_hex(
            server
                .map(|server| server.command.as_bytes())
                .unwrap_or(b""),
        )),
    );
    let args = serde_json::to_string(&server.map(|server| &server.args))
        .map_err(|source| RuntimeError::json("serializing MCP server args", source))?;
    mcp.insert(
        "server_args_hash".to_owned(),
        JsonValue::String(sha256_hex(args.as_bytes())),
    );

    let mut metadata = JsonObject::new();
    metadata.insert("mcp".to_owned(), JsonValue::Object(mcp));
    metadata.extend(execution_boundary.clone());
    Ok(metadata)
}

pub(super) fn failure(
    message: impl Into<String>,
    context: &AdapterExecutionContext,
    metadata: JsonObject,
) -> InvocationOutput {
    context.projection().failure(message.into(), metadata)
}

fn timeout_from_source(timeout_seconds: Option<u64>) -> Duration {
    let timeout_ms = timeout_seconds
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(DEFAULT_MCP_CALL_TIMEOUT_MS)
        .max(MIN_TIMEOUT_MS);
    Duration::from_millis(timeout_ms)
}
