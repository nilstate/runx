// Module rationale: the client-side transport keeps stdio
// framing, response buffering, and bounded read/write helpers adjacent to the
// transport implementations they coordinate.
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use runx_contracts::{JsonObject, JsonValue};
use serde_json::{self, Value as JsonWireValue};

use crate::process::{OwnedTokioProcess, TokioProcessSpec, spawn_tokio_process};
#[cfg(unix)]
use crate::process::{ProcessSignal, signal_process_group_id};
use crate::process_invocation::PreparedProcessInvocation;

use super::arguments::js_string;
use super::rmcp_content_length::{RmcpContentLengthTransport, RmcpTransportErrorState};
use super::types::{
    McpListToolsRequest, McpToolCallRequest, McpToolDescriptor, McpTransport, McpTransportError,
};

// MCP may carry a fully serialized native data result plus JSON-RPC framing.
// Keep that protocol envelope bounded without imposing the old 1 MiB ceiling
// on otherwise valid operator results.
const MAX_CLIENT_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CLIENT_STDERR_BYTES: usize = 256 * 1024;
const FORCE_KILL_GRACE: Duration = Duration::from_millis(100);
const MAX_POOLED_MCP_SESSIONS: usize = 8;
const MAX_POOLED_MCP_SESSION_IDLE: Duration = Duration::from_secs(300);
static MCP_CLIENT_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

#[derive(Clone, Copy, Debug, Default)]
pub struct FixtureMcpTransport;

