use std::path::PathBuf;
use std::time::Duration;

#[cfg(feature = "thread-outbox-provider")]
use runx_contracts::JsonObject;
use runx_contracts::{
    CredentialDeliveryMode, CredentialDeliveryObservation, CredentialDeliveryObservationStatus,
    CredentialDeliveryPurpose, CredentialMaterialRole, JsonValue, Reference, ReferenceType,
    ThreadOutboxProviderFetch, ThreadOutboxProviderIdempotencyStatus, ThreadOutboxProviderManifest,
    ThreadOutboxProviderObservationStatus, ThreadOutboxProviderOperation, ThreadOutboxProviderPush,
};
use runx_core::policy::{CredentialBindingDecision, CredentialEnvelope};
#[cfg(feature = "thread-outbox-provider")]
use runx_runtime::adapters::thread_outbox_provider::ThreadOutboxProviderSkillAdapter;
use runx_runtime::{
    CredentialDelivery, CredentialDeliveryProfile, InMemoryMaterialResolver,
    ResolvedCredentialMaterial, ThreadOutboxProviderProcessSupervisor,
    ThreadOutboxProviderSupervisorError, ThreadOutboxProviderSupervisorOptions,
};
#[cfg(feature = "thread-outbox-provider")]
use runx_runtime::{InvocationStatus, SkillAdapter, SkillInvocation};

#[derive(Debug, serde::Deserialize)]
struct Fixture<T> {
    expected: T,
}

#[test]
fn provider_process_pushes_idempotently_and_injects_delivery_observation()
-> Result<(), Box<dyn std::error::Error>> {
    let manifest = manifest_with_fixture_args(&["push", "created"])?;
    let push = push_fixture()?;
    let delivery = credential_observation_only();

    let outcome = ThreadOutboxProviderProcessSupervisor::default()
        .invoke_push(&manifest, &push, &delivery)?;

    assert_eq!(
        outcome.observation.status,
        ThreadOutboxProviderObservationStatus::Accepted
    );
    assert_eq!(
        outcome.observation.operation,
        ThreadOutboxProviderOperation::Push
    );
    assert_eq!(
        outcome.observation.request_id.as_str(),
        push.push_id.as_str()
    );
    assert_eq!(
        outcome.observation.idempotency.key.as_str(),
        push.idempotency.key.as_str()
    );
    assert_eq!(
        outcome.observation.idempotency.status,
        ThreadOutboxProviderIdempotencyStatus::Created
    );
    assert_eq!(
        outcome
            .observation
            .delivery_observations
            .as_ref()
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        outcome
            .observation
            .provider_locator
            .as_ref()
            .map(|locator| locator.locator.as_str()),
        Some("runxhq/runx#77/comment-1001")
    );
    assert_eq!(
        outcome.observation.provider_event_id_hash.as_deref(),
        Some("sha256:github-comment-1001")
    );
    assert_eq!(
        outcome
            .observation
            .readback_summary
            .as_ref()
            .map(|summary| (
                summary.item_count,
                summary.cursor.as_deref(),
                summary.latest_provider_event_id_hash.as_deref()
            )),
        Some((1, Some("cursor-2"), Some("sha256:github-comment-1001")))
    );
    assert_eq!(
        outcome
            .observation
            .redaction_refs
            .as_ref()
            .map(|refs| refs.iter().map(|r| r.uri.as_str()).collect::<Vec<_>>()),
        Some(vec!["runx:redaction_policy:provider-output"])
    );
    assert_eq!(outcome.process_exit_code, Some(0));
    Ok(())
}

