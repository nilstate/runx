#![cfg(all(feature = "cli-tool", feature = "mcp"))]

use std::collections::BTreeMap;
use std::path::PathBuf;

use runx_contracts::CredentialEnvelopeKind;
use runx_contracts::{CredentialDeliveryMode, CredentialDeliveryPurpose, CredentialMaterialRole};
use runx_contracts::{
    CredentialDeliveryObservation, CredentialDeliveryObservationSchema,
    CredentialDeliveryObservationStatus, Reference, ReferenceType,
};
use runx_core::policy::{CredentialBindingDecision, CredentialEnvelope};
use runx_parser::{SkillSandbox, SkillSource};
use runx_runtime::adapters::cli_tool::CliToolAdapter;
use runx_runtime::adapters::mcp::{FixtureMcpTransport, McpAdapter, ProcessMcpTransport};
use runx_runtime::{
    CredentialDelivery, CredentialDeliveryError, CredentialDeliveryProfile,
    InMemoryMaterialResolver, InvocationStatus, ResolvedCredentialMaterial, RuntimeError,
    SkillAdapter, SkillInvocation,
};

const FIXTURE_CREATED_AT: &str = "2026-05-18T00:00:00Z";
const RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV: &str = "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY";

/// A minimal delivered-credential observation for the resolution tests, which
/// assert on the delivered secret, not on the observation contents.
fn delivered_observation() -> CredentialDeliveryObservation {
    CredentialDeliveryObservation {
        schema: CredentialDeliveryObservationSchema::V1,
        observation_id: "test-credential-delivery".into(),
        request_id: "test-credential-request".into(),
        response_id: None,
        status: CredentialDeliveryObservationStatus::Delivered,
        harness_ref: Reference::with_uri(
            ReferenceType::Harness,
            "runx:harness:test-credential-binding",
        ),
        host_ref: None,
        profile_id: "github-api-key".into(),
        provider: "github".into(),
        purpose: CredentialDeliveryPurpose::ProviderApi,
        delivery_mode: Some(CredentialDeliveryMode::ProcessEnv),
        credential_refs: Vec::new(),
        material_ref_hash: None,
        delivered_roles: vec![CredentialMaterialRole::ApiKey],
        redaction_refs: None,
        observed_at: FIXTURE_CREATED_AT.into(),
    }
}

#[test]
fn delivery_profile_requires_allowed_binding() -> Result<(), Box<dyn std::error::Error>> {
    let result = CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Deny {
            reasons: vec!["grant mismatch".to_owned()],
        },
        &credential(),
        &github_profile()?,
        &resolver(),
        delivered_observation(),
    );

    match result {
        Err(CredentialDeliveryError::BindingDenied { reasons }) => {
            assert_eq!(reasons, vec!["grant mismatch"]);
        }
        Ok(_) => {
            return Err(std::io::Error::other(
                "credential delivery must fail closed on denied binding",
            )
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected error: {error}")).into());
        }
    }
    Ok(())
}

#[test]
fn delivery_profile_rejects_provider_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let result = CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["allowed".to_owned()],
        },
        &credential(),
        &CredentialDeliveryProfile::env_token("slack", "api_key", "SLACK_TOKEN")?,
        &resolver(),
        delivered_observation(),
    );

    match result {
        Err(CredentialDeliveryError::ProviderMismatch {
            credential_provider,
            profile_provider,
        }) => {
            assert_eq!(credential_provider, "github");
            assert_eq!(profile_provider, "slack");
        }
        Ok(_) => {
            return Err(std::io::Error::other(
                "credential delivery must reject mismatched providers",
            )
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected error: {error}")).into());
        }
    }
    Ok(())
}

#[test]
fn delivery_profile_maps_process_env_contract_profile() -> Result<(), Box<dyn std::error::Error>> {
    let profile = CredentialDeliveryProfile::from_contract_profile(&contract_profile(
        vec![CredentialMaterialRole::ApiKey],
        "GITHUB_TOKEN",
    ))?;
    let delivery = CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["allowed".to_owned()],
        },
        &credential(),
        &profile,
        &resolver(),
        delivered_observation(),
    )?;

    assert_eq!(profile.provider(), "github");
    assert_eq!(profile.auth_mode(), "api_key");
    assert_eq!(
        delivery.secret_env().get("GITHUB_TOKEN"),
        Some("ghs_secret_token")
    );
    Ok(())
}

