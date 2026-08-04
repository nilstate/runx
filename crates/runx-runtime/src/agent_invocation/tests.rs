use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use runx_contracts::{
    EnvironmentRequirements, ExecutionCredentialRequirement, ExecutionRequirements, JsonObject,
    JsonValue, ProvenanceEntry, sha256_prefixed,
};
use runx_parser::{SkillSource, SourceKind};

use super::profiles::{BUNDLED_VOICE_PROFILE_CONTENT, bundled_profile};
use super::{AgentActInvocationSourceType, build_agent_act_invocation};
use crate::{CredentialDelivery, SkillInvocation};

fn temp_skill(body: &str) -> Result<tempfile::TempDir, std::io::Error> {
    let directory = tempfile::tempdir()?;
    fs::write(
        directory.path().join("SKILL.md"),
        format!(
            "---\nname: contract-test\ndescription: Contract test\n---\n\n# Contract test\n\n{body}\n"
        ),
    )?;
    Ok(directory)
}

fn invocation(skill_directory: PathBuf, outputs: Option<JsonObject>) -> SkillInvocation {
    SkillInvocation {
        skill_name: "contract-test".to_owned(),
        step_id: None,
        artifacts: None,
        allowed_tools: None,
        source: SkillSource {
            source_type: SourceKind::Agent,
            command: None,
            module: None,
            javascript_export: None,
            pages: None,
            args: Vec::new(),
            cwd: None,
            timeout_seconds: None,
            input_mode: None,
            environment: EnvironmentRequirements::default(),
            server: None,
            tool: None,
            arguments: None,
            agent_card_url: None,
            agent_identity: None,
            agent: None,
            task: None,
            outputs,
            graph: None,
            external_adapter: None,
            thread_outbox_provider: None,
            act: None,
            raw: JsonObject::new(),
        },
        requirements: ExecutionRequirements::default(),
        inputs: JsonObject::new(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        provenance: Vec::new(),
        skill_directory,
        env: BTreeMap::new(),
        credential_delivery: CredentialDelivery::none(),
    }
}

fn outputs() -> JsonObject {
    BTreeMap::from([("plan".to_owned(), JsonValue::String("object".to_owned()))])
}

#[test]
fn bundled_voice_profile_has_content_addressed_identity() {
    let profile = bundled_profile("VOICE.md", BUNDLED_VOICE_PROFILE_CONTENT);

    assert_eq!(profile.content, BUNDLED_VOICE_PROFILE_CONTENT);
    assert!(profile.sha256.as_ref().starts_with("sha256:"));
    assert_eq!(profile.root_path.as_ref(), "runx://profiles");
}

#[test]
fn bundled_voice_profile_matches_canonical_workspace_profile() -> Result<(), std::io::Error> {
    let canonical = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("skills")
        .join("VOICE.md");
    let source = fs::read_to_string(&canonical)?;

    assert_eq!(BUNDLED_VOICE_PROFILE_CONTENT, source);
    Ok(())
}

#[test]
fn agent_invocation_requires_declared_outputs() -> Result<(), Box<dyn std::error::Error>> {
    let skill = temp_skill("Produce one bounded, evidence-backed plan.")?;
    let request = invocation(skill.path().to_path_buf(), None);

    let Err(error) = build_agent_act_invocation(&request, AgentActInvocationSourceType::Agent)
    else {
        return Err("missing outputs must fail".into());
    };

    assert!(error.to_string().contains("at least one output"));
    Ok(())
}

#[test]
fn agent_invocation_pins_voice_and_output_contracts() -> Result<(), Box<dyn std::error::Error>> {
    let skill = temp_skill("Produce one bounded, evidence-backed plan.")?;
    let request = invocation(skill.path().to_path_buf(), Some(outputs()));

    let resolved = build_agent_act_invocation(&request, AgentActInvocationSourceType::Agent)?;

    assert!(resolved.envelope.voice_profile.is_some());
    assert_eq!(
        resolved.envelope.output.as_ref().map(BTreeMap::len),
        Some(1)
    );
    Ok(())
}

#[test]
fn agent_context_carries_exact_non_secret_requirements_and_environment_readiness()
-> Result<(), Box<dyn std::error::Error>> {
    let skill = temp_skill("Use the declared execution requirements without guessing.")?;
    let mut request = invocation(skill.path().to_path_buf(), Some(outputs()));
    request.requirements = ExecutionRequirements {
        auth: Some(JsonValue::Object(JsonObject::from([(
            "mode".to_owned(),
            JsonValue::String("oauth".to_owned()),
        )]))),
        scopes: vec![
            "provider:Read.Mixed".to_owned(),
            "provider:Read.Mixed".to_owned(),
            "opaque/scope?x=1".to_owned(),
        ],
        environment: EnvironmentRequirements {
            required: vec!["REGION".to_owned()],
            optional: vec!["TRACE_LABEL".to_owned()],
        },
        credential: Some(ExecutionCredentialRequirement {
            name: "primary".to_owned(),
            provider: "example".to_owned(),
            audience: Some("operator".to_owned()),
            deliveries: BTreeMap::from([("api_key".to_owned(), "EXAMPLE_TOKEN".to_owned())]),
        }),
        runtime: Some(JsonValue::Object(JsonObject::from([(
            "engine".to_owned(),
            JsonValue::String("managed-agent".to_owned()),
        )]))),
    };
    request.env = BTreeMap::from([
        ("REGION".to_owned(), "ap-southeast-2".to_owned()),
        ("TRACE_LABEL".to_owned(), "private-value".to_owned()),
        ("UNDECLARED".to_owned(), "never-visible".to_owned()),
    ]);

    let resolved = build_agent_act_invocation(&request, AgentActInvocationSourceType::Agent)?;
    assert_eq!(
        resolved.envelope.requirements.declaration,
        request.requirements
    );
    assert_eq!(
        resolved.envelope.requirements.environment,
        vec![
            runx_contracts::EnvironmentRequirementStatus {
                name: "REGION".to_owned(),
                required: true,
                available: true,
            },
            runx_contracts::EnvironmentRequirementStatus {
                name: "TRACE_LABEL".to_owned(),
                required: false,
                available: true,
            },
        ]
    );
    let serialized = serde_json::to_string(&resolved.envelope)?;
    assert!(!serialized.contains("private-value"));
    assert!(!serialized.contains("never-visible"));
    Ok(())
}

#[test]
fn agent_step_instructions_are_the_complete_canonical_skill_document()
-> Result<(), Box<dyn std::error::Error>> {
    let skill_rule = "Keep domain policy in the skill.";
    let skill = temp_skill(skill_rule)?;
    let manual = fs::read_to_string(skill.path().join("SKILL.md"))?;
    let mut request = invocation(skill.path().to_path_buf(), Some(outputs()));
    request.step_id = Some("review".to_owned());
    request.provenance = vec![ProvenanceEntry {
        input: "source".into(),
        output: "research_packet".into(),
        from_step: Some("research".to_owned()),
        artifact_id: None,
        receipt_id: Some("rx_research".to_owned()),
    }];

    let resolved = build_agent_act_invocation(&request, AgentActInvocationSourceType::AgentStep)?;

    assert_eq!(resolved.envelope.instructions.as_ref(), manual);
    assert_eq!(
        resolved.envelope.instructions_sha256.as_ref(),
        sha256_prefixed(manual.as_bytes())
    );
    assert_eq!(
        resolved.envelope.step_id.as_ref().map(AsRef::as_ref),
        Some("review")
    );
    assert_eq!(resolved.envelope.provenance, request.provenance);
    Ok(())
}

#[test]
fn agent_step_fails_without_skill_instructions() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let request = invocation(directory.path().to_path_buf(), Some(outputs()));

    let error = build_agent_act_invocation(&request, AgentActInvocationSourceType::AgentStep)
        .expect_err("agent tasks without SKILL.md instructions must fail closed");

    assert!(error.to_string().contains("SKILL.md"));
    Ok(())
}
