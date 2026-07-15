//! Native verification of resolved agent results.
//!
//! The model sees the schema emitted by `runx-contracts`; this module enforces
//! the same declaration before a result can become a successful runtime output.
//! Successful evidence is carried as structured output metadata for the generic
//! receipt sealer to bind into the signed act and seal.

use runx_contracts::{
    JsonObject, JsonValue, OutputField, ResolutionRequest, output_contract_digest,
    validate_output_value,
};
use runx_parser::SkillArtifactContract;
use std::collections::BTreeMap;
use std::path::Path;

use crate::RuntimeError;
use crate::adapter::CONTRACT_VERIFICATION_METADATA;
use crate::agent_invocation::agent_profile_metadata;

#[cfg(test)]
pub(crate) fn verified_agent_metadata(
    request: &ResolutionRequest,
    payload: &JsonValue,
) -> Result<JsonObject, RuntimeError> {
    verified_agent_metadata_with_artifacts(
        request,
        payload,
        None,
        None,
        Path::new("."),
        &BTreeMap::new(),
    )
}

pub(crate) fn verified_agent_metadata_with_artifacts(
    request: &ResolutionRequest,
    payload: &JsonValue,
    typed_artifacts: Option<&SkillArtifactContract>,
    inline_artifacts: Option<&JsonObject>,
    skill_directory: &Path,
    env: &BTreeMap<String, String>,
) -> Result<JsonObject, RuntimeError> {
    let ResolutionRequest::AgentAct { invocation, .. } = request else {
        return Err(RuntimeError::SkillFailed {
            skill_name: "agent".to_owned(),
            message: "agent result verification requires an agent-act request".to_owned(),
        });
    };
    let contract_payload = output_contract_payload(payload, invocation.envelope.output.as_ref());
    validate_output_value(invocation.envelope.output.as_ref(), &contract_payload).map_err(
        |error| RuntimeError::SkillFailed {
            skill_name: invocation.envelope.skill.as_ref().to_owned(),
            message: format!("agent output contract violation at {error}"),
        },
    )?;
    let output_contract_sha256 = output_contract_digest(invocation.envelope.output.as_ref())
        .map_err(|source| RuntimeError::json("hashing agent output contract", source))?;
    let packet_schemas = crate::packet_validation::verify_declared_packets(
        &contract_payload,
        typed_artifacts,
        inline_artifacts,
        skill_directory,
        env,
    )?;

    let mut verification = JsonObject::new();
    verification.insert(
        "output_contract_sha256".to_owned(),
        JsonValue::String(output_contract_sha256),
    );
    if let Some(profile) = &invocation.envelope.voice_profile {
        verification.insert(
            "voice_profile_sha256".to_owned(),
            JsonValue::String(profile.sha256.as_ref().to_owned()),
        );
    }
    if !packet_schemas.is_empty() {
        verification.insert(
            "packet_schemas".to_owned(),
            JsonValue::Object(packet_schemas),
        );
    }

    let mut metadata = agent_profile_metadata(request);
    metadata.insert(
        CONTRACT_VERIFICATION_METADATA.to_owned(),
        JsonValue::Object(verification),
    );
    Ok(metadata)
}

