// rust-style-allow: large-file because the JSON-RPC dispatch loop, server
// state, tool-result builders, and host-result projections for `runx mcp
// serve` all sit on the same protocol surface.
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::thread;

use runx_contracts::{JsonObject, JsonValue};
use tokio::sync::mpsc;

use crate::effects::{PROVIDER_PERMISSION_GRANT_ID_ENV, PROVIDER_PERMISSION_GRANTED_SCOPES_ENV};

use super::rmcp_content_length::{RmcpContentLengthTransport, RmcpTransportErrorState};
use super::server_skill::{execute_mcp_server_skill, identifier_segment};
use super::types::{
    McpContent, McpHostRunResult, McpServerError, McpServerOptions, McpServerSkillExecution,
    McpServerTool, McpServerToolBehavior, McpToolResult,
};

const MAX_SERVER_REQUEST_BYTES: usize = 4 * 1024 * 1024;

pub fn serve_mcp_json_rpc(
    input: impl Read + Send + Unpin + 'static,
    output: impl Write + Send + Unpin + 'static,
    options: McpServerOptions,
) -> Result<(), McpServerError> {
    assert_unique_server_tool_names(&options.tools)?;
    serve_mcp_json_rpc_with_rmcp(input, output, options)
}

pub fn mcp_tool_result_from_host_result(result: McpHostRunResult) -> McpToolResult {
    match result {
        McpHostRunResult::Completed {
            skill_name,
            output,
            receipt_id,
            runx,
        } => completed_mcp_tool_result(skill_name, output, receipt_id, runx),
        McpHostRunResult::NeedsAgent {
            skill_name,
            run_id,
            request_count,
            runx,
        } => needs_agent_mcp_tool_result(skill_name, run_id, request_count, runx),
        McpHostRunResult::Denied {
            skill_name,
            receipt_id,
            runx,
        } => denied_mcp_tool_result(skill_name, receipt_id, runx),
        McpHostRunResult::Escalated {
            skill_name,
            receipt_id,
            error,
            runx,
        } => escalated_mcp_tool_result(skill_name, receipt_id, error, runx),
        McpHostRunResult::Failed {
            skill_name,
            receipt_id,
            error,
            runx,
        } => failed_mcp_tool_result(skill_name, receipt_id, error, runx),
    }
}

fn completed_mcp_tool_result(
    skill_name: String,
    output: String,
    receipt_id: String,
    runx: JsonObject,
) -> McpToolResult {
    let text = if output.trim().is_empty() {
        format!("{skill_name} completed. Inspect receipt {receipt_id}.")
    } else {
        output
    };
    mcp_host_tool_result(text, runx, false)
}

fn needs_agent_mcp_tool_result(
    skill_name: String,
    run_id: String,
    request_count: usize,
    runx: JsonObject,
) -> McpToolResult {
    mcp_host_tool_result(
        format!(
            "{skill_name} needs agent input at {run_id}. Continue by rerunning the same skill with --run-id {run_id} --answers answers.json after resolving {request_count} request(s)."
        ),
        runx,
        false,
    )
}

fn denied_mcp_tool_result(
    skill_name: String,
    receipt_id: Option<String>,
    runx: JsonObject,
) -> McpToolResult {
    let text = match receipt_id {
        Some(receipt_id) => format!("{skill_name} was denied by policy (receipt {receipt_id})."),
        None => format!("{skill_name} was denied by policy."),
    };
    mcp_host_tool_result(text, runx, true)
}

fn escalated_mcp_tool_result(
    skill_name: String,
    receipt_id: String,
    error: String,
    runx: JsonObject,
) -> McpToolResult {
    mcp_host_tool_result(
        format!("{skill_name} escalated. Inspect receipt {receipt_id}. {error}")
            .trim()
            .to_owned(),
        runx,
        true,
    )
}

fn failed_mcp_tool_result(
    skill_name: String,
    receipt_id: Option<String>,
    error: String,
    runx: JsonObject,
) -> McpToolResult {
    mcp_host_tool_result(
        format!(
            "{skill_name} failed. Inspect receipt {}. {error}",
            receipt_id.unwrap_or_else(|| "n/a".to_owned())
        )
        .trim()
        .to_owned(),
        runx,
        true,
    )
}

fn mcp_host_tool_result(text: String, runx: JsonObject, is_error: bool) -> McpToolResult {
    McpToolResult {
        content: vec![McpContent { text }],
        structured_content: Some(runx_content(runx)),
        is_error,
    }
}

fn runx_content(runx: JsonObject) -> JsonObject {
    [("runx".to_owned(), JsonValue::Object(runx))].into()
}

fn serve_mcp_json_rpc_with_rmcp(
    input: impl Read + Send + Unpin + 'static,
    output: impl Write + Send + Unpin + 'static,
    options: McpServerOptions,
) -> Result<(), McpServerError> {
    block_on_rmcp_server(input, output, options)
}