#[test]
fn local_descriptor_observation_uses_live_timestamp() -> Result<(), Box<dyn std::error::Error>> {
    let delivery = CredentialDelivery::from_local_descriptor(
        "github",
        "bearer",
        "GITHUB_TOKEN",
        "local://github/main",
        vec!["repo".to_owned()],
        "ghs_secret_token",
    )?;
    let observation = delivery
        .public_observation()
        .ok_or("local descriptor must record public observation")?;

    assert_ne!(observation.observed_at, FIXTURE_CREATED_AT);
    assert!(observation.observed_at.ends_with('Z'));
    Ok(())
}

#[test]
fn public_observation_metadata_serializes_without_secret_material()
-> Result<(), Box<dyn std::error::Error>> {
    let secret = "ghs_observation_secret_must_not_leak";
    let delivery = CredentialDelivery::from_local_descriptor(
        "github",
        "bearer",
        "GITHUB_TOKEN",
        "local://github/main",
        vec!["repo".to_owned()],
        secret,
    )?;
    let observation = delivery
        .public_observation()
        .ok_or("local descriptor must record public observation")?;

    assert_eq!(observation.provider.as_str(), "github");
    assert_eq!(observation.credential_refs.len(), 1);
    assert!(
        observation.credential_refs[0]
            .uri
            .as_str()
            .starts_with("runx:credential:local:")
    );
    assert!(
        !observation.credential_refs[0]
            .uri
            .as_str()
            .contains("local://github/main")
    );
    assert!(
        observation
            .material_ref_hash
            .as_ref()
            .is_some_and(|hash| hash.as_str().starts_with("sha256:"))
    );

    let serialized = serde_json::to_string(&serde_json::json!({
        "credential_delivery_observations": [observation],
    }))?;
    assert!(serialized.contains("credential_delivery_observations"));
    assert!(!serialized.contains(secret));
    assert!(!serialized.contains("GITHUB_TOKEN"));
    assert!(!serialized.contains("local://github/main"));
    Ok(())
}

#[test]
fn delivery_profile_skips_optional_missing_contract_binding()
-> Result<(), Box<dyn std::error::Error>> {
    let mut contract = contract_profile(vec![CredentialMaterialRole::ApiKey], "GITHUB_TOKEN");
    contract
        .material_roles
        .push(CredentialMaterialRole::PersonalToken);
    contract
        .env_bindings
        .push(runx_contracts::CredentialDeliveryEnvBinding {
            role: CredentialMaterialRole::PersonalToken,
            env_var: "GITHUB_REFRESH_TOKEN".to_owned(),
            required: false,
        });
    let profile = CredentialDeliveryProfile::from_contract_profile(&contract)?;
    let delivery = CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["allowed".to_owned()],
        },
        &credential(),
        &profile,
        &resolver(),
        delivered_observation(),
    )?;

    assert_eq!(
        delivery.secret_env().get("GITHUB_TOKEN"),
        Some("ghs_secret_token")
    );
    assert_eq!(delivery.secret_env().get("GITHUB_REFRESH_TOKEN"), None);
    Ok(())
}

#[test]
fn delivery_profile_resolves_contract_client_secret_role() -> Result<(), Box<dyn std::error::Error>>
{
    let profile = CredentialDeliveryProfile::from_contract_profile(&contract_profile(
        vec![CredentialMaterialRole::ClientSecret],
        "GITHUB_CLIENT_SECRET",
    ))?;
    let resolver = InMemoryMaterialResolver::with_material(
        "secret://github/main",
        ResolvedCredentialMaterial::with_role(
            "secret://github/main",
            runx_runtime::CredentialMaterialRole::ClientSecret,
            "client_secret_value",
        ),
    );
    let delivery = CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["allowed".to_owned()],
        },
        &credential(),
        &profile,
        &resolver,
        delivered_observation(),
    )?;

    assert_eq!(
        delivery.secret_env().get("GITHUB_CLIENT_SECRET"),
        Some("client_secret_value")
    );
    Ok(())
}

#[test]
fn delivery_profile_rejects_empty_material() -> Result<(), Box<dyn std::error::Error>> {
    let resolver = InMemoryMaterialResolver::with_material(
        "secret://github/main",
        ResolvedCredentialMaterial::api_key("secret://github/main", "  "),
    );
    let result = CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["allowed".to_owned()],
        },
        &credential(),
        &github_profile()?,
        &resolver,
        delivered_observation(),
    );

    assert!(matches!(
        result,
        Err(CredentialDeliveryError::EmptyMaterial { role }) if role == "api_key"
    ));
    Ok(())
}