#[test]
fn provider_process_reports_idempotent_replay() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = manifest_with_fixture_args(&["push", "replayed"])?;
    let push = push_fixture()?;

    let outcome = ThreadOutboxProviderProcessSupervisor::default().invoke_push(
        &manifest,
        &push,
        &CredentialDelivery::none(),
    )?;

    assert_eq!(
        outcome.observation.idempotency.status,
        ThreadOutboxProviderIdempotencyStatus::Replayed
    );
    assert_eq!(
        outcome.observation.idempotency.key.as_str(),
        push.idempotency.key.as_str()
    );
    assert_eq!(
        outcome
            .observation
            .provider_locator
            .as_ref()
            .map(|locator| locator.locator.as_str()),
        Some("runxhq/runx#77/comment-1001")
    );
    Ok(())
}

#[test]
fn provider_process_fetch_shapes_readback_receipt() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = manifest_with_fixture_args(&["fetch"])?;
    let fetch = fetch_fixture()?;

    let outcome = ThreadOutboxProviderProcessSupervisor::default().invoke_fetch(
        &manifest,
        &fetch,
        &CredentialDelivery::none(),
    )?;

    assert_eq!(
        outcome.observation.operation,
        ThreadOutboxProviderOperation::Fetch
    );
    assert_eq!(
        outcome.observation.request_id.as_str(),
        fetch.fetch_id.as_str()
    );
    assert_eq!(
        outcome.observation.idempotency.key.as_str(),
        fetch.idempotency.key.as_str()
    );
    assert_eq!(
        outcome.observation.idempotency.status,
        ThreadOutboxProviderIdempotencyStatus::Replayed
    );
    assert_eq!(
        outcome
            .observation
            .readback_summary
            .as_ref()
            .map(|summary| (
                summary.item_count,
                summary.cursor.as_deref(),
                summary.latest_provider_event_id_hash.as_deref()
            )),
        Some((1, Some("cursor-2"), Some("sha256:github-comment-1001")))
    );
    assert_eq!(
        outcome.observation.provider_event_id_hash.as_deref(),
        Some("sha256:github-comment-1001")
    );
    Ok(())
}

#[test]
fn provider_process_rejects_http_endpoint_manifest() -> Result<(), Box<dyn std::error::Error>> {
    let mut manifest = manifest_with_fixture_args(&["push"])?;
    manifest.transport.endpoint = Some("https://example.test/provider".into());

    let result = ThreadOutboxProviderProcessSupervisor::default().invoke_push(
        &manifest,
        &push_fixture()?,
        &CredentialDelivery::none(),
    );

    assert!(matches!(
        result,
        Err(ThreadOutboxProviderSupervisorError::UnsupportedTransport)
    ));
    Ok(())
}

#[test]
fn provider_process_rejects_secret_like_response_fields() -> Result<(), Box<dyn std::error::Error>>
{
    let manifest = manifest_with_fixture_args(&["secret-field"])?;
    let push = push_fixture()?;

    let result = ThreadOutboxProviderProcessSupervisor::default().invoke_push(
        &manifest,
        &push,
        &CredentialDelivery::none(),
    );

    assert!(matches!(
        result,
        Err(ThreadOutboxProviderSupervisorError::SecretFieldRejected { field })
            if field == "$.access_token"
    ));
    Ok(())
}

#[test]
fn provider_process_injects_and_redacts_process_env_credential_delivery()
-> Result<(), Box<dyn std::error::Error>> {
    let manifest = manifest_with_fixture_args(&["leaky"])?;
    let push = push_fixture()?;
    let delivery = credential_delivery()?;

    let outcome = ThreadOutboxProviderProcessSupervisor::default()
        .invoke_push(&manifest, &push, &delivery)?;

    assert_eq!(
        outcome.observation.status,
        ThreadOutboxProviderObservationStatus::Accepted
    );
    assert!(
        outcome
            .redacted_stderr
            .contains("diagnostic leaked credential [redacted-credential]")
    );
    let errors = outcome
        .observation
        .errors
        .as_ref()
        .ok_or("leaky fixture should return a redacted diagnostic error")?;
    assert_eq!(
        errors[0].message.as_str(),
        "provider mentioned [redacted-credential]"
    );
    assert_eq!(
        outcome
            .observation
            .delivery_observations
            .as_ref()
            .map(Vec::len),
        Some(1)
    );
    assert!(!format!("{outcome:?}").contains("ghs_TEST_SECRET_TOKEN"));
    Ok(())
}