fn block_on_rmcp_server<R, W>(
    input: R,
    output: W,
    options: McpServerOptions,
) -> Result<(), McpServerError>
where
    R: Read + Send + Unpin + 'static,
    W: Write + Send + Unpin + 'static,
{
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_io()
        .enable_time()
        .build()
        .map_err(|error| {
            McpServerError::new(format!("MCP server runtime initialization failed: {error}"))
        })?
        .block_on(serve_mcp_json_rpc_with_rmcp_async(input, output, options))
}

async fn serve_mcp_json_rpc_with_rmcp_async<R, W>(
    input: R,
    output: W,
    options: McpServerOptions,
) -> Result<(), McpServerError>
where
    R: Read + Send + Unpin + 'static,
    W: Write + Send + Unpin + 'static,
{
    let error_state = RmcpTransportErrorState::default();
    let transport = RmcpContentLengthTransport::new(
        ChannelAsyncRead::spawn(input),
        BlockingAsyncWrite::new(output),
        MAX_SERVER_REQUEST_BYTES,
        error_state.clone(),
    );
    let service = RmcpProofServer::from_options(options);
    let running = rmcp::serve_server(service, transport)
        .await
        .map_err(|error| {
            McpServerError::new(format!(
                "MCP rmcp server initialization failed: {}",
                error_state.take().unwrap_or_else(|| error.to_string())
            ))
        })?;
    let wait_result = running.waiting().await;
    if let Some(message) = error_state.take() {
        return Err(McpServerError::new(format!(
            "MCP rmcp server task failed: {message}"
        )));
    }
    wait_result
        .map(|_reason| ())
        .map_err(|error| McpServerError::new(format!("MCP rmcp server task failed: {error}")))
}

pub(super) struct RmcpProofServer {
    state: McpServerState,
}

impl RmcpProofServer {
    /// Build a fresh governed server from options. Used by both the stdio path
    /// and the streamable-HTTP service factory.
    pub(super) fn from_options(options: McpServerOptions) -> Self {
        Self {
            state: McpServerState::new(options),
        }
    }
}

impl rmcp::ServerHandler for RmcpProofServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        let (package_name, package_version) = (
            self.state.options.package_name.clone(),
            self.state.options.package_version.clone(),
        );
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_protocol_version(rmcp::model::ProtocolVersion::V_2025_06_18)
        .with_server_info(rmcp::model::Implementation::new(
            package_name,
            package_version,
        ))
    }

    fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> impl Future<Output = Result<rmcp::model::ListToolsResult, rmcp::ErrorData>> + Send + '_
    {
        let result = self
            .state
            .options
            .tools
            .iter()
            .map(rmcp_tool_from_server_tool)
            .collect::<Result<Vec<_>, _>>()
            .map(rmcp::model::ListToolsResult::with_all_items);
        std::future::ready(result)
    }

    fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> impl Future<Output = Result<rmcp::model::CallToolResult, rmcp::ErrorData>> + Send + '_
    {
        let prepared = (|| {
            let arguments = match request.arguments {
                Some(arguments) => runx_json_object(arguments).map_err(rmcp_invalid_params)?,
                None => JsonObject::new(),
            };
            prepare_rmcp_tool_call(&self.state, &request.name, arguments)
        })();
        execute_rmcp_tool_call(prepared)
    }

    fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
        self.state
            .options
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .cloned()
            .and_then(|tool| rmcp_tool_from_server_tool(&tool).ok())
    }
}

enum PreparedMcpToolCall {
    Fixed(McpToolResult),
    Skill {
        run_id: String,
        execution: Box<McpServerSkillExecution>,
        arguments: JsonObject,
    },
}

fn prepare_rmcp_tool_call(
    state: &McpServerState,
    name: &str,
    arguments: JsonObject,
) -> Result<PreparedMcpToolCall, rmcp::ErrorData> {
    let Some(tool) = state
        .options
        .tools
        .iter()
        .find(|tool| tool.name == name)
        .cloned()
    else {
        return Err(rmcp::ErrorData::new(
            rmcp::model::ErrorCode::METHOD_NOT_FOUND,
            format!("tool not found: {name}"),
            None,
        ));
    };
    match tool.result {
        McpServerToolBehavior::Fixed(result) => Ok(PreparedMcpToolCall::Fixed(result)),
        McpServerToolBehavior::Skill(execution) => {
            admit_mcp_tool_scopes(&tool.name, &tool.required_scopes, &execution.env)?;
            Ok(PreparedMcpToolCall::Skill {
                run_id: state.next_run_id(&execution.skill.name),
                execution,
                arguments,
            })
        }
    }
}