#[test]
fn cli_tool_rejects_process_env_credential_delivery_before_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let delivery = allowed_delivery()?;
    let result = CliToolAdapter.invoke(SkillInvocation {
        skill_name: "credential.echo".to_owned(),
        source: cli_source(),
        inputs: Default::default(),
        resolved_inputs: Default::default(),
        current_context: Vec::new(),
        skill_directory: std::env::current_dir()?,
        env: process_env(),
        credential_delivery: delivery,
    });

    assert!(matches!(
        result,
        Err(RuntimeError::CredentialDelivery(
            CredentialDeliveryError::ProcessEnvBoundaryUnsupported { boundary },
        )) if boundary == "cli-tool"
    ));
    Ok(())
}

#[test]
fn cli_tool_omits_truncated_output_before_redaction() -> Result<(), Box<dyn std::error::Error>> {
    let output = CliToolAdapter.invoke(SkillInvocation {
        skill_name: "credential.large-output".to_owned(),
        source: large_output_cli_source(),
        inputs: Default::default(),
        resolved_inputs: Default::default(),
        current_context: Vec::new(),
        skill_directory: std::env::current_dir()?,
        env: process_env(),
        credential_delivery: CredentialDelivery::none(),
    })?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stdout, "");
    assert!(output.stderr.contains("stdout/stderr omitted"));
    assert!(!output.stdout.contains("ghs_secret_token"));
    assert!(!output.stderr.contains("ghs_secret_token"));
    Ok(())
}

#[test]
fn credential_delivery_redacts_before_truncating() -> Result<(), Box<dyn std::error::Error>> {
    let output = allowed_delivery()?.redact_bytes_to_string(
        b"prefix ghs_secret_token suffix".to_vec(),
        "prefix [redacted-credential]".len(),
    );

    assert_eq!(output, "prefix [redacted-credential]");
    assert!(!output.contains("ghs_secret_token"));
    Ok(())
}

#[test]
fn mcp_adapter_delivers_secret_env_and_redacts_tool_result()
-> Result<(), Box<dyn std::error::Error>> {
    let mut inputs = runx_contracts::JsonObject::new();
    inputs.insert(
        "name".to_owned(),
        runx_contracts::JsonValue::String("GITHUB_TOKEN".to_owned()),
    );
    let output = McpAdapter::new(FixtureMcpTransport).invoke(SkillInvocation {
        skill_name: "credential.mcp".to_owned(),
        source: mcp_source(),
        inputs,
        resolved_inputs: Default::default(),
        current_context: Vec::new(),
        skill_directory: std::env::current_dir()?,
        env: process_env(),
        credential_delivery: allowed_delivery()?,
    })?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert_eq!(output.stdout.trim(), "[redacted-credential]");
    assert!(!output.stdout.contains("ghs_secret_token"));
    assert!(!serde_json::to_string(&output.metadata)?.contains("ghs_secret_token"));
    Ok(())
}

#[test]
fn mcp_process_transport_rejects_process_env_credential_delivery()
-> Result<(), Box<dyn std::error::Error>> {
    let mut inputs = runx_contracts::JsonObject::new();
    inputs.insert(
        "name".to_owned(),
        runx_contracts::JsonValue::String("GITHUB_TOKEN".to_owned()),
    );
    let output = McpAdapter::new(ProcessMcpTransport::default()).invoke(SkillInvocation {
        skill_name: "credential.mcp.process".to_owned(),
        source: mcp_process_source()?,
        inputs,
        resolved_inputs: Default::default(),
        current_context: Vec::new(),
        skill_directory: repo_root()?,
        env: process_env(),
        credential_delivery: allowed_delivery()?,
    })?;

    assert_eq!(output.status, InvocationStatus::Failure);
    assert_eq!(output.stdout, "");
    assert_eq!(output.stderr, "MCP adapter failed.");
    assert!(!output.stdout.contains("ghs_secret_token"));
    assert!(!output.stderr.contains("ghs_secret_token"));
    assert!(!serde_json::to_string(&output.metadata)?.contains("ghs_secret_token"));
    Ok(())
}

fn allowed_delivery() -> Result<CredentialDelivery, CredentialDeliveryError> {
    CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["credential material matches admitted grant".to_owned()],
        },
        &credential(),
        &github_profile()?,
        &resolver(),
        delivered_observation(),
    )
}

