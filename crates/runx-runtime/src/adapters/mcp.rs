//! MCP (Model Context Protocol) adapter.
//!
//! - `types`: shared data types and the `McpTransport` trait.
//! - `adapter`: the `McpAdapter` `SkillAdapter` entry point.
//! - `transport`: stdio process and fixture client transports.
//! - `framing`: runx-owned Content-Length transport helpers.
//! - `server`: `serve_mcp_json_rpc` and host-result projections.
//! - `server_skill`: server-side skill and graph execution.
//! - `arguments`: argument templating.
//! - `tool_result`: semantic result and protocol-evidence projection.

mod adapter;
mod arguments;
mod framing;
#[cfg(feature = "mcp-http-server")]
mod http_server;
mod rmcp_content_length;
mod server;
mod server_skill;
mod tool_result;
mod transport;
mod types;

pub use adapter::McpAdapter;
pub use arguments::map_mcp_arguments;
#[cfg(feature = "mcp-http-server")]
pub use http_server::{
    DEFAULT_MCP_HTTP_LISTEN_ADDR, McpHttpServerSecurity, generate_mcp_http_bearer_token,
    serve_mcp_http_server, serve_mcp_http_server_blocking,
};
pub use server::{mcp_tool_result_from_run_result, serve_mcp_json_rpc};
pub use tool_result::stringify_mcp_tool_result;
pub use transport::{FixtureMcpTransport, ProcessMcpTransport};
pub use types::{
    McpContent, McpListToolsRequest, McpServerError, McpServerExecutionOptions, McpServerOptions,
    McpServerSkillExecution, McpServerTool, McpServerToolBehavior, McpToolCallRequest,
    McpToolDescriptor, McpToolResult, McpTransport, McpTransportError,
};
