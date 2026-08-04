#[cfg(not(feature = "mcp"))]
fn main() {
    use std::io::Write as _;

    let _ignored = writeln!(
        std::io::stderr().lock(),
        "runx-mcp-session-probe requires the runx-runtime mcp feature"
    );
    std::process::exit(1);
}

#[cfg(feature = "mcp")]
fn main() {
    if let Err(error) = mcp_probe::run() {
        use std::io::Write as _;

        let _ignored = writeln!(std::io::stderr().lock(), "{error}");
        std::process::exit(1);
    }
}

#[cfg(feature = "mcp")]
mod mcp_probe {
    use std::collections::BTreeMap;
    use std::io::Write as _;
    use std::path::PathBuf;
    use std::time::Instant;

    use runx_contracts::{JsonObject, JsonValue};
    use runx_parser::SkillMcpServer;
    use runx_runtime::adapters::mcp::{McpToolCallRequest, McpTransport, ProcessMcpTransport};
    use runx_runtime::credentials::SecretEnv;
    use runx_runtime::process_invocation::PreparedProcessInvocation;
    use serde_json::json;

    const REUSE_WARMUP_CALL_COUNT: usize = 4;
    const REUSE_SAMPLE_COUNT: usize = 20;
    const REUSE_CALLS_PER_SAMPLE: usize = 10;

    pub(super) fn run() -> Result<(), String> {
        let mode = std::env::args()
            .nth(1)
            .ok_or_else(|| "usage: runx-mcp-session-probe <start|reuse>".to_owned())?;
        let transport = ProcessMcpTransport::default();
        let samples = match mode.as_str() {
            "start" => measure_session_start(&transport)?,
            "reuse" => measure_session_reuse(&transport)?,
            other => return Err(format!("unknown MCP session probe mode '{other}'")),
        };
        let sorted = sorted_samples(&samples.durations_ns);
        let mean_ns = samples.durations_ns.iter().sum::<f64>() / samples.durations_ns.len() as f64;
        let output = json!({
            "source": "mcp_runtime",
            "unit": "iterations_per_second",
            "mean_ns": mean_ns,
            "p50_ns": percentile(&sorted, 0.50),
            "p95_ns": percentile(&sorted, 0.95),
            "p99_ns": percentile(&sorted, 0.99),
            "throughput": 1_000_000_000_f64 / mean_ns,
            "sample_count": samples.durations_ns.len(),
            "spawn_count": samples.spawn_count,
            "call_count": samples.call_count,
        });
        writeln!(std::io::stdout().lock(), "{output}").map_err(|error| error.to_string())?;
        transport
            .reset_session_pool()
            .map_err(|error| error.sanitized_message())?;
        Ok(())
    }

    struct ProbeSamples {
        durations_ns: Vec<f64>,
        spawn_count: u64,
        call_count: u64,
    }

    fn measure_session_start(transport: &ProcessMcpTransport) -> Result<ProbeSamples, String> {
        let mut durations_ns = Vec::new();
        let mut max_spawn_count = 0;
        for index in 0..3 {
            transport
                .reset_session_pool()
                .map_err(|error| error.sanitized_message())?;
            transport.reset_spawn_count();
            durations_ns.push(timed_echo(
                transport,
                "start-scope",
                &format!("start-{index}"),
            )?);
            max_spawn_count = max_spawn_count.max(transport.spawned_process_count());
        }
        Ok(ProbeSamples {
            durations_ns,
            spawn_count: max_spawn_count,
            call_count: 1,
        })
    }

