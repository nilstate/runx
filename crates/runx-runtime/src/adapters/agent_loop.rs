//! Provider-agnostic managed-agent tool-use loop.
//!
//! This is the governance core of the `agent` source front. It drives a bounded
//! multi-round conversation: it asks the model for the next tool calls, executes
//! each chosen tool through the governed runtime, feeds the results back, and
//! repeats until the model calls the final-result tool or the round budget is
//! exhausted. The provider call (Anthropic, OpenAI, ...) is abstracted behind
//! [`ModelCaller`] and tool execution behind [`ToolExecutor`], so a provider
//! resolver supplies both and this loop stays provider- and transport-agnostic.
//!
//! It deliberately does not track domain-specific usage. The per-run authority
//! cap is enforced by the governed tool execution path; duplicating that
//! accounting here would be a second source of truth.
//!
//! Output and telemetry reuse the existing agent contracts ([`AgentResolution`],
//! [`AgentExecutionTelemetry`], [`AgentToolExecutionTrace`]) and tool execution
//! reuses the runtime's universal [`InvocationOutput`]; this module only adds the two
//! seams that did not exist before (the per-turn model call and tool execution).
//!
// Module rationale: the governed agent loop, its provider and
// executor seams, the transcript contracts, and the loop-coverage tests belong in
// one cohesive unit; splitting them would scatter the single source of truth for
// the tool-use protocol.

use runx_contracts::JsonValue;

use super::agent::{AgentExecutionTelemetry, AgentResolution, AgentToolExecutionTrace};
use crate::RuntimeError;
use crate::adapter::{InvocationOutput, InvocationStatus};

pub(crate) const UNRECOGNIZED_MODEL_TOOL: &str = "unrecognized_tool";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentLoopFailureReason {
    ProviderFailed,
    EmptyTurnBudgetExhausted,
    ToolExecutionFailed,
    RoundBudgetExhausted,
}

impl AgentLoopFailureReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderFailed => "provider_failed",
            Self::EmptyTurnBudgetExhausted => "empty_turn_budget_exhausted",
            Self::ToolExecutionFailed => "tool_execution_failed",
            Self::RoundBudgetExhausted => "round_budget_exhausted",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentLoopFailure {
    reason: AgentLoopFailureReason,
    sanitized_message: String,
    telemetry: Box<AgentExecutionTelemetry>,
}

impl AgentLoopFailure {
    fn new(
        reason: AgentLoopFailureReason,
        sanitized_message: impl Into<String>,
        telemetry: AgentExecutionTelemetry,
    ) -> Self {
        Self {
            reason,
            sanitized_message: sanitized_message.into(),
            telemetry: Box::new(telemetry),
        }
    }

    #[must_use]
    pub const fn reason(&self) -> AgentLoopFailureReason {
        self.reason
    }

    #[must_use]
    pub fn sanitized_message(&self) -> &str {
        &self.sanitized_message
    }

    #[must_use]
    pub const fn telemetry(&self) -> &AgentExecutionTelemetry {
        &self.telemetry
    }
}

impl std::fmt::Display for AgentLoopFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.sanitized_message)
    }
}

impl std::error::Error for AgentLoopFailure {}

/// A tool-call request the model emitted on one round.
#[derive(Clone, Debug)]
pub struct AgentToolUse {
    pub id: String,
    pub name: String,
    pub input: JsonValue,
}

/// A tool result fed back to the model on the next round.
#[derive(Clone, Debug)]
pub struct AgentToolResult {
    pub tool_use_id: String,
    pub content: String,
    pub is_error: bool,
}

/// One provider-agnostic transcript turn.
#[derive(Clone, Debug)]
pub enum AgentTurn {
    User(String),
    AssistantToolUses(Vec<AgentToolUse>),
    ToolResults(Vec<AgentToolResult>),
}