#[test]
fn provider_process_accepts_runtime_output_envelope() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = manifest_with_fixture_args(&["envelope"])?;
    let push = push_fixture()?;

    let outcome = ThreadOutboxProviderProcessSupervisor::default().invoke_push(
        &manifest,
        &push,
        &CredentialDelivery::none(),
    )?;

    assert_eq!(
        outcome.observation.status,
        ThreadOutboxProviderObservationStatus::Accepted
    );
    let output = outcome
        .provider_output
        .as_ref()
        .ok_or("enveloped provider response should project graph output")?;
    assert_eq!(
        output
            .get("push")
            .and_then(JsonValue::as_object)
            .and_then(|push| push.get("locator"))
            .and_then(JsonValue::as_str),
        Some("runxhq/runx#77/comment-1001")
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn provider_process_timeout_kills_process_group_descendants()
-> Result<(), Box<dyn std::error::Error>> {
    let marker = std::env::temp_dir().join(format!(
        "runx-thread-outbox-provider-timeout-{}-{}.marker",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let marker_arg = marker.to_string_lossy().into_owned();
    let manifest = manifest_with_fixture_args(&["spawn-marker", &marker_arg])?;
    let push = push_fixture()?;
    let supervisor =
        ThreadOutboxProviderProcessSupervisor::new(ThreadOutboxProviderSupervisorOptions {
            timeout_ms: 100,
            output_limit_bytes: 4096,
            cwd: None,
        });

    let result = supervisor.invoke_push(&manifest, &push, &CredentialDelivery::none());

    assert!(matches!(
        result,
        Err(ThreadOutboxProviderSupervisorError::TimedOut { timeout_ms: 100 })
    ));
    std::thread::sleep(Duration::from_millis(700));
    assert!(
        !marker.exists(),
        "timed-out provider descendant survived and wrote {}",
        marker.display()
    );
    let _ = std::fs::remove_file(marker);
    Ok(())
}

#[cfg(feature = "thread-outbox-provider")]
#[test]
fn provider_front_dispatches_push_from_skill_source() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path();
    let mut manifest = manifest_with_fixture_args(&["push", "created"])?;
    manifest.transport.args = Some(vec![
        fixture_script()?.to_string_lossy().into_owned(),
        "push".to_owned(),
        "created".to_owned(),
    ]);
    std::fs::write(
        skill_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    std::fs::write(
        skill_dir.join("push.json"),
        serde_json::to_string_pretty(&push_fixture()?)?,
    )?;

    let output = ThreadOutboxProviderSkillAdapter::default().invoke(SkillInvocation {
        skill_name: "fixture-thread-outbox-provider-push".to_owned(),
        source: thread_outbox_source("push", "push.json"),
        inputs: JsonObject::new(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir.to_path_buf(),
        env: Default::default(),
        credential_delivery: CredentialDelivery::none(),
    })?;

    assert_eq!(output.status, InvocationStatus::Success);
    assert!(output.stdout.contains("\"request_id\":\"thread_push_123\""));
    assert_eq!(
        output
            .metadata
            .get("thread_outbox_provider_operation")
            .and_then(JsonValue::as_str),
        Some("push")
    );
    assert_eq!(
        output
            .metadata
            .get("thread_outbox_provider_locator")
            .and_then(JsonValue::as_str),
        Some("runxhq/runx#77/comment-1001")
    );
    Ok(())
}

#[cfg(feature = "thread-outbox-provider")]
#[test]
fn provider_front_projects_runtime_output_envelope() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path();
    let mut manifest = manifest_with_fixture_args(&["envelope"])?;
    manifest.transport.args = Some(vec![
        fixture_script()?.to_string_lossy().into_owned(),
        "envelope".to_owned(),
    ]);
    std::fs::write(
        skill_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    std::fs::write(
        skill_dir.join("push.json"),
        serde_json::to_string_pretty(&push_fixture()?)?,
    )?;

    let output = ThreadOutboxProviderSkillAdapter::default().invoke(SkillInvocation {
        skill_name: "fixture-thread-outbox-provider-push".to_owned(),
        source: thread_outbox_source("push", "push.json"),
        inputs: JsonObject::new(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir.to_path_buf(),
        env: Default::default(),
        credential_delivery: CredentialDelivery::none(),
    })?;
    let stdout: JsonValue = serde_json::from_str(&output.stdout)?;

    assert_eq!(
        stdout
            .as_object()
            .and_then(|object| object.get("push"))
            .and_then(JsonValue::as_object)
            .and_then(|push| push.get("locator"))
            .and_then(JsonValue::as_str),
        Some("runxhq/runx#77/comment-1001")
    );
    assert!(
        stdout
            .as_object()
            .is_some_and(|object| object.contains_key("thread_outbox_provider_observation"))
    );
    Ok(())
}

#[cfg(feature = "thread-outbox-provider")]
#[test]
fn provider_front_builds_dynamic_push_from_inputs() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path();
    let mut manifest = manifest_with_fixture_args(&["envelope"])?;
    manifest.transport.args = Some(vec![
        fixture_script()?.to_string_lossy().into_owned(),
        "envelope".to_owned(),
    ]);
    std::fs::write(
        skill_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let mut inputs = JsonObject::new();
    inputs.insert(
        "thread".to_owned(),
        serde_json::from_value(serde_json::json!({
            "thread_locator": "github://runxhq/runx/issues/77",
            "adapter": {
                "type": "github",
                "adapter_ref": "runxhq/runx#issue/77"
            }
        }))?,
    );
    inputs.insert(
        "outbox_entry".to_owned(),
        serde_json::from_value(serde_json::json!({
            "entry_id": "123",
            "kind": "message",
            "thread_locator": "github://runxhq/runx/issues/77",
            "metadata": {
                "body_markdown": "Provider outcome observed: merged."
            }
        }))?,
    );
    inputs.insert(
        "next_status".to_owned(),
        JsonValue::String("published".to_owned()),
    );

    let output = ThreadOutboxProviderSkillAdapter::default().invoke(SkillInvocation {
        skill_name: "dynamic-thread-outbox-provider-push".to_owned(),
        source: thread_outbox_dynamic_source("push"),
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir.to_path_buf(),
        env: Default::default(),
        credential_delivery: CredentialDelivery::none(),
    })?;
    let stdout: JsonValue = serde_json::from_str(&output.stdout)?;

    assert_eq!(
        stdout
            .as_object()
            .and_then(|object| object.get("push"))
            .and_then(JsonValue::as_object)
            .and_then(|push| push.get("locator"))
            .and_then(JsonValue::as_str),
        Some("runxhq/runx#77/comment-1001")
    );
    Ok(())
}

#[cfg(feature = "thread-outbox-provider")]
#[test]
fn provider_front_skips_dynamic_push_when_thread_is_missing()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path();
    let manifest = manifest_with_fixture_args(&["envelope"])?;
    std::fs::write(
        skill_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let mut inputs = JsonObject::new();
    inputs.insert(
        "outbox_entry".to_owned(),
        serde_json::from_value(serde_json::json!({
            "entry_id": "pull_request:fixture-task",
            "kind": "pull_request",
            "status": "proposed"
        }))?,
    );

    let output = ThreadOutboxProviderSkillAdapter::default().invoke(SkillInvocation {
        skill_name: "dynamic-thread-outbox-provider-push".to_owned(),
        source: thread_outbox_dynamic_source("push"),
        inputs,
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir.to_path_buf(),
        env: Default::default(),
        credential_delivery: CredentialDelivery::none(),
    })?;
    let stdout: JsonValue = serde_json::from_str(&output.stdout)?;

    assert_eq!(
        stdout
            .as_object()
            .and_then(|object| object.get("push"))
            .and_then(JsonValue::as_object)
            .and_then(|push| push.get("status"))
            .and_then(JsonValue::as_str),
        Some("skipped")
    );
    assert_eq!(
        stdout.as_object().and_then(|object| object.get("thread")),
        Some(&JsonValue::Null)
    );
    Ok(())
}

fn manifest_with_fixture_args(
    fixture_args: &[&str],
) -> Result<ThreadOutboxProviderManifest, Box<dyn std::error::Error>> {
    let mut manifest = manifest_fixture()?;
    let mut args = vec![fixture_script()?.to_string_lossy().into_owned()];
    args.extend(fixture_args.iter().map(|arg| (*arg).to_owned()));
    manifest.transport.command = Some("sh".into());
    manifest.transport.args = Some(args);
    Ok(manifest)
}

fn manifest_fixture() -> Result<ThreadOutboxProviderManifest, serde_json::Error> {
    let fixture: Fixture<ThreadOutboxProviderManifest> = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/thread-outbox-provider/manifest.json"
    ))?;
    Ok(fixture.expected)
}

fn push_fixture() -> Result<ThreadOutboxProviderPush, serde_json::Error> {
    let fixture: Fixture<ThreadOutboxProviderPush> = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/thread-outbox-provider/push.json"
    ))?;
    Ok(fixture.expected)
}

fn fetch_fixture() -> Result<ThreadOutboxProviderFetch, serde_json::Error> {
    let fixture: Fixture<ThreadOutboxProviderFetch> = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/thread-outbox-provider/fetch.json"
    ))?;
    Ok(fixture.expected)
}