    fn measure_session_reuse(transport: &ProcessMcpTransport) -> Result<ProbeSamples, String> {
        transport
            .reset_session_pool()
            .map_err(|error| error.sanitized_message())?;
        transport.reset_spawn_count();
        for index in 0..REUSE_WARMUP_CALL_COUNT {
            invoke_echo(transport, "reuse-scope", &format!("warm-{index}"))?;
        }
        let mut durations_ns = Vec::new();
        for sample in 0..REUSE_SAMPLE_COUNT {
            let started = Instant::now();
            for call in 0..REUSE_CALLS_PER_SAMPLE {
                invoke_echo(transport, "reuse-scope", &format!("reuse-{sample}-{call}"))?;
            }
            durations_ns.push(
                started.elapsed().as_secs_f64() * 1_000_000_000_f64 / REUSE_CALLS_PER_SAMPLE as f64,
            );
        }
        Ok(ProbeSamples {
            durations_ns,
            spawn_count: transport.spawned_process_count(),
            call_count: (REUSE_WARMUP_CALL_COUNT + REUSE_SAMPLE_COUNT * REUSE_CALLS_PER_SAMPLE)
                as u64,
        })
    }

    fn timed_echo(
        transport: &ProcessMcpTransport,
        scope: &str,
        message: &str,
    ) -> Result<f64, String> {
        let started = Instant::now();
        invoke_echo(transport, scope, message)?;
        Ok(started.elapsed().as_secs_f64() * 1_000_000_000_f64)
    }

    fn invoke_echo(
        transport: &ProcessMcpTransport,
        scope: &str,
        message: &str,
    ) -> Result<(), String> {
        let result = transport
            .call_tool(tool_call(scope, message)?)
            .map_err(|error| error.sanitized_message())?;
        let Some(stdout) = tool_result_text(&result) else {
            return Err(format!(
                "MCP probe call returned non-text result: {result:?}"
            ));
        };
        if stdout != message {
            return Err(format!(
                "MCP probe call returned unexpected stdout '{}'",
                stdout
            ));
        }
        Ok(())
    }

    fn tool_call(scope: &str, message: &str) -> Result<McpToolCallRequest, String> {
        let mut inputs = JsonObject::new();
        inputs.insert("message".to_owned(), JsonValue::String(message.to_owned()));
        let root = repo_root()?;
        let server = SkillMcpServer {
            command: "node".to_owned(),
            args: vec!["fixtures/skills/mcp-echo/stdio-server.mjs".to_owned()],
            cwd: Some(root.to_string_lossy().into_owned()),
        };
        let mut env = process_env();
        env.insert("RUNX_MCP_SCOPE".to_owned(), scope.to_owned());
        Ok(McpToolCallRequest {
            server,
            tool: "echo".to_owned(),
            arguments: inputs,
            timeout: std::time::Duration::from_secs(5),
            process: PreparedProcessInvocation {
                command: "node".to_owned(),
                args: vec!["fixtures/skills/mcp-echo/stdio-server.mjs".to_owned()],
                cwd: root,
                env,
                metadata: JsonObject::new(),
                cleanup_paths: Vec::new(),
            },
            secret_env: SecretEnv::default(),
        })
    }

    fn tool_result_text(result: &JsonValue) -> Option<&str> {
        let JsonValue::Array(items) = result.as_object()?.get("content")? else {
            return None;
        };
        let first = items.first()?.as_object()?;
        first.get("text")?.as_str()
    }

    fn repo_root() -> Result<PathBuf, String> {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .map_err(|error| format!("repository root is unavailable: {error}"))
    }

    fn process_env() -> BTreeMap<String, String> {
        [
            "PATH",
            "HOME",
            "TMPDIR",
            "TMP",
            "TEMP",
            "SystemRoot",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
        ]
        .into_iter()
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| (name.to_owned(), value))
        })
        .collect()
    }

    fn sorted_samples(samples: &[f64]) -> Vec<f64> {
        let mut sorted = samples.to_vec();
        sorted.sort_by(|left, right| left.total_cmp(right));
        sorted
    }

    fn percentile(sorted: &[f64], percentile_value: f64) -> f64 {
        let index = sorted
            .len()
            .saturating_sub(1)
            .min((sorted.len() as f64 * percentile_value).ceil() as usize - 1);
        sorted[index]
    }
}
