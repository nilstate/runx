//! Step output projection helpers. Translate the skill's stdout claim and
//! declared run-outputs / artifact-emits into the typed step projection that
//! downstream graph state machines and receipt sealers consume.

use runx_contracts::{JsonObject, JsonValue};
use runx_parser::{GraphStep, SkillArtifactContract};

use crate::RuntimeError;
use crate::adapter::SkillOutput;
use crate::execution::output_projection::{
    BASE_OUTPUT_FIELDS, StepOutputProjection, data_envelope, project_step_output,
};

/// Project a step's output using only the consuming step's own inline contract
/// (`run.outputs` / `artifacts`). Used where the step kind carries its own
/// contract material (inline cli-tool / agent-task / run steps).
pub(super) fn step_output_projection(
    step: &GraphStep,
    output: &SkillOutput,
) -> Result<StepOutputProjection, RuntimeError> {
    build_step_output_projection(step, output, None)
}

/// Project a step's output from its producing runner contract.
///
/// The addressable surface is sourced from the contract, never from the step
/// kind: declared `run.outputs` plus the effective artifact packets. The
/// effective artifact contract is the step's own inline `artifacts` when present
/// (raw inline step), otherwise `extra_artifacts` (the invoked sub-skill / tool
/// runner contract). Base/diagnostic keys (`raw`/`skill_claim`/`stdout`/`stderr`/
/// `status`) are inserted by `project_step_output` for receipts and replay but are
/// never part of the addressable contract.
pub(super) fn build_step_output_projection(
    step: &GraphStep,
    output: &SkillOutput,
    extra_artifacts: Option<&SkillArtifactContract>,
) -> Result<StepOutputProjection, RuntimeError> {
    let mut projection = project_step_output(output);
    expose_declared_run_outputs(step, &projection.claim, &mut projection.outputs)?;
    expose_effective_artifacts(
        step,
        extra_artifacts,
        &projection.claim,
        &mut projection.outputs,
    )?;
    Ok(projection)
}

/// Resolve the effective artifact contract for a step and expose its packets. The
/// step's own inline `artifacts` (raw `JsonObject`) win; otherwise the producing
/// runner's typed `SkillArtifactContract` is used. Both funnel through the single
/// `expose_artifact_packets` helper so a raw inline declaration and a typed runner
/// contract wrap identically.
fn expose_effective_artifacts(
    step: &GraphStep,
    extra_artifacts: Option<&SkillArtifactContract>,
    claim: &JsonObject,
    outputs: &mut JsonObject,
) -> Result<(), RuntimeError> {
    if claim.is_empty() {
        return Ok(());
    }
    if let Some(artifacts) = &step.artifacts {
        let wrap_as = artifacts.get("wrap_as").and_then(JsonValue::as_str);
        let named_emits = inline_named_emit_names(artifacts);
        return expose_artifact_packets(step, wrap_as, named_emits.as_deref(), claim, outputs);
    }
    if let Some(artifacts) = extra_artifacts {
        let named_emits = artifacts
            .named_emits
            .as_ref()
            .map(|emits| emits.keys().cloned().collect::<Vec<_>>());
        return expose_artifact_packets(
            step,
            artifacts.wrap_as.as_deref(),
            named_emits.as_deref(),
            claim,
            outputs,
        );
    }
    Ok(())
}

/// The single artifact-exposure helper shared by the raw inline `step.artifacts`
/// path and the typed `SkillArtifactContract` path. `wrap_as` exposes the whole
/// claim as one `{ data: ... }` packet (idempotent via `data_envelope`), and each
/// `named_emits` key exposes that claim field as its own `{ data: ... }` packet.
fn expose_artifact_packets(
    step: &GraphStep,
    wrap_as: Option<&str>,
    named_emits: Option<&[String]>,
    claim: &JsonObject,
    outputs: &mut JsonObject,
) -> Result<(), RuntimeError> {
    if let Some(wrap_as) = wrap_as {
        reject_reserved_step_output_name(step, wrap_as, "artifact output")?;
        let value = declared_claim_value(claim, wrap_as).map_or_else(
            || data_envelope(JsonValue::Object(claim.clone())),
            data_envelope,
        );
        outputs.insert(wrap_as.to_owned(), value);
    }
    if let Some(named_emits) = named_emits {
        for name in named_emits {
            reject_reserved_step_output_name(step, name, "artifact output")?;
            let Some(value) = declared_claim_value(claim, name) else {
                continue;
            };
            outputs.insert(name.clone(), data_envelope(value));
        }
    }
    Ok(())
}

fn inline_named_emit_names(artifacts: &JsonObject) -> Option<Vec<String>> {
    let JsonValue::Object(named_emits) = artifacts.get("named_emits")? else {
        return None;
    };
    Some(named_emits.keys().cloned().collect())
}

fn expose_declared_run_outputs(
    step: &GraphStep,
    claim: &JsonObject,
    outputs: &mut JsonObject,
) -> Result<(), RuntimeError> {
    let Some(run) = &step.run else {
        return Ok(());
    };
    let Some(JsonValue::Object(declared_outputs)) = run.get("outputs") else {
        return Ok(());
    };
    for name in declared_outputs.keys() {
        reject_reserved_step_output_name(step, name, "declared run output")?;
        let Some(value) = declared_claim_value(claim, name) else {
            return Err(RuntimeError::InvalidRunStep {
                step_id: step.id.clone(),
                reason: format!("declared run output {name:?} was not returned by the step"),
            });
        };
        outputs.insert(name.clone(), value);
    }
    Ok(())
}

fn declared_claim_value(claim: &JsonObject, name: &str) -> Option<JsonValue> {
    claim.get(name).cloned().or_else(|| {
        ["output", "outputs", "payload"]
            .iter()
            .find_map(|envelope| {
                let JsonValue::Object(object) = claim.get(*envelope)? else {
                    return None;
                };
                object.get(name).cloned()
            })
    })
}

fn reject_reserved_step_output_name(
    step: &GraphStep,
    name: &str,
    output_kind: &str,
) -> Result<(), RuntimeError> {
    if BASE_OUTPUT_FIELDS.contains(&name) {
        return Err(RuntimeError::InvalidRunStep {
            step_id: step.id.clone(),
            reason: format!("{output_kind} name {name:?} is reserved"),
        });
    }
    Ok(())
}