fn fixture_script() -> Result<PathBuf, std::io::Error> {
    std::fs::canonicalize(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/runtime/thread-outbox-provider/mock-provider.sh"),
    )
}

#[cfg(feature = "thread-outbox-provider")]
fn thread_outbox_source(operation: &str, frame_path: &str) -> runx_parser::SkillSource {
    let mut config = JsonObject::new();
    config.insert(
        "operation".to_owned(),
        JsonValue::String(operation.to_owned()),
    );
    config.insert(
        "manifest_path".to_owned(),
        JsonValue::String("manifest.json".to_owned()),
    );
    config.insert(
        format!("{operation}_path"),
        JsonValue::String(frame_path.to_owned()),
    );
    let mut raw = JsonObject::new();
    raw.insert(
        "type".to_owned(),
        JsonValue::String("thread-outbox-provider".to_owned()),
    );
    raw.insert(
        "thread_outbox_provider".to_owned(),
        JsonValue::Object(config),
    );
    runx_parser::SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::ThreadOutboxProvider,
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
        outputs: None,
        graph: None,
        http: None,
        raw,
    }
}

#[cfg(feature = "thread-outbox-provider")]
fn thread_outbox_dynamic_source(operation: &str) -> runx_parser::SkillSource {
    let mut config = JsonObject::new();
    config.insert(
        "operation".to_owned(),
        JsonValue::String(operation.to_owned()),
    );
    config.insert(
        "manifest_path".to_owned(),
        JsonValue::String("manifest.json".to_owned()),
    );
    let mut raw = JsonObject::new();
    raw.insert(
        "type".to_owned(),
        JsonValue::String("thread-outbox-provider".to_owned()),
    );
    raw.insert(
        "thread_outbox_provider".to_owned(),
        JsonValue::Object(config),
    );
    runx_parser::SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::ThreadOutboxProvider,
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
        outputs: None,
        graph: None,
        http: None,
        raw,
    }
}

