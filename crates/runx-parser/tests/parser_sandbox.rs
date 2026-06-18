use runx_parser::{
    ValidateSkillOptions, parse_skill_markdown, validate_skill, validate_skill_with_options,
};

#[test]
fn skill_sandbox_uses_core_policy_normalization() -> Result<(), String> {
    let raw = parse_skill_markdown(
        r#"---
name: networked-cli
source:
  type: cli-tool
  command: node
  sandbox:
    profile: network
---
# Networked CLI
"#,
    )
    .map_err(|error| error.to_string())?;
    let skill = validate_skill(raw).map_err(|error| error.to_string())?;

    let sandbox = skill
        .source
        .sandbox
        .ok_or_else(|| "expected sandbox".to_owned())?;

    assert_eq!(sandbox.profile.as_str(), "network");
    assert_eq!(
        sandbox.cwd_policy.as_ref().map(|policy| policy.as_str()),
        Some("skill-directory")
    );
    assert_eq!(sandbox.network, Some(true));
    assert!(sandbox.writable_paths.is_empty());
    assert_eq!(sandbox.require_enforcement, None);
    assert!(sandbox.raw.contains_key("profile"));
    Ok(())
}

#[test]
fn explicit_sandbox_enforcement_stays_author_owned() -> Result<(), String> {
    let raw = parse_skill_markdown(
        r#"---
name: enforced-cli
source:
  type: cli-tool
  command: node
  sandbox:
    profile: readonly
    require_enforcement: true
---
# Enforced CLI
"#,
    )
    .map_err(|error| error.to_string())?;
    let skill = validate_skill(raw).map_err(|error| error.to_string())?;

    let sandbox = skill
        .source
        .sandbox
        .ok_or_else(|| "expected sandbox".to_owned())?;

    assert_eq!(sandbox.require_enforcement, Some(true));
    assert!(sandbox.raw.contains_key("require_enforcement"));
    Ok(())
}

#[test]
fn approved_escalation_stays_raw_only() -> Result<(), String> {
    let raw = parse_skill_markdown(
        r#"---
name: cli-tool
source:
  type: cli-tool
  command: node
  sandbox:
    profile: workspace-write
    approvedEscalation: true
---
# CLI tool
"#,
    )
    .map_err(|error| error.to_string())?;
    let skill = validate_skill(raw).map_err(|error| error.to_string())?;

    let sandbox = skill
        .source
        .sandbox
        .ok_or_else(|| "expected sandbox".to_owned())?;

    assert!(sandbox.approved_escalation.is_none());
    assert!(sandbox.raw.contains_key("approvedEscalation"));
    Ok(())
}

#[test]
fn sandbox_env_allowlist_rejects_receipt_signing_env() -> Result<(), String> {
    let raw = parse_skill_markdown(
        r#"---
name: cli-tool
source:
  type: cli-tool
  command: node
  sandbox:
    profile: readonly
    env_allowlist:
      - PATH
      - RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64
---
# CLI tool
"#,
    )
    .map_err(|error| error.to_string())?;

    let error = validate_skill(raw)
        .err()
        .ok_or_else(|| "reserved env allowlist unexpectedly passed".to_owned())?;

    assert!(
        error
            .to_string()
            .contains("reserved runx environment variable RUNX_RECEIPT_SIGN_ED25519_SEED_BASE64"),
        "unexpected error: {error}"
    );
    Ok(())
}

#[test]
fn sandbox_env_allowlist_rejects_runx_secret_like_env() -> Result<(), String> {
    let raw = parse_skill_markdown(
        r#"---
name: cli-tool
source:
  type: cli-tool
  command: node
  sandbox:
    profile: readonly
    env_allowlist:
      - RUNX_AGENT_API_KEY
---
# CLI tool
"#,
    )
    .map_err(|error| error.to_string())?;

    let error = validate_skill(raw)
        .err()
        .ok_or_else(|| "reserved env allowlist unexpectedly passed".to_owned())?;

    assert!(
        error
            .to_string()
            .contains("reserved runx environment variable RUNX_AGENT_API_KEY"),
        "unexpected error: {error}"
    );
    Ok(())
}

#[test]
fn lenient_skill_validation_ignores_non_object_runx_metadata() -> Result<(), String> {
    let raw = parse_skill_markdown(
        r#"---
name: portable
runx: invalid
---
Body
"#,
    )
    .map_err(|error| error.to_string())?;
    let skill = validate_skill_with_options(raw, ValidateSkillOptions::lenient())
        .map_err(|error| error.to_string())?;

    assert!(skill.runx.is_none());
    assert_eq!(skill.source.source_type.as_str(), "agent");
    Ok(())
}