fn output_contract_payload(
    payload: &JsonValue,
    output: Option<&BTreeMap<String, OutputField>>,
) -> JsonValue {
    let JsonValue::Object(fields) = payload else {
        return payload.clone();
    };
    let mut declared = fields.clone();
    // `closure` is Runx control metadata consumed by the receipt disposition
    // parser. It is validated by that protocol and is not a skill output.
    declared.remove("closure");
    if declared.len() == 1 {
        for envelope in ["output", "outputs", "payload"] {
            if output.is_some_and(|fields| fields.contains_key(envelope)) {
                continue;
            }
            if let Some(JsonValue::Object(inner)) = declared.get(envelope) {
                return JsonValue::Object(inner.clone());
            }
        }
    }
    JsonValue::Object(declared)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use runx_contracts::{
        AgentActInvocation, AgentActSourceType, AgentContextEnvelope, JsonValue, OutputField,
        OutputType, ResolutionRequest,
    };

    use super::verified_agent_metadata;
    use crate::adapter::CONTRACT_VERIFICATION_METADATA;

    fn request() -> Result<ResolutionRequest, serde_json::Error> {
        let envelope: AgentContextEnvelope = serde_json::from_value(serde_json::json!({
            "run_id": "run_1",
            "skill": "slack-notify",
            "instructions": "Plan a notification",
            "inputs": {},
            "allowed_tools": [],
            "current_context": [],
            "historical_context": [],
            "provenance": [],
            "output": { "notify_plan": "object" },
            "trust_boundary": "test"
        }))?;
        Ok(ResolutionRequest::AgentAct {
            id: "req_1".into(),
            invocation: Box::new(AgentActInvocation {
                id: "act_1".into(),
                source_type: AgentActSourceType::Agent,
                agent: None,
                task: None,
                envelope,
            }),
        })
    }

    #[test]
    fn verified_metadata_records_contract_digest() -> Result<(), Box<dyn std::error::Error>> {
        let answer = JsonValue::Object(
            [("notify_plan".to_owned(), JsonValue::Object(BTreeMap::new()))]
                .into_iter()
                .collect(),
        );

        let metadata = verified_agent_metadata(&request()?, &answer)?;

        assert!(metadata.contains_key(CONTRACT_VERIFICATION_METADATA));
        Ok(())
    }

    #[test]
    fn undeclared_agent_output_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
        let answer = JsonValue::Object(
            [
                ("notify_plan".to_owned(), JsonValue::Object(BTreeMap::new())),
                (
                    "message".to_owned(),
                    JsonValue::String("private".to_owned()),
                ),
            ]
            .into_iter()
            .collect(),
        );

        assert!(verified_agent_metadata(&request()?, &answer).is_err());
        Ok(())
    }

    #[test]
    fn provider_output_envelope_is_validated_as_the_declared_payload()
    -> Result<(), Box<dyn std::error::Error>> {
        let answer = JsonValue::Object(
            [(
                "output".to_owned(),
                JsonValue::Object(
                    [("notify_plan".to_owned(), JsonValue::Object(BTreeMap::new()))]
                        .into_iter()
                        .collect(),
                ),
            )]
            .into_iter()
            .collect(),
        );

        assert!(verified_agent_metadata(&request()?, &answer).is_ok());
        Ok(())
    }

    #[test]
    fn runx_closure_metadata_is_not_treated_as_a_declared_skill_output()
    -> Result<(), Box<dyn std::error::Error>> {
        let answer = JsonValue::Object(
            [
                ("notify_plan".to_owned(), JsonValue::Object(BTreeMap::new())),
                (
                    "closure".to_owned(),
                    JsonValue::Object(
                        [
                            (
                                "disposition".to_owned(),
                                JsonValue::String("closed".to_owned()),
                            ),
                            (
                                "reason_code".to_owned(),
                                JsonValue::String("completed".to_owned()),
                            ),
                            (
                                "summary".to_owned(),
                                JsonValue::String("Completed".to_owned()),
                            ),
                        ]
                        .into_iter()
                        .collect(),
                    ),
                ),
            ]
            .into_iter()
            .collect(),
        );

        assert!(verified_agent_metadata(&request()?, &answer).is_ok());
        Ok(())
    }

    #[test]
    fn fixture_contract_is_the_declared_object_field() -> Result<(), Box<dyn std::error::Error>> {
        let ResolutionRequest::AgentAct { invocation, .. } = request()? else {
            return Err("expected agent-act request".into());
        };
        assert_eq!(
            invocation.envelope.output,
            Some(
                [(
                    "notify_plan".to_owned(),
                    OutputField::Type(OutputType::Object)
                )]
                .into_iter()
                .collect()
            )
        );
        Ok(())
    }
}