/// Per-turn provider call. Given the transcript so far, return the model's next
/// tool-use requests. The provider resolver owns the tool catalog it offered, so
/// the loop never inspects tool specifications itself.
pub trait ModelCaller {
    fn next_tool_uses(&self, transcript: &[AgentTurn]) -> Result<Vec<AgentToolUse>, RuntimeError>;
}

/// Executes one chosen tool through the governed runtime, returning the standard
/// [`InvocationOutput`]. Production implementations delegate to skill execution (which
/// passes through authority admission); tests supply a fake.
pub trait ToolExecutor {
    /// Return the canonical name this executor would admit for execution.
    /// Model-authored names that were not offered must return `None`; the loop
    /// records only a fixed sentinel for those attempts.
    fn admitted_tool_name(&self, tool: &str) -> Option<String>;

    fn execute(&self, tool: &str, input: &JsonValue) -> Result<InvocationOutput, RuntimeError>;
}

/// Loop bounds and the name of the tool the model calls to finalize.
#[derive(Clone, Debug)]
pub struct AgentLoopConfig {
    pub max_rounds: u32,
    /// How many times to re-ask the model after an empty turn (a stray text-only
    /// reply when it should have called a tool) before failing closed. A transient
    /// sampling blip is recovered by resampling; a persistently silent model still
    /// exhausts these attempts and fails, so the fail-closed guarantee holds. Kept
    /// separate from `max_rounds` so a blip never costs a legitimate tool round.
    pub max_empty_turn_resamples: u32,
    pub final_result_tool: String,
}

fn tool_result_content(output: &InvocationOutput, is_error: bool) -> String {
    if is_error {
        output
            .failure_message()
            .unwrap_or_else(|| output.rendered_value())
    } else {
        output.rendered_value()
    }
}

/// Ask the model for the next tool uses, tolerating a transient empty turn by
/// resampling up to `max_resamples` extra times. Returns the first non-empty
/// turn, or fails closed if every attempt is empty. A provider error from the
/// model call is surfaced immediately and never retried.
fn next_tool_uses_resilient<M>(
    model: &M,
    transcript: &[AgentTurn],
    max_resamples: u32,
    model_calls: &mut u32,
) -> Result<Vec<AgentToolUse>, AgentLoopFailureReason>
where
    M: ModelCaller,
{
    for _ in 0..=max_resamples {
        *model_calls = model_calls.saturating_add(1);
        let uses = model
            .next_tool_uses(transcript)
            .map_err(|_| AgentLoopFailureReason::ProviderFailed)?;
        if !uses.is_empty() {
            return Ok(uses);
        }
    }
    Err(AgentLoopFailureReason::EmptyTurnBudgetExhausted)
}

fn failure_telemetry(
    rounds: u32,
    model_calls: u32,
    tool_calls: u32,
    tools: Vec<String>,
    tool_executions: Vec<AgentToolExecutionTrace>,
) -> AgentExecutionTelemetry {
    AgentExecutionTelemetry {
        rounds: Some(u64::from(rounds)),
        model_calls: Some(u64::from(model_calls)),
        tool_calls: Some(u64::from(tool_calls)),
        tools: Some(tools),
        tool_executions: Some(tool_executions),
    }
}