fn credential_delivery() -> Result<CredentialDelivery, Box<dyn std::error::Error>> {
    let profile = CredentialDeliveryProfile::env_token("github", "api_key", "GITHUB_TOKEN")?;
    let credential: CredentialEnvelope = serde_json::from_value(serde_json::json!({
        "kind": "runx.credential-envelope.v1",
        "grant_id": "grant-github",
        "provider": "github",
        "auth_mode": "api_key",
        "material_kind": "api_key",
        "provider_reference": "github-main",
        "scopes": ["issues:write"],
        "material_ref": "secret://github/main"
    }))?;
    let resolver = InMemoryMaterialResolver::with_material(
        "secret://github/main",
        ResolvedCredentialMaterial::api_key("secret://github/main", "ghs_TEST_SECRET_TOKEN"),
    );
    let delivery = CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["test grant".to_owned()],
        },
        &credential,
        &profile,
        &resolver,
    )?
    .with_public_observation(CredentialDeliveryObservation {
        schema: runx_contracts::CredentialDeliveryObservationSchema::V1,
        observation_id: "cred_obs_123".into(),
        request_id: "cred_req_123".into(),
        response_id: Some("cred_resp_123".into()),
        status: CredentialDeliveryObservationStatus::Delivered,
        harness_ref: Reference {
            reference_type: ReferenceType::Harness,
            uri: "runx:harness:hrn_123".to_owned().into(),
            provider: None,
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        },
        host_ref: Some(Reference {
            reference_type: ReferenceType::Host,
            uri: "runx:host:local-cli".to_owned().into(),
            provider: None,
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        }),
        profile_id: "github-provider-api-env".into(),
        provider: "github".into(),
        purpose: CredentialDeliveryPurpose::ProviderApi,
        delivery_mode: Some(CredentialDeliveryMode::ProcessEnv),
        credential_refs: vec![Reference {
            reference_type: ReferenceType::Credential,
            uri: "runx:credential:github-installation:123".to_owned().into(),
            provider: Some("github".to_owned().into()),
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        }],
        material_ref_hash: Some("sha256:material-ref".into()),
        delivered_roles: vec![CredentialMaterialRole::ApiKey],
        redaction_refs: Some(vec![Reference {
            reference_type: ReferenceType::RedactionPolicy,
            uri: "runx:redaction_policy:provider-output".to_owned().into(),
            provider: None,
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        }]),
        observed_at: "2026-05-22T00:00:00Z".into(),
    });
    Ok(delivery)
}

