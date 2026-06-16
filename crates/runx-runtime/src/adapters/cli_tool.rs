use std::time::Duration;

use runx_contracts::JsonValue;

use crate::RuntimeError;
use crate::adapter::{
    FanoutExecutionMode, InvocationStatus, SkillAdapter, SkillInvocation, SkillOutput,
};
use crate::adapter_pipeline::{AdapterCapture, AdapterInvocationPlan, AdapterProjection};
use crate::credentials::CredentialDelivery;
use crate::process::{CapturedOutput, ProcessOutcome, ProcessSpec, ProcessStdin, run_process};
use crate::services::SandboxServices;

const OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS: u64 = 60;
#[cfg(test)]
static DEFAULT_TIMEOUT_OVERRIDE_SECONDS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default)]
pub struct CliToolAdapter;

impl SkillAdapter for CliToolAdapter {
    fn adapter_type(&self) -> &'static str {
        "cli-tool"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        let plan = AdapterInvocationPlan::from_invocation(self.adapter_type(), &request);
        let credential_delivery = request.credential_delivery.clone();
        credential_delivery.reject_process_env_boundary(plan.adapter_type())?;
        let sandbox = SandboxServices.process_plan(
            &request.source,
            &request.skill_directory,
            &request.inputs,
            &request.env,
        )?;
        let stdin = cli_tool_stdin(&request)?;
        let sandbox = sandbox.into_process_plan();
        let mut outcome = run_process(
            ProcessSpec::new("cli-tool", sandbox.command, OUTPUT_LIMIT_BYTES)
                .args(sandbox.args)
                .cwd(sandbox.cwd)
                .env(sandbox.env)
                .stdin(stdin)
                .timeout(Some(cli_tool_timeout(request.source.timeout_seconds)))
                .cleanup_paths(sandbox.cleanup_paths),
        )
        .map_err(|error| match error {
            crate::process::ProcessSupervisorError::Io { context, source } => {
                RuntimeError::io(context, source)
            }
        })?;
        let cleanup_errors = std::mem::take(&mut outcome.cleanup_errors);
        let mut output = cli_tool_output(outcome, &credential_delivery, sandbox.metadata);
        if !cleanup_errors.is_empty() {
            output.metadata.insert(
                "cleanup_errors".to_owned(),
                JsonValue::Array(cleanup_errors.into_iter().map(JsonValue::String).collect()),
            );
        }
        Ok(output)
    }

    fn fanout_execution_mode(&self, source: &runx_parser::SkillSource) -> FanoutExecutionMode {
        if source.source_type == runx_parser::SourceKind::CliTool {
            FanoutExecutionMode::IsolatedParallel
        } else {
            FanoutExecutionMode::Serial
        }
    }

    fn clone_for_fanout(&self) -> Option<Box<dyn SkillAdapter + Send + Sync>> {
        Some(Box::new(*self))
    }
}

fn cli_tool_timeout(timeout_seconds: Option<u64>) -> Duration {
    Duration::from_secs(timeout_seconds.unwrap_or_else(default_timeout_seconds))
}

fn default_timeout_seconds() -> u64 {
    #[cfg(test)]
    {
        let seconds = DEFAULT_TIMEOUT_OVERRIDE_SECONDS.load(std::sync::atomic::Ordering::SeqCst);
        if seconds > 0 {
            return seconds;
        }
    }
    DEFAULT_TIMEOUT_SECONDS
}

fn cli_tool_stdin(request: &SkillInvocation) -> Result<Option<ProcessStdin>, RuntimeError> {
    if request.source.input_mode != Some(runx_parser::InputMode::Stdin) {
        return Ok(None);
    }
    let bytes = serde_json::to_vec(&request.inputs)
        .map_err(|source| RuntimeError::json("serializing stdin inputs", source))?;
    Ok(Some(ProcessStdin::new(bytes, "writing cli-tool stdin")))
}

fn redacted_capture(
    output: CapturedOutput,
    credential_delivery: &CredentialDelivery,
) -> CapturedText {
    if output.truncated {
        return CapturedText {
            text: String::new(),
            truncated: true,
        };
    }
    CapturedText {
        text: credential_delivery.redact_bytes_to_string(output.bytes, OUTPUT_LIMIT_BYTES),
        truncated: false,
    }
}