impl FixtureMcpTransport {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl McpTransport for FixtureMcpTransport {
    fn call_tool(&self, request: McpToolCallRequest) -> Result<JsonValue, McpTransportError> {
        match request.tool.as_str() {
            "echo" => Ok(text_content(js_string(request.arguments.get("message")))),
            "env" => Ok(text_content(mcp_env_value(&request))),
            "fail" => Err(McpTransportError::tool_error(
                -32000,
                format!(
                    "fixture failure: {}",
                    js_string(request.arguments.get("message"))
                ),
            )),
            "sleep" => Err(McpTransportError::timeout(request.timeout)),
            "malformed-json" => Err(McpTransportError::failed("MCP server sent invalid JSON.")),
            _ => Err(McpTransportError::tool_error(-32601, "tool not found")),
        }
    }
}

fn mcp_env_value(request: &McpToolCallRequest) -> String {
    let name = js_string(request.arguments.get("name"));
    request
        .process
        .env
        .get(&name)
        .cloned()
        .or_else(|| request.secret_env.get(&name).map(str::to_owned))
        .unwrap_or_default()
}

fn text_content(text: String) -> JsonValue {
    JsonValue::Object(
        [(
            "content".to_owned(),
            JsonValue::Array(vec![JsonValue::Object(
                [
                    ("type".to_owned(), JsonValue::String("text".to_owned())),
                    ("text".to_owned(), JsonValue::String(text)),
                ]
                .into(),
            )]),
        )]
        .into(),
    )
}

#[derive(Clone)]
pub struct ProcessMcpTransport {
    session_manager: Arc<Mutex<McpSessionManager>>,
    spawn_count: Arc<AtomicU64>,
}

impl ProcessMcpTransport {
    #[must_use]
    pub fn new() -> Self {
        Self {
            session_manager: Arc::new(Mutex::new(McpSessionManager::default())),
            spawn_count: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn list_tools(
        &self,
        request: McpListToolsRequest,
    ) -> Result<Vec<McpToolDescriptor>, McpTransportError> {
        block_on_transport_runtime(list_tools_with_rmcp_async(
            request,
            Arc::clone(&self.spawn_count),
        ))
    }

    pub fn reset_session_pool(&self) -> Result<(), McpTransportError> {
        block_on_transport_runtime(reset_mcp_session_pool_async(Arc::clone(
            &self.session_manager,
        )))
    }

    pub fn reset_spawn_count(&self) {
        self.spawn_count.store(0, Ordering::SeqCst);
    }

    #[must_use]
    pub fn spawned_process_count(&self) -> u64 {
        self.spawn_count.load(Ordering::SeqCst)
    }
}

impl Default for ProcessMcpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for ProcessMcpTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProcessMcpTransport")
            .field("spawn_count", &self.spawned_process_count())
            .finish_non_exhaustive()
    }
}

impl McpTransport for ProcessMcpTransport {
    fn call_tool(&self, request: McpToolCallRequest) -> Result<JsonValue, McpTransportError> {
        block_on_transport_runtime(call_tool_with_rmcp_async(
            request,
            Arc::clone(&self.session_manager),
            Arc::clone(&self.spawn_count),
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct McpSessionKey {
    command: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
}

impl McpSessionKey {
    fn from_plan(plan: &PreparedProcessInvocation) -> Self {
        Self {
            command: plan.command.clone(),
            args: plan.args.clone(),
            cwd: plan.cwd.clone(),
            env: plan.env.clone(),
        }
    }
}

type RmcpClientService = rmcp::service::RunningService<rmcp::RoleClient, rmcp::model::ClientInfo>;

struct McpSession {
    child: OwnedTokioProcess,
    service: RmcpClientService,
    _stderr_drain: Option<McpStderrDrain>,
    _active_process: crate::interrupt::ActiveProcessGroup,
}

impl McpSession {
    async fn start(
        plan: &PreparedProcessInvocation,
        spawn_count: &AtomicU64,
    ) -> Result<Self, McpTransportError> {
        let SpawnedMcpServer {
            mut child,
            active_process,
        } = spawn_tokio_mcp_server(plan, spawn_count)?;
        let stderr_drain = drain_tokio_stderr(child.take_stderr());
        let error_state = RmcpTransportErrorState::default();
        let service = match serve_rmcp_client(&mut child, error_state).await {
            Ok(service) => service,
            Err(error) => {
                terminate_tokio_child(&mut child).await;
                return Err(error);
            }
        };
        Ok(Self {
            child,
            service,
            _stderr_drain: stderr_drain,
            _active_process: active_process,
        })
    }

    async fn call_tool(
        &mut self,
        tool: String,
        arguments: JsonObject,
    ) -> Result<JsonValue, McpTransportError> {
        let arguments = rmcp_json_object(arguments)?;
        let result = self
            .service
            .peer()
            .call_tool(rmcp::model::CallToolRequestParams::new(tool).with_arguments(arguments))
            .await
            .map_err(|error| {
                let error_state = RmcpTransportErrorState::default();
                rmcp_service_error(error, &error_state)
            })?;
        rmcp_call_tool_result_json(result)
    }

    async fn close(mut self) {
        let _closed = self
            .service
            .close_with_timeout(Duration::from_millis(100))
            .await;
        terminate_tokio_child(&mut self.child).await;
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

struct McpSessionEntry {
    session: McpSession,
    last_used: Instant,
}

#[derive(Default)]
struct McpSessionManager {
    sessions: BTreeMap<McpSessionKey, McpSessionEntry>,
}

impl McpSessionManager {
    fn take(&mut self, key: &McpSessionKey) -> (Option<McpSession>, Vec<McpSession>) {
        let stale = self.drain_stale();
        let session = self.sessions.remove(key).map(|entry| entry.session);
        (session, stale)
    }

    fn put(&mut self, key: McpSessionKey, session: McpSession) -> Vec<McpSession> {
        let mut stale = self.drain_stale();
        if let Some(replaced) = self.sessions.insert(
            key,
            McpSessionEntry {
                session,
                last_used: Instant::now(),
            },
        ) {
            stale.push(replaced.session);
        }
        while self.sessions.len() > MAX_POOLED_MCP_SESSIONS {
            let Some(oldest_key) = self
                .sessions
                .iter()
                .min_by_key(|(_key, entry)| entry.last_used)
                .map(|(key, _entry)| key.clone())
            else {
                break;
            };
            if let Some(oldest) = self.sessions.remove(&oldest_key) {
                stale.push(oldest.session);
            }
        }
        stale
    }

    fn drain_all(&mut self) -> Vec<McpSession> {
        std::mem::take(&mut self.sessions)
            .into_values()
            .map(|entry| entry.session)
            .collect()
    }

    fn drain_stale(&mut self) -> Vec<McpSession> {
        let now = Instant::now();
        let stale_keys = self
            .sessions
            .iter()
            .filter(|(_key, entry)| {
                now.duration_since(entry.last_used) > MAX_POOLED_MCP_SESSION_IDLE
            })
            .map(|(key, _entry)| key.clone())
            .collect::<Vec<_>>();
        stale_keys
            .into_iter()
            .filter_map(|key| self.sessions.remove(&key).map(|entry| entry.session))
            .collect()
    }
}

fn block_on_transport_runtime<T>(
    future: impl Future<Output = Result<T, McpTransportError>> + Send + 'static,
) -> Result<T, McpTransportError>
where
    T: Send + 'static,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        let join = thread::spawn(move || runtime_for()?.block_on(future));
        return join
            .join()
            .map_err(|_| McpTransportError::failed("MCP client runtime thread failed."))?;
    }
    runtime_for()?.block_on(future)
}

fn runtime_for() -> Result<&'static tokio::runtime::Runtime, McpTransportError> {
    if let Some(runtime) = MCP_CLIENT_RUNTIME.get() {
        return Ok(runtime);
    }
    let built = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| McpTransportError::failed("MCP client runtime initialization failed."))?;
    let _ = MCP_CLIENT_RUNTIME.set(built);
    MCP_CLIENT_RUNTIME
        .get()
        .ok_or_else(|| McpTransportError::failed("MCP client runtime initialization failed."))
}

async fn list_tools_with_rmcp_async(
    request: McpListToolsRequest,
    spawn_count: Arc<AtomicU64>,
) -> Result<Vec<McpToolDescriptor>, McpTransportError> {
    let SpawnedMcpServer {
        mut child,
        active_process: _active_process,
    } = spawn_tokio_mcp_server(&request.process, &spawn_count)?;
    let _stderr_drain = drain_tokio_stderr(child.take_stderr());
    let result = tokio::time::timeout(request.timeout, async {
        let error_state = RmcpTransportErrorState::default();
        let mut service = serve_rmcp_client(&mut child, error_state.clone()).await?;
        let tools = service
            .peer()
            .list_all_tools()
            .await
            .map_err(|error| rmcp_service_error(error, &error_state))?;
        let _closed = service.close_with_timeout(Duration::from_millis(100)).await;
        tools
            .into_iter()
            .map(mcp_tool_descriptor_from_rmcp)
            .collect::<Result<Vec<_>, _>>()
    })
    .await;
    terminate_tokio_child(&mut child).await;
    match result {
        Ok(result) => result,
        Err(_) => Err(McpTransportError::timeout(request.timeout)),
    }
}

async fn call_tool_with_rmcp_async(
    mut request: McpToolCallRequest,
    session_manager: Arc<Mutex<McpSessionManager>>,
    spawn_count: Arc<AtomicU64>,
) -> Result<JsonValue, McpTransportError> {
    if !request.secret_env.is_empty() {
        for (name, value) in request.secret_env.iter() {
            request
                .process
                .env
                .insert(name.to_owned(), value.to_owned());
        }
        let timeout = request.timeout;
        return call_tool_with_timeout(
            timeout,
            call_tool_with_one_shot_rmcp_session(request, spawn_count),
        )
        .await;
    }
    let timeout = request.timeout;
    call_tool_with_timeout(
        timeout,
        call_tool_with_pooled_rmcp_session(request, session_manager, spawn_count),
    )
    .await
}

async fn call_tool_with_timeout(
    timeout: Duration,
    call: impl Future<Output = Result<JsonValue, McpTransportError>>,
) -> Result<JsonValue, McpTransportError> {
    let result = tokio::time::timeout(timeout, call).await;
    match result {
        Ok(result) => result,
        Err(_) => Err(McpTransportError::timeout(timeout)),
    }
}

async fn call_tool_with_pooled_rmcp_session(
    request: McpToolCallRequest,
    session_manager: Arc<Mutex<McpSessionManager>>,
    spawn_count: Arc<AtomicU64>,
) -> Result<JsonValue, McpTransportError> {
    if !request.process.cleanup_paths.is_empty() {
        return call_tool_with_one_shot_rmcp_session(request, spawn_count).await;
    }

    let key = McpSessionKey::from_plan(&request.process);
    let (session, stale) = {
        let mut manager = lock_session_manager(&session_manager)?;
        manager.take(&key)
    };
    close_mcp_sessions(stale).await;

    let mut session = match session {
        Some(session) => session,
        None => McpSession::start(&request.process, &spawn_count).await?,
    };
    let result = session.call_tool(request.tool, request.arguments).await;
    match result {
        Ok(value) => {
            let stale = {
                let mut manager = lock_session_manager(&session_manager)?;
                manager.put(key, session)
            };
            close_mcp_sessions(stale).await;
            Ok(value)
        }
        Err(error) => {
            session.close().await;
            Err(error)
        }
    }
}

async fn call_tool_with_one_shot_rmcp_session(
    request: McpToolCallRequest,
    spawn_count: Arc<AtomicU64>,
) -> Result<JsonValue, McpTransportError> {
    let mut session = McpSession::start(&request.process, &spawn_count).await?;
    let result = session.call_tool(request.tool, request.arguments).await;
    session.close().await;
    result
}

async fn reset_mcp_session_pool_async(
    session_manager: Arc<Mutex<McpSessionManager>>,
) -> Result<(), McpTransportError> {
    let sessions = {
        let mut manager = lock_session_manager(&session_manager)?;
        manager.drain_all()
    };
    close_mcp_sessions(sessions).await;
    Ok(())
}

async fn close_mcp_sessions(sessions: Vec<McpSession>) {
    for session in sessions {
        session.close().await;
    }
}

fn lock_session_manager(
    session_manager: &Arc<Mutex<McpSessionManager>>,
) -> Result<MutexGuard<'_, McpSessionManager>, McpTransportError> {
    session_manager
        .lock()
        .map_err(|_| McpTransportError::failed("MCP session manager lock failed."))
}

async fn serve_rmcp_client(
    child: &mut OwnedTokioProcess,
    error_state: RmcpTransportErrorState,
) -> Result<
    rmcp::service::RunningService<rmcp::RoleClient, rmcp::model::ClientInfo>,
    McpTransportError,
> {
    let stdout = child
        .take_stdout()
        .ok_or_else(|| McpTransportError::failed("MCP server stdout unavailable."))?;
    let stdin = child
        .take_stdin()
        .ok_or_else(|| McpTransportError::failed("MCP server stdin unavailable."))?;
    let transport = RmcpContentLengthTransport::new(
        stdout,
        stdin,
        MAX_CLIENT_RESPONSE_BYTES,
        error_state.clone(),
    );
    serve_rmcp_transport(transport, &error_state).await
}

async fn serve_rmcp_transport<T, E>(
    transport: T,
    error_state: &RmcpTransportErrorState,
) -> Result<
    rmcp::service::RunningService<rmcp::RoleClient, rmcp::model::ClientInfo>,
    McpTransportError,
>
where
    T: rmcp::transport::Transport<rmcp::RoleClient, Error = E> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    rmcp::serve_client(rmcp::model::ClientInfo::default(), transport)
        .await
        .map_err(|error| rmcp_initialization_error(error, error_state))
}

struct SpawnedMcpServer {
    child: OwnedTokioProcess,
    active_process: crate::interrupt::ActiveProcessGroup,
}

fn spawn_tokio_mcp_server(
    plan: &PreparedProcessInvocation,
    spawn_count: &AtomicU64,
) -> Result<SpawnedMcpServer, McpTransportError> {
    let child = spawn_tokio_process(
        TokioProcessSpec::new("MCP server", plan.command.clone(), plan.cwd.clone())
            .args(plan.args.clone())
            .env(plan.env.clone()),
    )
    .map_err(|error| McpTransportError::failed(error.to_string()))?;
    let process_id = child
        .id()
        .ok_or_else(|| McpTransportError::failed("MCP server process id unavailable."))?;
    let active_process = crate::interrupt::ActiveProcessGroup::register(process_id);
    spawn_count.fetch_add(1, Ordering::SeqCst);
    Ok(SpawnedMcpServer {
        child,
        active_process,
    })
}

#[cfg(unix)]
async fn terminate_tokio_child(child: &mut OwnedTokioProcess) {
    signal_tokio_process_group(child, ProcessSignal::Terminate);
    if tokio::time::timeout(FORCE_KILL_GRACE, child.wait())
        .await
        .is_ok()
    {
        return;
    }
    signal_tokio_process_group(child, ProcessSignal::Force);
    let _ = child.wait().await;
}

#[cfg(not(unix))]
async fn terminate_tokio_child(child: &mut OwnedTokioProcess) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

#[cfg(unix)]
fn signal_tokio_process_group(child: &mut OwnedTokioProcess, signal: ProcessSignal) {
    let Some(pid) = child.id() else {
        return;
    };
    let _sent = signal_process_group_id(pid, signal);
}

fn drain_tokio_stderr(stderr: Option<tokio::process::ChildStderr>) -> Option<McpStderrDrain> {
    stderr.map(spawn_stderr_drain)
}

struct McpStderrDrain {
    _state: Arc<Mutex<McpStderrDiagnostic>>,
    _task: tokio::task::JoinHandle<()>,
}

impl McpStderrDrain {
    #[cfg(all(test, feature = "mcp"))]
    async fn finish(self) -> Option<McpStderrDiagnosticSnapshot> {
        let Self {
            _state: state,
            _task: task,
        } = self;
        let _ = task.await;
        state.lock().ok().map(|diagnostic| diagnostic.snapshot())
    }
}

#[derive(Default)]
struct McpStderrDiagnostic {
    read_total: u64,
    tail: VecDeque<u8>,
}

impl McpStderrDiagnostic {
    fn push(&mut self, chunk: &[u8]) {
        self.read_total = self
            .read_total
            .saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if chunk.len() >= MAX_CLIENT_STDERR_BYTES {
            self.tail.clear();
            self.tail.extend(
                chunk[chunk.len() - MAX_CLIENT_STDERR_BYTES..]
                    .iter()
                    .copied(),
            );
            return;
        }
        let excess = self
            .tail
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(MAX_CLIENT_STDERR_BYTES);
        for _ in 0..excess {
            let _ = self.tail.pop_front();
        }
        self.tail.extend(chunk.iter().copied());
    }