fn resolver() -> InMemoryMaterialResolver {
    InMemoryMaterialResolver::with_material(
        "secret://github/main",
        ResolvedCredentialMaterial::api_key("secret://github/main", "ghs_secret_token"),
    )
}

fn github_profile() -> Result<CredentialDeliveryProfile, CredentialDeliveryError> {
    CredentialDeliveryProfile::env_token("github", "api_key", "GITHUB_TOKEN")
}

fn credential() -> CredentialEnvelope {
    CredentialEnvelope {
        kind: CredentialEnvelopeKind::V1,
        grant_id: "grant_github_main".into(),
        provider: "github".into(),
        auth_mode: "api_key".into(),
        material_kind: "api_key".into(),
        provider_reference: "github-main".into(),
        scopes: vec!["repo".into()],
        grant_reference: None,
        material_ref: "secret://github/main".into(),
    }
}

fn contract_profile(
    roles: Vec<CredentialMaterialRole>,
    env_var: &str,
) -> runx_contracts::CredentialDeliveryProfile {
    runx_contracts::CredentialDeliveryProfile {
        schema: runx_contracts::CredentialDeliveryProfileSchema::V1,
        profile_id: "github-provider-api-env".into(),
        provider: "github".into(),
        auth_mode: "api_key".into(),
        purpose: CredentialDeliveryPurpose::ProviderApi,
        delivery_mode: CredentialDeliveryMode::ProcessEnv,
        material_roles: roles.clone(),
        env_bindings: roles
            .into_iter()
            .map(|role| runx_contracts::CredentialDeliveryEnvBinding {
                role,
                env_var: env_var.to_owned(),
                required: true,
            })
            .collect(),
        redaction_policy_ref: runx_contracts::Reference {
            reference_type: runx_contracts::ReferenceType::RedactionPolicy,
            uri: "runx:redaction-policy:credentials-v1".to_owned().into(),
            provider: None,
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        },
    }
}

fn cli_source() -> SkillSource {
    SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::CliTool,
        command: Some("sh".to_owned()),
        args: vec![
            "-c".to_owned(),
            "printf '%s\\n' \"$GITHUB_TOKEN\"".to_owned(),
        ],
        cwd: None,
        timeout_seconds: Some(5),
        input_mode: None,
        sandbox: Some(readonly_sandbox()),
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
        raw: Default::default(),
    }
}

fn large_output_cli_source() -> SkillSource {
    let mut source = cli_source();
    source.command = Some("node".to_owned());
    source.args = vec![
        "-e".to_owned(),
        "process.stdout.write('x'.repeat(1024 * 1024 + 1));".to_owned(),
    ];
    source
}

fn mcp_source() -> SkillSource {
    let mut source = cli_source();
    source.source_type = runx_parser::SourceKind::Mcp;
    source.command = None;
    source.args = Vec::new();
    source.server = Some(runx_parser::SkillMcpServer {
        command: "fixture".to_owned(),
        args: Vec::new(),
        cwd: None,
    });
    source.tool = Some("env".to_owned());
    source
}

fn mcp_process_source() -> Result<SkillSource, RuntimeError> {
    let root = repo_root()?;
    let mut source = cli_source();
    source.source_type = runx_parser::SourceKind::Mcp;
    source.command = None;
    source.args = Vec::new();
    source.server = Some(runx_parser::SkillMcpServer {
        command: "node".to_owned(),
        args: vec![
            root.join("fixtures/runtime/adapters/mcp/stdio-server.mjs")
                .to_string_lossy()
                .into_owned(),
        ],
        cwd: Some(root.to_string_lossy().into_owned()),
    });
    source.tool = Some("env".to_owned());
    Ok(source)
}

fn readonly_sandbox() -> SkillSandbox {
    SkillSandbox {
        profile: runx_core::policy::SandboxProfile::Readonly,
        cwd_policy: None,
        env_allowlist: Some(vec!["PATH".to_owned()]),
        network: None,
        writable_paths: Vec::new(),
        require_enforcement: None,
        approved_escalation: None,
        raw: Default::default(),
    }
}

fn process_env() -> BTreeMap<String, String> {
    let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
    env.insert(
        RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY_ENV.to_owned(),
        "local".to_owned(),
    );
    env
}

fn repo_root() -> Result<PathBuf, RuntimeError> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .map_err(|error| RuntimeError::Io {
            context: "repository root is available".to_owned(),
            source: error,
        })
}