/// Run the bounded tool-use loop, returning the existing [`AgentResolution`] when
/// the model finalizes. Fails closed on an empty turn or on exhausting the round
/// budget without a final result.
// Function rationale: this is one bounded round loop whose
// turn sequencing (model call, fail-closed checks, per-tool execution, transcript
// append, telemetry accumulation) must stay linear to remain auditable.
pub fn run_agent_loop<M, T>(
    config: &AgentLoopConfig,
    model: &M,
    executor: &T,
    prompt: String,
) -> Result<AgentResolution, AgentLoopFailure>
where
    M: ModelCaller,
    T: ToolExecutor,
{
    let mut transcript = vec![AgentTurn::User(prompt)];
    let mut model_calls: u32 = 0;
    let mut tool_calls: u32 = 0;
    let mut tools: Vec<String> = Vec::new();
    let mut tool_executions: Vec<AgentToolExecutionTrace> = Vec::new();
    // The real result of the last successful governed tool call, captured from the
    // tool output so a domain receipt records the effect, not the model's retelling.
    let mut last_effect: Option<JsonValue> = None;

    for round in 1..=config.max_rounds {
        let uses = match next_tool_uses_resilient(
            model,
            &transcript,
            config.max_empty_turn_resamples,
            &mut model_calls,
        ) {
            Ok(uses) => uses,
            Err(AgentLoopFailureReason::ProviderFailed) => {
                return Err(AgentLoopFailure::new(
                    AgentLoopFailureReason::ProviderFailed,
                    "Managed agent provider request failed.",
                    failure_telemetry(round, model_calls, tool_calls, tools, tool_executions),
                ));
            }
            Err(AgentLoopFailureReason::EmptyTurnBudgetExhausted) => {
                return Err(AgentLoopFailure::new(
                    AgentLoopFailureReason::EmptyTurnBudgetExhausted,
                    format!(
                        "Managed agent returned no tool use after {} attempts.",
                        config.max_empty_turn_resamples + 1
                    ),
                    failure_telemetry(round, model_calls, tool_calls, tools, tool_executions),
                ));
            }
            Err(reason) => {
                return Err(AgentLoopFailure::new(
                    reason,
                    "Managed agent failed.",
                    failure_telemetry(round, model_calls, tool_calls, tools, tool_executions),
                ));
            }
        };
        transcript.push(AgentTurn::AssistantToolUses(uses.clone()));

        let mut results = Vec::with_capacity(uses.len());
        for use_ in &uses {
            if use_.name == config.final_result_tool {
                let telemetry = AgentExecutionTelemetry {
                    rounds: Some(u64::from(round)),
                    model_calls: Some(u64::from(model_calls)),
                    tool_calls: Some(u64::from(tool_calls)),
                    tools: Some(tools),
                    tool_executions: Some(tool_executions),
                };
                return Ok(AgentResolution::agent_with_effect(
                    use_.input.clone(),
                    Some(telemetry),
                    last_effect,
                ));
            }

            tool_calls = tool_calls.saturating_add(1);
            let Some(tool_name) = executor.admitted_tool_name(&use_.name) else {
                if !tools.iter().any(|name| name == UNRECOGNIZED_MODEL_TOOL) {
                    tools.push(UNRECOGNIZED_MODEL_TOOL.to_owned());
                }
                tool_executions.push(AgentToolExecutionTrace {
                    tool: UNRECOGNIZED_MODEL_TOOL.to_owned(),
                    status: "failure".to_owned(),
                    receipt_id: None,
                    resolution_kind: None,
                });
                return Err(AgentLoopFailure::new(
                    AgentLoopFailureReason::ToolExecutionFailed,
                    "Managed agent tool execution failed.",
                    failure_telemetry(round, model_calls, tool_calls, tools, tool_executions),
                ));
            };
            if !tools.iter().any(|name| name == &tool_name) {
                tools.push(tool_name.clone());
            }

            let output = match executor.execute(&tool_name, &use_.input) {
                Ok(output) => output,
                Err(_) => {
                    tool_executions.push(AgentToolExecutionTrace {
                        tool: tool_name.clone(),
                        status: "failure".to_owned(),
                        receipt_id: None,
                        resolution_kind: None,
                    });
                    return Err(AgentLoopFailure::new(
                        AgentLoopFailureReason::ToolExecutionFailed,
                        "Managed agent tool execution failed.",
                        failure_telemetry(round, model_calls, tool_calls, tools, tool_executions),
                    ));
                }
            };
            let is_error = !matches!(output.status, InvocationStatus::Success);
            if !is_error {
                last_effect = Some(output.value.clone());
            }
            let content = tool_result_content(&output, is_error);
            tool_executions.push(AgentToolExecutionTrace {
                tool: tool_name,
                status: (if is_error { "failure" } else { "success" }).to_owned(),
                receipt_id: None,
                resolution_kind: None,
            });
            results.push(AgentToolResult {
                tool_use_id: use_.id.clone(),
                content,
                is_error,
            });
        }
        transcript.push(AgentTurn::ToolResults(results));
    }

    Err(AgentLoopFailure::new(
        AgentLoopFailureReason::RoundBudgetExhausted,
        format!(
            "Managed agent exceeded {} tool-call rounds without finalizing.",
            config.max_rounds
        ),
        failure_telemetry(
            config.max_rounds,
            model_calls,
            tool_calls,
            tools,
            tool_executions,
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::InvocationOutput;
    use runx_contracts::{JsonObject, JsonValue};

    const FINAL: &str = "runx_final_result";

    fn skill_output(stdout: &str) -> InvocationOutput {
        let value =
            serde_json::from_str(stdout).unwrap_or_else(|_| JsonValue::String(stdout.to_owned()));
        InvocationOutput::runtime_success(value, 0, JsonObject::new())
    }

    struct OkExecutor;
    impl ToolExecutor for OkExecutor {
        fn admitted_tool_name(&self, tool: &str) -> Option<String> {
            Some(tool.to_owned())
        }

        fn execute(
            &self,
            _tool: &str,
            _input: &JsonValue,
        ) -> Result<InvocationOutput, RuntimeError> {
            Ok(skill_output("charged"))
        }
    }

    struct ScriptedModel;
    impl ModelCaller for ScriptedModel {
        fn next_tool_uses(
            &self,
            transcript: &[AgentTurn],
        ) -> Result<Vec<AgentToolUse>, RuntimeError> {
            // Round 1 has only the user prompt -> call a tool. Once tool results
            // are in the transcript -> finalize.
            let executed = transcript
                .iter()
                .any(|turn| matches!(turn, AgentTurn::ToolResults(_)));
            if executed {
                Ok(vec![AgentToolUse {
                    id: "f".to_owned(),
                    name: FINAL.to_owned(),
                    input: JsonValue::String("done".to_owned()),
                }])
            } else {
                Ok(vec![AgentToolUse {
                    id: "t1".to_owned(),
                    name: "pay".to_owned(),
                    input: JsonValue::Null,
                }])
            }
        }
    }

    #[test]
    fn loop_executes_tool_then_finalizes() {
        let config = AgentLoopConfig {
            max_rounds: 8,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(
            &config,
            &ScriptedModel,
            &OkExecutor,
            "buy a quota".to_owned(),
        );
        assert!(
            matches!(
                &result,
                Ok(resolution)
                    if matches!(resolution.response.payload, JsonValue::String(ref s) if s == "done")
                    && resolution.telemetry.as_ref().and_then(|t| t.tool_calls) == Some(1)
                    && resolution.telemetry.as_ref().and_then(|t| t.rounds) == Some(2)
                    && resolution.telemetry.as_ref().and_then(|t| t.model_calls) == Some(2)
            ),
            "loop should execute the tool then finalize; got: {result:?}"
        );
    }

    #[test]
    fn loop_fails_closed_on_max_rounds() {
        struct NeverFinal;
        impl ModelCaller for NeverFinal {
            fn next_tool_uses(
                &self,
                _transcript: &[AgentTurn],
            ) -> Result<Vec<AgentToolUse>, RuntimeError> {
                Ok(vec![AgentToolUse {
                    id: "x".to_owned(),
                    name: "noop".to_owned(),
                    input: JsonValue::Null,
                }])
            }
        }
        let config = AgentLoopConfig {
            max_rounds: 3,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(&config, &NeverFinal, &OkExecutor, "go".to_owned());
        assert!(
            matches!(
                &result,
                Err(error)
                    if error.reason() == AgentLoopFailureReason::RoundBudgetExhausted
                    && error.sanitized_message().contains("rounds")
                    && error.telemetry().rounds == Some(3)
                    && error.telemetry().model_calls == Some(3)
                    && error.telemetry().tool_calls == Some(3)
            ),
            "loop should fail closed on max rounds; got: {result:?}"
        );
    }

    #[test]
    fn loop_fails_closed_when_every_resample_is_empty() {
        // A persistently silent model exhausts the empty-turn resamples and fails
        // closed. A transient single blip is recovered instead (see the recovery
        // test); only sustained silence reaches this error.
        struct Silent;
        impl ModelCaller for Silent {
            fn next_tool_uses(
                &self,
                _transcript: &[AgentTurn],
            ) -> Result<Vec<AgentToolUse>, RuntimeError> {
                Ok(Vec::new())
            }
        }
        let config = AgentLoopConfig {
            max_rounds: 3,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(&config, &Silent, &OkExecutor, "go".to_owned());
        assert!(
            matches!(
                &result,
                Err(error)
                    if error.reason() == AgentLoopFailureReason::EmptyTurnBudgetExhausted
                    && error.sanitized_message().contains("no tool use")
                    && error.telemetry().rounds == Some(1)
                    && error.telemetry().model_calls == Some(4)
                    && error.telemetry().tool_calls == Some(0)
            ),
            "loop should fail closed on an empty turn; got: {result:?}"
        );
    }

    #[test]
    fn loop_recovers_from_a_transient_empty_turn() {
        // The model returns one empty turn (a transient sampling blip) and then
        // proceeds normally. The loop must resample, recover, and finalize rather
        // than fail closed. rounds == 2 proves the blip did not cost a tool round.
        struct EmptyOnceThenScripted {
            empties: std::cell::Cell<u32>,
        }
        impl ModelCaller for EmptyOnceThenScripted {
            fn next_tool_uses(
                &self,
                transcript: &[AgentTurn],
            ) -> Result<Vec<AgentToolUse>, RuntimeError> {
                if self.empties.get() == 0 {
                    self.empties.set(1);
                    return Ok(Vec::new());
                }
                let executed = transcript
                    .iter()
                    .any(|turn| matches!(turn, AgentTurn::ToolResults(_)));
                if executed {
                    Ok(vec![AgentToolUse {
                        id: "f".to_owned(),
                        name: FINAL.to_owned(),
                        input: JsonValue::String("done".to_owned()),
                    }])
                } else {
                    Ok(vec![AgentToolUse {
                        id: "t1".to_owned(),
                        name: "pay".to_owned(),
                        input: JsonValue::Null,
                    }])
                }
            }
        }
        let config = AgentLoopConfig {
            max_rounds: 8,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(
            &config,
            &EmptyOnceThenScripted {
                empties: std::cell::Cell::new(0),
            },
            &OkExecutor,
            "buy a quota".to_owned(),
        );
        assert!(
            matches!(
                &result,
                Ok(resolution)
                    if matches!(resolution.response.payload, JsonValue::String(ref s) if s == "done")
                    && resolution.telemetry.as_ref().and_then(|t| t.rounds) == Some(2)
                    && resolution.telemetry.as_ref().and_then(|t| t.model_calls) == Some(3)
            ),
            "a transient empty turn should be resampled and recovered, finalizing normally; got: {result:?}"
        );
    }

    struct ErrExecutor {
        calls: std::cell::Cell<u32>,
    }
    impl ToolExecutor for ErrExecutor {
        fn admitted_tool_name(&self, tool: &str) -> Option<String> {
            Some(tool.to_owned())
        }

        fn execute(
            &self,
            _tool: &str,
            _input: &JsonValue,
        ) -> Result<InvocationOutput, RuntimeError> {
            self.calls.set(self.calls.get() + 1);
            Err(RuntimeError::SkillFailed {
                skill_name: "managed-tool".to_owned(),
                message: "executor down".to_owned(),
            })
        }
    }

    #[test]
    fn loop_propagates_executor_error() {
        // The model calls a tool on round 1; the executor errors. The loop must
        // actually invoke the executor and surface its error rather than swallow it
        // or finalize. The call counter proves the error originates in the executor,
        // not the model.
        let executor = ErrExecutor {
            calls: std::cell::Cell::new(0),
        };
        let config = AgentLoopConfig {
            max_rounds: 8,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(&config, &ScriptedModel, &executor, "go".to_owned());
        assert_eq!(
            executor.calls.get(),
            1,
            "the executor must actually be invoked before its error can be projected"
        );
        assert!(
            matches!(
                &result,
                Err(error)
                    if error.reason() == AgentLoopFailureReason::ToolExecutionFailed
                    && error.sanitized_message() == "Managed agent tool execution failed."
                    && error.telemetry().tool_calls == Some(1)
                    && error.telemetry().tool_executions.as_ref().is_some_and(|traces|
                        traces.len() == 1
                        && traces[0].tool == "pay"
                        && traces[0].status == "failure")
            ),
            "an executor error must become a bounded failure; got: {result:?}"
        );
    }

    #[test]
    fn loop_sanitizes_provider_failure_and_preserves_bounded_telemetry() {
        struct FailingModel;
        impl ModelCaller for FailingModel {
            fn next_tool_uses(
                &self,
                _transcript: &[AgentTurn],
            ) -> Result<Vec<AgentToolUse>, RuntimeError> {
                Err(RuntimeError::SkillFailed {
                    skill_name: "provider".to_owned(),
                    message: "secret prompt and raw provider body".to_owned(),
                })
            }
        }
        let config = AgentLoopConfig {
            max_rounds: 3,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };

        let result = run_agent_loop(
            &config,
            &FailingModel,
            &OkExecutor,
            "private prompt".to_owned(),
        );

        assert!(
            matches!(
                &result,
                Err(error)
                    if error.reason() == AgentLoopFailureReason::ProviderFailed
                    && error.sanitized_message() == "Managed agent provider request failed."
                    && error.telemetry().rounds == Some(1)
                    && error.telemetry().model_calls == Some(1)
                    && error.telemetry().tool_calls == Some(0)
                    && !error.to_string().contains("secret")
                    && !error.to_string().contains("private prompt")
            ),
            "provider failures must retain only bounded telemetry; got: {result:?}"
        );
    }

    #[test]
    fn unknown_model_tool_name_never_reaches_durable_telemetry()
    -> Result<(), Box<dyn std::error::Error>> {
        const SENSITIVE_MARKER: &str = "leak_customer_secret_7f3a";

        struct UnknownToolModel;
        impl ModelCaller for UnknownToolModel {
            fn next_tool_uses(
                &self,
                _transcript: &[AgentTurn],
            ) -> Result<Vec<AgentToolUse>, RuntimeError> {
                Ok(vec![AgentToolUse {
                    id: "unknown".to_owned(),
                    name: SENSITIVE_MARKER.to_owned(),
                    input: JsonValue::Null,
                }])
            }
        }

        struct PayOnlyExecutor;
        impl ToolExecutor for PayOnlyExecutor {
            fn admitted_tool_name(&self, tool: &str) -> Option<String> {
                (tool == "pay").then(|| tool.to_owned())
            }

            fn execute(
                &self,
                _tool: &str,
                _input: &JsonValue,
            ) -> Result<InvocationOutput, RuntimeError> {
                Ok(skill_output("paid"))
            }
        }

        let result = run_agent_loop(
            &AgentLoopConfig {
                max_rounds: 2,
                max_empty_turn_resamples: 0,
                final_result_tool: FINAL.to_owned(),
            },
            &UnknownToolModel,
            &PayOnlyExecutor,
            "go".to_owned(),
        );
        let Err(error) = result else {
            return Err("an unoffered model tool did not fail closed".into());
        };
        let projection = JsonValue::Object(error.telemetry().public_projection());
        let serialized = serde_json::to_string(&projection).unwrap_or_default();

        assert!(!serialized.contains(SENSITIVE_MARKER));
        assert!(serialized.contains(UNRECOGNIZED_MODEL_TOOL));
        assert_eq!(error.telemetry().tool_calls, Some(1));
        Ok(())
    }

    struct FailingExecutor;
    impl ToolExecutor for FailingExecutor {
        fn admitted_tool_name(&self, tool: &str) -> Option<String> {
            Some(tool.to_owned())
        }

        fn execute(
            &self,
            _tool: &str,
            _input: &JsonValue,
        ) -> Result<InvocationOutput, RuntimeError> {
            Ok(InvocationOutput::runtime_failure(
                JsonValue::Null,
                "insufficient funds",
                0,
                JsonObject::new(),
            ))
        }
    }

    #[test]
    fn loop_records_tool_failure_and_still_finalizes() -> Result<(), String> {
        // A non-success tool output is a failure, not an error: the loop feeds it
        // back, records it in telemetry, and the model can still finalize.
        let config = AgentLoopConfig {
            max_rounds: 8,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };
        let resolution = run_agent_loop(&config, &ScriptedModel, &FailingExecutor, "go".to_owned())
            .map_err(|error| format!("a failing tool should not abort the loop: {error}"))?;
        let telemetry = resolution
            .telemetry
            .ok_or_else(|| "telemetry present".to_owned())?;
        let executions = telemetry
            .tool_executions
            .ok_or_else(|| "tool executions present".to_owned())?;
        assert!(
            executions.len() == 1
                && executions[0].tool == "pay"
                && executions[0].status == "failure",
            "a non-success tool output must be recorded as a failure; got: {executions:?}"
        );
        assert_eq!(
            telemetry.tool_calls,
            Some(1),
            "the failed call still counts toward tool_calls"
        );
        assert_eq!(
            telemetry.rounds,
            Some(2),
            "the failure was fed back and the loop continued to a second round before finalizing"
        );
        Ok(())
    }

    struct DistinctThenRepeat;
    impl ModelCaller for DistinctThenRepeat {
        fn next_tool_uses(
            &self,
            transcript: &[AgentTurn],
        ) -> Result<Vec<AgentToolUse>, RuntimeError> {
            // Call pay, then read, then pay again (a repeat), then finalize.
            let executed = transcript
                .iter()
                .filter(|turn| matches!(turn, AgentTurn::ToolResults(_)))
                .count();
            let name = match executed {
                0 => "pay",
                1 => "read",
                2 => "pay",
                _ => FINAL,
            };
            Ok(vec![AgentToolUse {
                id: format!("c{executed}"),
                name: name.to_owned(),
                input: JsonValue::Null,
            }])
        }
    }

    #[test]
    fn telemetry_dedupes_tool_names_but_counts_every_call() -> Result<(), String> {
        // The model calls pay, read, pay, then finalizes. Telemetry must count all
        // three calls, retain the two distinct names in order, and dedupe the
        // repeated 'pay'. This catches broken dedup, lost distinct names, and order.
        let config = AgentLoopConfig {
            max_rounds: 8,
            max_empty_turn_resamples: 3,
            final_result_tool: FINAL.to_owned(),
        };
        let resolution = run_agent_loop(&config, &DistinctThenRepeat, &OkExecutor, "go".to_owned())
            .map_err(|error| format!("should finalize after three calls: {error}"))?;
        let telemetry = resolution
            .telemetry
            .ok_or_else(|| "telemetry present".to_owned())?;
        assert_eq!(
            telemetry.tool_calls,
            Some(3),
            "all three calls (pay, read, pay) count"
        );
        assert_eq!(
            telemetry.tools,
            Some(vec!["pay".to_owned(), "read".to_owned()]),
            "distinct names are retained in order and the repeated 'pay' is deduped"
        );
        Ok(())
    }
}