    #[cfg(all(test, feature = "mcp"))]
    fn snapshot(&self) -> McpStderrDiagnosticSnapshot {
        McpStderrDiagnosticSnapshot {
            read_total: self.read_total,
            retained_bytes: self.tail.len(),
        }
    }
}

#[cfg(all(test, feature = "mcp"))]
struct McpStderrDiagnosticSnapshot {
    read_total: u64,
    retained_bytes: usize,
}

fn spawn_stderr_drain<R>(mut stderr: R) -> McpStderrDrain
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let state = Arc::new(Mutex::new(McpStderrDiagnostic::default()));
    let drain_state = Arc::clone(&state);
    let task = tokio::spawn(async move {
        let mut sink = [0_u8; 8192];
        loop {
            match tokio::io::AsyncReadExt::read(&mut stderr, &mut sink).await {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    if let Ok(mut diagnostic) = drain_state.lock() {
                        diagnostic.push(&sink[..read]);
                    }
                }
            }
        }
    });
    McpStderrDrain {
        _state: state,
        _task: task,
    }
}

fn mcp_tool_descriptor_from_rmcp(
    tool: rmcp::model::Tool,
) -> Result<McpToolDescriptor, McpTransportError> {
    Ok(McpToolDescriptor {
        name: tool.name.into_owned(),
        description: tool.description.map(std::borrow::Cow::into_owned),
        input_schema: Some(runx_json_object(JsonWireValue::Object(
            (*tool.input_schema).clone(),
        ))?),
    })
}

