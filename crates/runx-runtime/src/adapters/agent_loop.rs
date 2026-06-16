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
//! reuses the runtime's universal [`SkillOutput`]; this module only adds the two
//! seams that did not exist before (the per-turn model call and tool execution).
//!
// rust-style-allow: large-file because the governed agent loop, its provider and
// executor seams, the transcript contracts, and the loop-coverage tests belong in
// one cohesive unit; splitting them would scatter the single source of truth for
// the tool-use protocol.

use runx_contracts::JsonValue;

use super::agent::{AgentExecutionTelemetry, AgentResolution, AgentToolExecutionTrace};
use crate::RuntimeError;
use crate::adapter::{InvocationStatus, SkillOutput};

const MANAGED_AGENT_SKILL: &str = "managed-agent";

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
/// [`SkillOutput`]. Production implementations delegate to skill execution (which
/// passes through authority admission); tests supply a fake.
pub trait ToolExecutor {
    fn execute(&self, tool: &str, input: &JsonValue) -> Result<SkillOutput, RuntimeError>;
}

/// Loop bounds and the name of the tool the model calls to finalize.
#[derive(Clone, Debug)]
pub struct AgentLoopConfig {
    pub max_rounds: u32,
    pub final_result_tool: String,
}

fn loop_failure(message: String) -> RuntimeError {
    RuntimeError::SkillFailed {
        skill_name: MANAGED_AGENT_SKILL.to_owned(),
        message,
    }
}

fn tool_result_content(output: &SkillOutput, is_error: bool) -> String {
    if is_error && !output.stderr.is_empty() {
        output.stderr.clone()
    } else {
        output.stdout.clone()
    }
}

/// Run the bounded tool-use loop, returning the existing [`AgentResolution`] when
/// the model finalizes. Fails closed on an empty turn or on exhausting the round
/// budget without a final result.
// rust-style-allow: long-function because this is one bounded round loop whose
// turn sequencing (model call, fail-closed checks, per-tool execution, transcript
// append, telemetry accumulation) must stay linear to remain auditable.
pub fn run_agent_loop<M, T>(
    config: &AgentLoopConfig,
    model: &M,
    executor: &T,
    prompt: String,
) -> Result<AgentResolution, RuntimeError>
where
    M: ModelCaller,
    T: ToolExecutor,
{
    let mut transcript = vec![AgentTurn::User(prompt)];
    let mut tool_calls: u32 = 0;
    let mut tools: Vec<String> = Vec::new();
    let mut tool_executions: Vec<AgentToolExecutionTrace> = Vec::new();
    // The real result of the last successful governed tool call, captured from the
    // tool output so a domain receipt records the effect, not the model's retelling.
    let mut last_effect: Option<JsonValue> = None;

    for round in 1..=config.max_rounds {
        let uses = model.next_tool_uses(&transcript)?;
        if uses.is_empty() {
            return Err(loop_failure(format!(
                "managed agent returned no tool use on round {round}"
            )));
        }
        transcript.push(AgentTurn::AssistantToolUses(uses.clone()));

        let mut results = Vec::with_capacity(uses.len());
        for use_ in &uses {
            if use_.name == config.final_result_tool {
                let telemetry = AgentExecutionTelemetry {
                    rounds: Some(u64::from(round)),
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
            if !tools.iter().any(|name| name == &use_.name) {
                tools.push(use_.name.clone());
            }

            let output = executor.execute(&use_.name, &use_.input)?;
            let is_error = !matches!(output.status, InvocationStatus::Success);
            if !is_error {
                if let Ok(effect) = serde_json::from_str::<JsonValue>(output.stdout.trim()) {
                    last_effect = Some(effect);
                }
            }
            let content = tool_result_content(&output, is_error);
            tool_executions.push(AgentToolExecutionTrace {
                tool: use_.name.clone(),
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

    Err(loop_failure(format!(
        "managed agent exceeded {} tool-call rounds without finalizing",
        config.max_rounds
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{InvocationStatus, SkillOutput};
    use runx_contracts::{JsonObject, JsonValue};

    const FINAL: &str = "runx_final_result";

    fn skill_output(stdout: &str) -> SkillOutput {
        SkillOutput {
            status: InvocationStatus::Success,
            stdout: stdout.to_owned(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 0,
            metadata: JsonObject::new(),
        }
    }

    struct OkExecutor;
    impl ToolExecutor for OkExecutor {
        fn execute(&self, _tool: &str, _input: &JsonValue) -> Result<SkillOutput, RuntimeError> {
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
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(&config, &NeverFinal, &OkExecutor, "go".to_owned());
        assert!(
            matches!(&result, Err(RuntimeError::SkillFailed { message, .. }) if message.contains("rounds")),
            "loop should fail closed on max rounds; got: {result:?}"
        );
    }

    #[test]
    fn loop_fails_closed_on_empty_turn() {
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
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(&config, &Silent, &OkExecutor, "go".to_owned());
        assert!(
            matches!(&result, Err(RuntimeError::SkillFailed { message, .. }) if message.contains("no tool use")),
            "loop should fail closed on an empty turn; got: {result:?}"
        );
    }

    struct ErrExecutor {
        calls: std::cell::Cell<u32>,
    }
    impl ToolExecutor for ErrExecutor {
        fn execute(&self, _tool: &str, _input: &JsonValue) -> Result<SkillOutput, RuntimeError> {
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
            final_result_tool: FINAL.to_owned(),
        };
        let result = run_agent_loop(&config, &ScriptedModel, &executor, "go".to_owned());
        assert_eq!(
            executor.calls.get(),
            1,
            "the executor must actually be invoked before its error can propagate"
        );
        assert!(
            matches!(&result, Err(RuntimeError::SkillFailed { message, .. }) if message.contains("executor down")),
            "an executor error must propagate; got: {result:?}"
        );
    }

    struct FailingExecutor;
    impl ToolExecutor for FailingExecutor {
        fn execute(&self, _tool: &str, _input: &JsonValue) -> Result<SkillOutput, RuntimeError> {
            Ok(SkillOutput {
                status: InvocationStatus::Failure,
                stdout: String::new(),
                stderr: "insufficient funds".to_owned(),
                exit_code: Some(1),
                duration_ms: 0,
                metadata: JsonObject::new(),
            })
        }
    }

    #[test]
    fn loop_records_tool_failure_and_still_finalizes() -> Result<(), String> {
        // A non-success tool output is a failure, not an error: the loop feeds it
        // back, records it in telemetry, and the model can still finalize.
        let config = AgentLoopConfig {
            max_rounds: 8,
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
