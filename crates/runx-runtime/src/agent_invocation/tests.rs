use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use runx_contracts::{JsonObject, JsonValue};
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
        source: SkillSource {
            source_type: SourceKind::Agent,
            command: None,
            args: Vec::new(),
            cwd: None,
            timeout_seconds: None,
            input_mode: None,
            sandbox: None,
            server: None,
            catalog_ref: None,
            tool: None,
            arguments: None,
            agent_card_url: None,
            agent_identity: None,
            agent: None,
            task: None,
            hook: None,
            outputs,
            graph: None,
            http: None,
            act: None,
            raw: JsonObject::new(),
        },
        inputs: JsonObject::new(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
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