fn rmcp_call_tool_result_json(
    result: rmcp::model::CallToolResult,
) -> Result<JsonValue, McpTransportError> {
    let value = serde_json::to_value(result)
        .map_err(|_| McpTransportError::failed("MCP response serialization failed."))?;
    serde_json::from_value(value)
        .map_err(|_| McpTransportError::failed("MCP response conversion failed."))
}

fn rmcp_json_object(value: JsonObject) -> Result<rmcp::model::JsonObject, McpTransportError> {
    match serde_json::to_value(value)
        .map_err(|_| McpTransportError::failed("MCP request conversion failed."))?
    {
        JsonWireValue::Object(record) => Ok(record),
        _ => Err(McpTransportError::failed("MCP request conversion failed.")),
    }
}

fn runx_json_object(value: JsonWireValue) -> Result<JsonObject, McpTransportError> {
    serde_json::from_value(value)
        .map_err(|_| McpTransportError::failed("MCP response conversion failed."))
}

fn rmcp_service_error(
    error: rmcp::ServiceError,
    error_state: &RmcpTransportErrorState,
) -> McpTransportError {
    if let Some(message) = error_state.take() {
        return McpTransportError::failed(message);
    }
    match error {
        rmcp::ServiceError::McpError(error) => {
            McpTransportError::tool_error(i64::from(error.code.0), "MCP server returned error.")
        }
        _ => McpTransportError::failed("MCP server request failed."),
    }
}