fn admit_mcp_tool_scopes(
    tool_name: &str,
    required_scopes: &[String],
    env: &BTreeMap<String, String>,
) -> Result<(), rmcp::ErrorData> {
    if required_scopes.is_empty() {
        return Ok(());
    }
    let Some(grant_id) = env
        .get(PROVIDER_PERMISSION_GRANT_ID_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return Err(rmcp_invalid_params(format!(
            "MCP tool '{tool_name}' requires scopes [{}], but no operator provider grant id was supplied in {PROVIDER_PERMISSION_GRANT_ID_ENV}",
            required_scopes.join(", ")
        )));
    };
    let granted_scopes = env
        .get(PROVIDER_PERMISSION_GRANTED_SCOPES_ENV)
        .map(|value| parse_scope_list(value))
        .unwrap_or_default();
    let granted = granted_scopes.iter().collect::<BTreeSet<_>>();
    let missing = required_scopes
        .iter()
        .filter(|scope| !granted.contains(scope))
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(rmcp_invalid_params(format!(
        "MCP tool '{tool_name}' requires scopes [{}], but operator grant '{}' only provides [{}]",
        required_scopes.join(", "),
        grant_id,
        granted_scopes.join(", ")
    )))
}

fn parse_scope_list(value: &str) -> Vec<String> {
    value
        .split([',', '\n', '\t', ' '])
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_owned)
        .collect()
}

async fn execute_rmcp_tool_call(
    prepared: Result<PreparedMcpToolCall, rmcp::ErrorData>,
) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
    match prepared? {
        PreparedMcpToolCall::Fixed(result) => rmcp_call_tool_result(result),
        PreparedMcpToolCall::Skill {
            run_id,
            execution,
            arguments,
        } => {
            let result = tokio::task::spawn_blocking(move || {
                execute_mcp_server_skill(&run_id, *execution, arguments)
            })
            .await
            .map_err(|error| rmcp_internal_error(format!("MCP tool task failed: {error}")))?;
            match result {
                Ok(result) => rmcp_call_tool_result(result),
                Err(error) => Err(rmcp_internal_error(error.to_string())),
            }
        }
    }
}

fn rmcp_tool_from_server_tool(tool: &McpServerTool) -> Result<rmcp::model::Tool, rmcp::ErrorData> {
    Ok(rmcp::model::Tool::new(
        tool.name.clone(),
        tool.description.clone(),
        Arc::new(rmcp_json_object(tool.input_schema.clone())?),
    ))
}

fn rmcp_call_tool_result(
    result: McpToolResult,
) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
    let content = result
        .content
        .into_iter()
        .map(|entry| rmcp::model::Content::text(entry.text))
        .collect();
    let mut call_result = if result.is_error {
        rmcp::model::CallToolResult::error(content)
    } else {
        rmcp::model::CallToolResult::success(content)
    };
    call_result.structured_content = result
        .structured_content
        .map(|content| serde_json::to_value(content).map_err(rmcp_internal_error))
        .transpose()?;
    Ok(call_result)
}

fn rmcp_json_object(value: JsonObject) -> Result<rmcp::model::JsonObject, rmcp::ErrorData> {
    serde_json::to_value(JsonValue::Object(value))
        .map_err(rmcp_internal_error)?
        .as_object()
        .cloned()
        .ok_or_else(|| {
            rmcp_internal_error("MCP tool input schema did not serialize to a JSON object.")
        })
}

fn runx_json_object(value: rmcp::model::JsonObject) -> Result<JsonObject, serde_json::Error> {
    serde_json::to_vec(&value).and_then(|bytes| serde_json::from_slice(&bytes))
}

fn rmcp_invalid_params(error: impl std::fmt::Display) -> rmcp::ErrorData {
    rmcp::ErrorData::invalid_params(error.to_string(), None)
}

fn rmcp_internal_error(error: impl std::fmt::Display) -> rmcp::ErrorData {
    rmcp::ErrorData::internal_error(error.to_string(), None)
}

struct ChannelAsyncRead {
    receiver: mpsc::Receiver<Result<Vec<u8>, std::io::Error>>,
    pending: Vec<u8>,
    offset: usize,
}

impl ChannelAsyncRead {
    fn spawn<R>(mut input: R) -> Self
    where
        R: Read + Send + 'static,
    {
        let (sender, receiver) = mpsc::channel(8);
        thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match input.read(&mut buffer) {
                    Ok(0) => return,
                    Ok(read) => {
                        if sender.blocking_send(Ok(buffer[..read].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ignored = sender.blocking_send(Err(error));
                        return;
                    }
                }
            }
        });
        Self {
            receiver,
            pending: Vec::new(),
            offset: 0,
        }
    }

    fn copy_pending(&mut self, buf: &mut tokio::io::ReadBuf<'_>) -> bool {
        if self.offset >= self.pending.len() {
            return false;
        }
        let remaining = self.pending.len() - self.offset;
        let copied = remaining.min(buf.remaining());
        buf.put_slice(&self.pending[self.offset..self.offset + copied]);
        self.offset += copied;
        if self.offset >= self.pending.len() {
            self.pending.clear();
            self.offset = 0;
        }
        true
    }
}