fn credential_observation_only() -> CredentialDelivery {
    CredentialDelivery::none().with_public_observation(CredentialDeliveryObservation {
        schema: runx_contracts::CredentialDeliveryObservationSchema::V1,
        observation_id: "cred_obs_123".into(),
        request_id: "cred_req_123".into(),
        response_id: Some("cred_resp_123".into()),
        status: CredentialDeliveryObservationStatus::Delivered,
        harness_ref: Reference {
            reference_type: ReferenceType::Harness,
            uri: "runx:harness:hrn_123".to_owned().into(),
            provider: None,
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        },
        host_ref: Some(Reference {
            reference_type: ReferenceType::Host,
            uri: "runx:host:local-cli".to_owned().into(),
            provider: None,
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        }),
        profile_id: "github-provider-api-env".into(),
        provider: "github".into(),
        purpose: CredentialDeliveryPurpose::ProviderApi,
        delivery_mode: Some(CredentialDeliveryMode::ProcessEnv),
        credential_refs: vec![Reference {
            reference_type: ReferenceType::Credential,
            uri: "runx:credential:github-installation:123".to_owned().into(),
            provider: Some("github".to_owned().into()),
            locator: None,
            label: None,
            observed_at: None,
            proof_kind: None,
        }],
        material_ref_hash: Some("sha256:material-ref".into()),
        delivered_roles: vec![CredentialMaterialRole::ApiKey],
        redaction_refs: None,
        observed_at: "2026-05-22T00:00:01Z".into(),
    })
}