fn rmcp_initialization_error(
    _error: rmcp::service::ClientInitializeError,
    error_state: &RmcpTransportErrorState,
) -> McpTransportError {
    if let Some(message) = error_state.take() {
        return McpTransportError::failed(message);
    }
    McpTransportError::failed("MCP client initialization failed.")
}

#[cfg(all(test, feature = "mcp"))]
mod rmcp_transport_tests {
    use std::time::Duration;

    use rmcp::transport::Transport;
    use tokio::io::AsyncWriteExt;

    use super::{
        MAX_CLIENT_RESPONSE_BYTES, MAX_CLIENT_STDERR_BYTES, RmcpContentLengthTransport,
        RmcpTransportErrorState, serve_rmcp_transport, spawn_stderr_drain,
    };

    // Function rationale: these adjacent transport
    // regression tests share one in-memory Content-Length fixture.
    #[test]
    fn rmcp_receive_records_malformed_json_as_transport_error() {
        let message = receive_error_message(b"Content-Length: 1\r\n\r\n{");

        assert!(
            message
                .as_deref()
                .is_some_and(|message| message.contains("EOF while parsing an object")),
            "{message:?}"
        );
    }

    #[test]
    fn rmcp_receive_records_missing_content_length_as_transport_error() {
        let message = receive_error_message(b"X-Test: true\r\n\r\n{}");

        assert_eq!(
            message.as_deref(),
            Some("MCP message missing Content-Length.")
        );
    }