impl tokio::io::AsyncRead for ChannelAsyncRead {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        loop {
            if self.copy_pending(buf) {
                return Poll::Ready(Ok(()));
            }
            match self.receiver.poll_recv(cx) {
                Poll::Ready(Some(Ok(bytes))) if bytes.is_empty() => continue,
                Poll::Ready(Some(Ok(bytes))) => {
                    self.pending = bytes;
                    self.offset = 0;
                }
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

struct BlockingAsyncWrite<W> {
    inner: W,
}

impl<W> BlockingAsyncWrite<W> {
    fn new(inner: W) -> Self {
        Self { inner }
    }
}

impl<W> tokio::io::AsyncWrite for BlockingAsyncWrite<W>
where
    W: Write + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        Poll::Ready(self.inner.write(buf))
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Poll::Ready(self.inner.flush())
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Poll::Ready(self.inner.flush())
    }
}

#[derive(Debug)]
pub(super) struct McpServerState {
    options: McpServerOptions,
    next_run_sequence: AtomicU64,
}

impl McpServerState {
    fn new(options: McpServerOptions) -> Self {
        Self {
            options,
            next_run_sequence: AtomicU64::new(0),
        }
    }

    pub(super) fn next_run_id(&self, skill_name: &str) -> String {
        let sequence = self
            .next_run_sequence
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_add(1))
            })
            .map_or(u64::MAX, |previous| previous.saturating_add(1));
        format!("rx_mcp_{}_{}", identifier_segment(skill_name), sequence)
    }
}

fn assert_unique_server_tool_names(tools: &[McpServerTool]) -> Result<(), McpServerError> {
    let mut seen = std::collections::BTreeSet::new();
    for tool in tools {
        if !seen.insert(tool.name.as_str()) {
            return Err(McpServerError::new(format!(
                "runx mcp serve received duplicate tool name '{}'. Serve unique skill names only.",
                tool.name
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;

    #[test]
    fn next_run_id_is_unique_under_concurrent_allocation() -> Result<(), String> {
        let state = Arc::new(McpServerState::new(McpServerOptions {
            package_name: "runx-test".to_owned(),
            package_version: "0.0.0".to_owned(),
            tools: Vec::new(),
        }));
        let worker_count = 8;
        let ids_per_worker = 64;
        let barrier = Arc::new(Barrier::new(worker_count));

        let handles = (0..worker_count)
            .map(|_| {
                let state = Arc::clone(&state);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..ids_per_worker)
                        .map(|_| state.next_run_id("skill.alpha"))
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();

        let mut ids = Vec::new();
        for handle in handles {
            let worker_ids = handle
                .join()
                .map_err(|_| "run-id worker panicked".to_owned())?;
            ids.extend(worker_ids);
        }
        let ids = ids.into_iter().collect::<BTreeSet<_>>();

        assert_eq!(ids.len(), worker_count * ids_per_worker);
        for sequence in 1..=(worker_count * ids_per_worker) {
            assert!(ids.contains(&format!("rx_mcp_skill_alpha_{sequence}")));
        }
        Ok(())
    }

    #[test]
    fn scoped_mcp_tool_requires_operator_grant_before_dispatch() {
        let required_scopes = vec!["repo.read".to_owned(), "issues.write".to_owned()];
        let result = admit_mcp_tool_scopes("github-write", &required_scopes, &BTreeMap::new());
        assert!(
            matches!(&result, Err(error) if error.message.contains("no operator provider grant id")),
            "scoped MCP tool must deny without operator grant id; got: {result:?}"
        );

        let mut env = BTreeMap::from([
            (
                PROVIDER_PERMISSION_GRANT_ID_ENV.to_owned(),
                "grant-gh".to_owned(),
            ),
            (
                PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
                "repo.read".to_owned(),
            ),
        ]);
        let result = admit_mcp_tool_scopes("github-write", &required_scopes, &env);
        assert!(
            matches!(&result, Err(error) if error.message.contains("issues.write")),
            "scoped MCP tool must deny missing granted scopes before dispatch; got: {result:?}"
        );

        env.insert(
            PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
            "repo.read,issues.write".to_owned(),
        );
        let result = admit_mcp_tool_scopes("github-write", &required_scopes, &env);
        assert!(
            result.is_ok(),
            "matching operator grant scopes should admit the MCP tool; got: {result:?}"
        );
    }
}