fn cli_tool_output(
    outcome: ProcessOutcome,
    credential_delivery: &CredentialDelivery,
    metadata: runx_contracts::JsonObject,
) -> SkillOutput {
    let stdout = redacted_capture(outcome.stdout, credential_delivery);
    let stderr = redacted_capture(outcome.stderr, credential_delivery);
    let output_truncated = stdout.truncated || stderr.truncated;
    let success = outcome.status.success() && !outcome.timed_out && !output_truncated;
    let (stdout, stderr) = if output_truncated {
        (
            String::new(),
            format!(
                "runx cli-tool output exceeded {OUTPUT_LIMIT_BYTES} byte capture limit; stdout/stderr omitted"
            ),
        )
    } else {
        (stdout.text, stderr.text)
    };
    AdapterProjection::from_duration_ms(outcome.duration_ms).output(
        if success {
            InvocationStatus::Success
        } else {
            InvocationStatus::Failure
        },
        AdapterCapture::new(stdout, stderr),
        outcome.status.code(),
        metadata,
    )
}

struct CapturedText {
    text: String,
    truncated: bool,
}

pub fn output_object(output: &SkillOutput) -> runx_contracts::JsonObject {
    let mut object = runx_contracts::JsonObject::new();
    if let Ok(parsed) = serde_json::from_str::<JsonValue>(&output.stdout) {
        object.insert("skill_claim".to_owned(), parsed);
    }
    object.insert(
        "stdout".to_owned(),
        JsonValue::String(output.stdout.clone()),
    );
    object.insert(
        "stderr".to_owned(),
        JsonValue::String(output.stderr.clone()),
    );
    object.insert(
        "status".to_owned(),
        JsonValue::String(if output.succeeded() {
            "success".to_owned()
        } else {
            "failure".to_owned()
        }),
    );
    object
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    use runx_contracts::JsonObject;

    use super::*;
    use crate::credentials::CredentialDelivery;

    #[test]
    fn cli_tool_without_declared_timeout_uses_default_timeout() -> Result<(), RuntimeError> {
        let started = Instant::now();
        DEFAULT_TIMEOUT_OVERRIDE_SECONDS.store(1, std::sync::atomic::Ordering::SeqCst);
        let output = CliToolAdapter.invoke(SkillInvocation {
            skill_name: "default-timeout".to_owned(),
            source: runx_parser::SkillSource {
                act: None,
                source_type: runx_parser::SourceKind::CliTool,
                command: Some("/bin/sh".to_owned()),
                args: vec!["-c".to_owned(), "sleep 10".to_owned()],
                cwd: None,
                timeout_seconds: None,
                input_mode: None,
                sandbox: Some(runx_parser::SkillSandbox {
                    profile: runx_core::policy::SandboxProfile::UnrestrictedLocalDev,
                    cwd_policy: Some(runx_core::policy::CwdPolicy::Workspace),
                    env_allowlist: None,
                    network: None,
                    writable_paths: Vec::new(),
                    require_enforcement: None,
                    approved_escalation: Some(true),
                    raw: JsonObject::new(),
                }),
                server: None,
                catalog_ref: None,
                tool: None,
                arguments: None,
                agent_card_url: None,
                agent_identity: None,
                agent: None,
                task: None,
                hook: None,
                outputs: None,
                graph: None,
                http: None,
                raw: JsonObject::new(),
            },
            inputs: JsonObject::new(),
            resolved_inputs: JsonObject::new(),
            current_context: Vec::new(),
            skill_directory: std::env::current_dir()
                .map_err(|source| RuntimeError::io("reading current dir", source))?,
            env: BTreeMap::new(),
            credential_delivery: CredentialDelivery::none(),
        })?;
        DEFAULT_TIMEOUT_OVERRIDE_SECONDS.store(0, std::sync::atomic::Ordering::SeqCst);

        assert_eq!(output.status, InvocationStatus::Failure);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cli-tool without a manifest timeout must not run unbounded"
        );
        Ok(())
    }
}