    #[test]
    fn rmcp_receive_records_oversized_body_as_transport_error() {
        let message = receive_error_message_with_limit(b"Content-Length: 9\r\n\r\n{}", 8);

        assert_eq!(message.as_deref(), Some("MCP message exceeded size limit."));
    }

    #[test]
    fn rmcp_initialize_surfaces_recorded_transport_error() {
        let message = initialize_error_message(b"Content-Length: 1\r\n\r\n{");

        assert!(
            message
                .as_deref()
                .is_some_and(|message| message.contains("EOF while parsing an object")),
            "{message:?}"
        );
    }

    #[test]
    // Function rationale: the stderr-drain test drives a bounded
    // async pipe end-to-end to prove bytes are drained beyond the retained tail.
    fn mcp_stderr_drain_continues_after_retained_tail_limit() -> Result<(), String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .map_err(|error| format!("tokio runtime is available: {error}"))?
            .block_on(async move {
                let (mut writer, reader) = tokio::io::duplex(4096);
                let drain = spawn_stderr_drain(reader);
                let total_bytes = MAX_CLIENT_STDERR_BYTES + (64 * 1024);
                let chunk = vec![b'x'; 8192];
                let snapshot = tokio::time::timeout(Duration::from_secs(2), async move {
                    let mut remaining = total_bytes;
                    while remaining > 0 {
                        let write_len = remaining.min(chunk.len());
                        writer
                            .write_all(&chunk[..write_len])
                            .await
                            .map_err(|error| {
                                format!("stderr writer accepts drained bytes: {error}")
                            })?;
                        remaining -= write_len;
                    }
                    drop(writer);
                    drain
                        .finish()
                        .await
                        .ok_or_else(|| "stderr diagnostic snapshot is available".to_owned())
                })
                .await
                .map_err(|_| {
                    "stderr drain kept consuming after the retained tail filled".to_owned()
                })??;

                assert_eq!(
                    snapshot.read_total,
                    u64::try_from(total_bytes)
                        .map_err(|error| format!("test byte count fits in u64: {error}"))?
                );
                assert_eq!(snapshot.retained_bytes, MAX_CLIENT_STDERR_BYTES);
                Ok(())
            })
    }

    fn initialize_error_message(bytes: &'static [u8]) -> Option<String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .ok()?
            .block_on(async move {
                let (mut writer, reader) = tokio::io::duplex(bytes.len().max(1));
                writer.write_all(bytes).await.ok()?;
                drop(writer);

                let error_state = RmcpTransportErrorState::default();
                let transport = RmcpContentLengthTransport::new(
                    reader,
                    tokio::io::sink(),
                    MAX_CLIENT_RESPONSE_BYTES,
                    error_state.clone(),
                );

                serve_rmcp_transport(transport, &error_state)
                    .await
                    .err()
                    .map(|error| error.message_for_test().to_owned())
            })
    }

    fn receive_error_message(bytes: &'static [u8]) -> Option<String> {
        receive_error_message_with_limit(bytes, MAX_CLIENT_RESPONSE_BYTES)
    }

    fn receive_error_message_with_limit(bytes: &[u8], response_limit: usize) -> Option<String> {
        let bytes = bytes.to_vec();
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .ok()?
            .block_on(async move {
                let (mut writer, reader) = tokio::io::duplex(bytes.len().max(1));
                writer.write_all(&bytes).await.ok()?;
                drop(writer);

                let error_state = RmcpTransportErrorState::default();
                let mut transport = RmcpContentLengthTransport::new(
                    reader,
                    tokio::io::sink(),
                    response_limit,
                    error_state.clone(),
                );

                let message = Transport::<rmcp::RoleClient>::receive(&mut transport).await;
                assert!(message.is_none());
                error_state.take()
            })
    }
}
