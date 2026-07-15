#![cfg(feature = "external-adapter")]

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::{Duration, Instant};

use runx_contracts::{
    CredentialDeliveryMode, CredentialDeliveryObservation, CredentialDeliveryObservationSchema,
    CredentialDeliveryObservationStatus, CredentialDeliveryPurpose, CredentialEnvelopeKind,
    CredentialMaterialRole, ExecutionEvent, ExternalAdapterCancellationSchema,
    ExternalAdapterHostResolutionFrame, ExternalAdapterHostResolutionSchema,
    ExternalAdapterInvocation, ExternalAdapterInvocationSchema, ExternalAdapterManifest,
    ExternalAdapterManifestSchema, ExternalAdapterProtocolVersion, ExternalAdapterResponse,
    ExternalAdapterSandboxIntent, ExternalAdapterStatus, ExternalAdapterTimeouts,
    ExternalAdapterTransport, ExternalAdapterTransportKind, JsonNumber, JsonObject, JsonValue,
    Question, Reference, ReferenceType, ResolutionRequest, ResolutionResponse,
    ResolutionResponseActor,
};
use runx_core::policy::{CredentialBindingDecision, CredentialEnvelope};
use runx_core::state_machine::GraphStatus;
use runx_parser::SkillSource;
use runx_runtime::adapters::external_adapter::{
    ExternalAdapterProcessSupervisor, ExternalAdapterSkillAdapter, ExternalAdapterSupervisorError,
};
use runx_runtime::{
    CredentialDelivery, CredentialDeliveryError, CredentialDeliveryProfile, Host,
    InMemoryMaterialResolver, InvocationStatus, ResolvedCredentialMaterial, Runtime, RuntimeError,
    RuntimeOptions, SkillAdapter, SkillInvocation,
};

const MANIFEST_SCHEMA: &str = "runx.external_adapter.manifest.v1";
const RESPONSE_SCHEMA: &str = "runx.external_adapter.response.v1";
const PROTOCOL_VERSION: &str = "runx.external_adapter.v1";
const SANDBOX_FALLBACK_ENV: &str = "RUNX_SANDBOX_ALLOW_DECLARED_POLICY_ONLY";
const SANDBOX_FALLBACK_VALUE: &str = "local";

#[test]
fn external_adapter_process_supervisor_invokes_contract_process()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let capture_path = temp.path().join("captured-invocation.json");
    let response_path = temp.path().join("response.json");
    fs::write(&response_path, serde_json::to_vec(&completed_response())?)?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r invocation
printf '%s' "$invocation" > "$RUNX_CAPTURE_INVOCATION"
/bin/cat "$RUNX_RESPONSE_PATH"
"#,
    )?;
    let mut manifest = manifest_for_script(&script)?;
    manifest.sandbox_intent.profile = "workspace-write".into();
    manifest.sandbox_intent.writable_paths = Some(vec!["captured-invocation.json".into()]);
    let invocation = invocation_with_env([
        ("RUNX_CWD", path_string(temp.path())?),
        (
            "RUNX_CAPTURE_INVOCATION",
            path_string(capture_path.as_path())?,
        ),
        ("RUNX_RESPONSE_PATH", path_string(response_path.as_path())?),
        local_sandbox_fallback_env(),
    ]);

    let outcome = ExternalAdapterProcessSupervisor.invoke(&manifest, &invocation)?;

    assert_eq!(outcome.response.status, ExternalAdapterStatus::Completed);
    assert_eq!(
        outcome.response.stdout.as_deref(),
        Some("{\"summary\":\"Issue needs triage\"}")
    );
    assert_eq!(outcome.process_exit_code, Some(0));
    let captured: ExternalAdapterInvocation =
        serde_json::from_slice(&fs::read(capture_path.as_path())?)?;
    assert_eq!(captured, invocation);
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_allows_network_sandbox_intent()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("response.json");
    fs::write(&response_path, serde_json::to_vec(&completed_response())?)?;
    let script = write_cat_response_script(temp.path())?;
    let mut manifest = manifest_for_script(&script)?;
    manifest.sandbox_intent.profile = "network".into();
    manifest.sandbox_intent.network = true;
    let invocation = invocation_with_env([
        ("RUNX_RESPONSE_PATH", path_string(&response_path)?),
        local_sandbox_fallback_env(),
    ]);

    let outcome = ExternalAdapterProcessSupervisor.invoke(&manifest, &invocation)?;

    assert_eq!(outcome.response.status, ExternalAdapterStatus::Completed);
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_unsupported_sandbox_profile_before_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let marker_path = temp.path().join("spawned");
    let script = write_script(
        temp.path(),
        r#"set -eu
printf 'spawned' > "$RUNX_SPAWNED_MARKER"
"#,
    )?;
    let mut manifest = manifest_for_script(&script)?;
    manifest.sandbox_intent.profile = "superuser".into();
    let invocation = invocation_with_env([("RUNX_SPAWNED_MARKER", path_string(&marker_path)?)]);

    let Err(error) = ExternalAdapterProcessSupervisor.invoke(&manifest, &invocation) else {
        return Err("unsupported sandbox profile must fail closed".into());
    };

    assert!(matches!(
        error,
        ExternalAdapterSupervisorError::SandboxDenied { message }
            if message.contains("unsupported external adapter sandbox profile 'superuser'")
    ));
    assert!(!marker_path.exists());
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_network_sandbox_writable_paths_before_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let marker_path = temp.path().join("spawned");
    let script = write_script(
        temp.path(),
        r#"set -eu
printf 'spawned' > "$RUNX_SPAWNED_MARKER"
"#,
    )?;
    let mut manifest = manifest_for_script(&script)?;
    manifest.sandbox_intent.profile = "network".into();
    manifest.sandbox_intent.network = true;
    manifest.sandbox_intent.writable_paths = Some(vec!["out.json".into()]);
    let invocation = invocation_with_env([("RUNX_SPAWNED_MARKER", path_string(&marker_path)?)]);

    let Err(error) = ExternalAdapterProcessSupervisor.invoke(&manifest, &invocation) else {
        return Err("network sandbox with writable paths must fail closed".into());
    };

    assert!(matches!(
        error,
        ExternalAdapterSupervisorError::SandboxDenied { message }
            if message.contains("network sandbox cannot declare writable paths")
    ));
    assert!(!marker_path.exists());
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_mismatched_response_identity()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("response.json");
    let mut response = completed_response();
    response.adapter_id = "adapter.other".to_owned();
    fs::write(&response_path, serde_json::to_vec(&response)?)?;
    let script = write_cat_response_script(temp.path())?;
    let invocation = invocation_with_env([
        ("RUNX_RESPONSE_PATH", path_string(&response_path)?),
        local_sandbox_fallback_env(),
    ]);

    let Err(error) =
        ExternalAdapterProcessSupervisor.invoke(&manifest_for_script(&script)?, &invocation)
    else {
        return Err("mismatched response identity must fail closed".into());
    };

    assert!(matches!(
        error,
        ExternalAdapterSupervisorError::ResponseMismatch {
            field: "adapter_id",
            ..
        }
    ));
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_unexpected_credential_request()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("credential-request.json");
    fs::write(
        &response_path,
        br#"{"schema":"runx.external_adapter.credential_request.v1","protocol_version":"runx.external_adapter.v1","request_id":"cred_req_1","adapter_id":"adapter.github.issue-intake","invocation_id":"external_inv_123","credential_refs":[],"requested_at":"2026-05-21T15:00:01Z"}"#,
    )?;
    let script = write_cat_response_script(temp.path())?;
    let invocation = invocation_with_env([
        ("RUNX_RESPONSE_PATH", path_string(&response_path)?),
        local_sandbox_fallback_env(),
    ]);

    let Err(error) =
        ExternalAdapterProcessSupervisor.invoke(&manifest_for_script(&script)?, &invocation)
    else {
        return Err("credential request frame on response channel must fail closed".into());
    };

    assert!(matches!(
        error,
        ExternalAdapterSupervisorError::UnexpectedCredentialRequest { request_id }
            if request_id == "cred_req_1"
    ));
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_times_out_and_maps_cancellation()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r _invocation
/bin/sleep 5
"#,
    )?;
    let mut manifest = manifest_for_script(&script)?;
    manifest.timeouts.invocation_ms = 50;
    let invocation = invocation_with_env([local_sandbox_fallback_env()]);

    let Err(error) = ExternalAdapterProcessSupervisor.invoke(&manifest, &invocation) else {
        return Err("timed out process must fail closed".into());
    };

    let ExternalAdapterSupervisorError::TimedOut {
        timeout_ms,
        cancellation,
    } = error
    else {
        return Err(format!("unexpected timeout error: {error}").into());
    };
    assert_eq!(timeout_ms, 50);
    assert_eq!(
        cancellation.protocol_version,
        ExternalAdapterProtocolVersion::V1
    );
    assert_eq!(cancellation.schema, ExternalAdapterCancellationSchema::V1);
    assert_eq!(cancellation.adapter_id, "adapter.github.issue-intake");
    assert_eq!(cancellation.invocation_id, "external_inv_123");
    assert_eq!(cancellation.reason, "invocation timeout after 50ms");
    Ok(())
}

#[cfg(unix)]
#[test]
fn external_adapter_process_supervisor_timeout_kills_descendant_processes()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let sentinel_path = temp.path().join("descendant-survived");
    let pid_path = temp.path().join("descendant-pid");
    // The parent records the backgrounded descendant's pid via `$!`; the test
    // polls that pid for death instead of sleeping a fixed window.
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r _invocation
(
  /bin/sleep 3
  printf survived > "$RUNX_DESCENDANT_SENTINEL"
) &
echo $! > "$RUNX_DESCENDANT_PIDFILE"
/bin/sleep 10
"#,
    )?;
    let mut manifest = manifest_for_script(&script)?;
    manifest.timeouts.invocation_ms = 1_000;
    // Under the readonly intent the sandbox swallows the pid and sentinel writes,
    // leaving the survived-descendant assertion vacuous; anchor the workspace at
    // the test's temp dir (RUNX_CWD) and scope write access to it so both
    // signals are observable.
    manifest.sandbox_intent.profile = "workspace-write".into();
    manifest.sandbox_intent.writable_paths = Some(vec![path_string(temp.path())?.into()]);
    let invocation = invocation_with_env([
        ("RUNX_DESCENDANT_SENTINEL", path_string(&sentinel_path)?),
        ("RUNX_DESCENDANT_PIDFILE", path_string(&pid_path)?),
        ("RUNX_CWD", path_string(temp.path())?),
        local_sandbox_fallback_env(),
    ]);

    let started = Instant::now();
    let Err(error) = ExternalAdapterProcessSupervisor.invoke(&manifest, &invocation) else {
        return Err("timed out process must fail closed".into());
    };

    let ExternalAdapterSupervisorError::TimedOut { timeout_ms, .. } = error else {
        return Err(format!("unexpected timeout error: {error}").into());
    };
    assert_eq!(timeout_ms, 1_000);
    assert!(started.elapsed() < Duration::from_secs(5));
    crate::support::wait_for_recorded_pid_exit(&pid_path, Duration::from_secs(5))?;
    assert!(
        !sentinel_path.exists(),
        "descendant process survived external adapter timeout"
    );
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_crashed_process()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r _invocation
exit 12
"#,
    )?;

    let Err(error) = ExternalAdapterProcessSupervisor.invoke(
        &manifest_for_script(&script)?,
        &invocation_with_env([local_sandbox_fallback_env()]),
    ) else {
        return Err("crashed process must fail closed".into());
    };

    assert!(matches!(
        error,
        ExternalAdapterSupervisorError::ProcessFailed { .. }
    ));
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_spawn_failure()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let mut manifest = manifest_for_script(&temp.path().join("missing-adapter-command"))?;
    let missing_command = path_string(&temp.path().join("missing-shell"))?;
    manifest.transport.command = Some(missing_command.clone().into());

    let Err(error) = ExternalAdapterProcessSupervisor.invoke(
        &manifest,
        &invocation_with_env([local_sandbox_fallback_env()]),
    ) else {
        return Err("spawn failure must fail closed".into());
    };

    match error {
        ExternalAdapterSupervisorError::Io { context, .. } => {
            assert!(context.starts_with("spawning external adapter process `"));
            assert!(context.contains(&missing_command));
        }
        ExternalAdapterSupervisorError::ProcessFailed { .. } => {
            // A platform sandbox wrapper may spawn successfully and then fail
            // inside the wrapper when the child command is missing.
        }
        error => {
            return Err(format!("unexpected spawn failure mapping: {error:?}").into());
        }
    }
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_oversized_stdout()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r _invocation
chunk=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
i=0
while [ "$i" -lt 20000 ]; do
  printf '%s' "$chunk"
  i=$((i + 1))
done
"#,
    )?;

    let Err(error) = ExternalAdapterProcessSupervisor.invoke(
        &manifest_for_script(&script)?,
        &invocation_with_env([local_sandbox_fallback_env()]),
    ) else {
        return Err("oversized stdout must fail closed".into());
    };

    assert!(matches!(
        error,
        ExternalAdapterSupervisorError::ResponseTooLarge { .. }
    ));
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_unknown_protocol_before_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let manifest = serde_json::json!({
        "schema": MANIFEST_SCHEMA,
        "protocol_version": "runx.external_adapter.v2",
        "adapter_id": "adapter.github.issue-intake",
        "name": "GitHub issue intake adapter",
        "version": "0.1.0",
        "supported_source_types": ["external-adapter"],
        "transport": { "kind": "process", "command": "/bin/sh" },
        "timeouts": { "startup_ms": 500, "invocation_ms": 2_000 },
        "sandbox_intent": {
            "profile": "readonly",
            "network": false,
            "cwd_policy": "skill-directory"
        }
    });
    let error = match serde_json::from_value::<ExternalAdapterManifest>(manifest) {
        Ok(_) => {
            return Err("typed manifest must reject unknown protocol before supervision".into());
        }
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("runx.external_adapter.v1"),
        "unexpected serde error: {error}"
    );
    Ok(())
}

#[test]
fn external_adapter_graph_invocation_reaches_process_supervisor()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("external-skill");
    fs::create_dir_all(&skill_dir)?;
    let response_path = skill_dir.join("response.json");
    let mut response = completed_response();
    response.invocation_id = "external_adapter.external-smoke.invoke".to_owned();
    response.stdout = Some("{\"summary\":\"graph reached supervisor\"}".to_owned());
    let mut output = JsonObject::new();
    output.insert(
        "summary".to_owned(),
        JsonValue::String("graph reached supervisor".to_owned()),
    );
    response.output = Some(output);
    fs::write(&response_path, serde_json::to_vec(&response)?)?;
    write_script(
        &skill_dir,
        r#"set -eu
IFS= read -r invocation
case "$invocation" in
  *'"source_type":"external-adapter"'*) ;;
  *)
    printf 'missing source type: %s\n' "$invocation" >&2
    exit 64
    ;;
esac
case "$invocation" in
  *'"adapter_id":"adapter.github.issue-intake"'*) ;;
  *)
    printf 'missing adapter id: %s\n' "$invocation" >&2
    exit 64
    ;;
esac
case "$invocation" in
  *'"skill_ref":"external-smoke"'*) ;;
  *)
    printf 'missing skill ref: %s\n' "$invocation" >&2
    exit 64
    ;;
esac
case "$invocation" in
  *'"issue_number":77'*) ;;
  *)
    printf 'missing issue number: %s\n' "$invocation" >&2
    exit 64
    ;;
esac
/bin/cat response.json
"#,
    )?;
    write_external_adapter_skill(&skill_dir)?;
    let graph_path = temp.path().join("graph.yaml");
    fs::write(
        &graph_path,
        "name: external-adapter-graph\nsteps:\n  - id: invoke\n    skill: ./external-skill\n    inputs:\n      issue_number: 77\n",
    )?;

    let run = Runtime::new(
        ExternalAdapterSkillAdapter::default(),
        local_runtime_options_with_sandbox_fallback(),
    )
    .run_graph_file(&graph_path)?;

    assert_eq!(run.state.status, GraphStatus::Succeeded);
    assert_eq!(run.steps.len(), 1);
    assert_eq!(
        run.steps[0].output.stdout,
        "{\"summary\":\"graph reached supervisor\"}"
    );
    Ok(())
}

#[test]
fn external_adapter_manifest_path_resolves_below_skill_directory()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("response.json");
    let mut response = completed_response();
    response.invocation_id = "external_adapter.external-smoke.invoke".to_owned();
    fs::write(&response_path, serde_json::to_vec(&response)?)?;
    let script = write_cat_response_script(temp.path())?;
    let manifest = manifest_for_script(&script)?;
    fs::write(
        temp.path().join("external-adapter.manifest.json"),
        serde_json::to_vec(&manifest)?,
    )?;

    let output = ExternalAdapterSkillAdapter::default().invoke(skill_invocation_with_source(
        temp.path(),
        skill_source_manifest_path("external-adapter.manifest.json")?,
        [
            ("RUNX_RESPONSE_PATH", path_string(&response_path)?),
            local_sandbox_fallback_env(),
        ],
        CredentialDelivery::none(),
    )?)?;

    assert_eq!(output.status, runx_runtime::InvocationStatus::Success);
    Ok(())
}

#[test]
fn external_adapter_manifest_path_rejects_directory_escape()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;

    let Err(error) = ExternalAdapterSkillAdapter::default().invoke(skill_invocation_with_source(
        temp.path(),
        skill_source_manifest_path("../external-adapter.manifest.json")?,
        [],
        CredentialDelivery::none(),
    )?) else {
        return Err("manifest path escape must fail closed".into());
    };

    assert!(matches!(
        error,
        RuntimeError::SkillFailed { message, .. }
            if message.contains("relative path below the skill directory")
    ));
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_rejects_process_env_credential_delivery()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r _invocation
printf '{"schema":"runx.external_adapter.response.v1","protocol_version":"runx.external_adapter.v1","invocation_id":"external_inv_123","adapter_id":"adapter.github.issue-intake","status":"completed","stdout":"should-not-run","exit_code":0,"observed_at":"2026-05-21T15:00:00Z"}'
"#,
    )?;
    let invocation = invocation_with_env([("GITHUB_TOKEN", "scoped_token".to_owned())]);

    let result = ExternalAdapterProcessSupervisor.invoke_with_delivery(
        &manifest_for_script(&script)?,
        &invocation,
        &allowed_delivery()?,
    );

    assert!(matches!(
        result,
        Err(ExternalAdapterSupervisorError::CredentialProcessEnvUnsupported)
    ));
    assert!(
        !format!("{result:?}").contains("ghs_secret_token"),
        "process boundary denial must not leak raw credential material"
    );
    Ok(())
}

#[test]
fn external_adapter_skill_adapter_projects_public_credential_refs_and_observation()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("response.json");
    let mut response = completed_response();
    response.invocation_id = "external_adapter.external-smoke.invoke".to_owned();
    fs::write(&response_path, serde_json::to_vec(&response)?)?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r invocation
case "$invocation" in
  *'"credential_ref":{"type":"credential","uri":"runx:credential:grant_github_main"}'*'"provider":"github"'*)
    ;;
  *)
    printf 'missing public credential reference: %s\n' "$invocation" >&2
    exit 65
    ;;
esac
/bin/cat "$RUNX_RESPONSE_PATH"
"#,
    )?;
    let manifest = manifest_for_script(&script)?;

    let output = ExternalAdapterSkillAdapter::default().invoke(skill_invocation_with_source(
        temp.path(),
        skill_source(Some(manifest))?,
        [
            ("RUNX_RESPONSE_PATH", path_string(response_path.as_path())?),
            local_sandbox_fallback_env(),
        ],
        credential_observation_only(),
    )?)?;

    assert_eq!(output.status, runx_runtime::InvocationStatus::Success);
    let observations = output
        .metadata
        .get("credential_delivery_observations")
        .ok_or("credential delivery observation must be receipt metadata")?;
    assert!(matches!(observations, JsonValue::Array(values) if values.len() == 1));
    assert!(
        !serde_json::to_string(&output.metadata)?.contains("ghs_secret_token"),
        "public external adapter frames must not contain raw credential material"
    );
    Ok(())
}

#[test]
fn external_adapter_skill_adapter_preserves_response_stderr()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("response.json");
    let mut response = completed_response();
    response.invocation_id = "external_adapter.external-smoke.invoke".to_owned();
    response.stderr = Some("adapter warning".to_owned());
    fs::write(&response_path, serde_json::to_vec(&response)?)?;
    let script = write_cat_response_script(temp.path())?;
    let manifest = manifest_for_script(&script)?;

    let output = ExternalAdapterSkillAdapter::default().invoke(skill_invocation(
        temp.path(),
        Some(manifest),
        [
            ("RUNX_RESPONSE_PATH", path_string(&response_path)?),
            local_sandbox_fallback_env(),
        ],
    )?)?;

    assert_eq!(output.status, runx_runtime::InvocationStatus::Success);
    assert_eq!(output.stderr, "adapter warning");
    Ok(())
}

#[test]
fn external_adapter_process_supervisor_maps_host_resolution_frame()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("host-resolution.json");
    fs::write(
        &response_path,
        serde_json::to_vec(&host_resolution_frame("external_inv_123"))?,
    )?;
    let script = write_cat_response_script(temp.path())?;
    let invocation = invocation_with_env([
        ("RUNX_RESPONSE_PATH", path_string(&response_path)?),
        local_sandbox_fallback_env(),
    ]);

    let outcome =
        ExternalAdapterProcessSupervisor.invoke(&manifest_for_script(&script)?, &invocation)?;

    assert_eq!(
        outcome.response.status,
        ExternalAdapterStatus::HostResolutionRequested
    );
    assert_eq!(
        outcome
            .response
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("external_adapter_host_resolution_frame_id")),
        Some(&JsonValue::String("host_resolution_1".to_owned()))
    );
    assert!(matches!(
        outcome
            .response
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("external_adapter_host_resolution_request")),
        Some(JsonValue::Object(_))
    ));
    Ok(())
}

#[test]
fn external_adapter_graph_host_resolution_frame_reaches_host()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let skill_dir = temp.path().join("external-skill");
    fs::create_dir_all(&skill_dir)?;
    let response_path = skill_dir.join("response.json");
    fs::write(
        &response_path,
        serde_json::to_vec(&host_resolution_frame(
            "external_adapter.external-smoke.invoke",
        ))?,
    )?;
    write_script(
        &skill_dir,
        r#"set -eu
IFS= read -r _invocation
/bin/cat response.json
"#,
    )?;
    write_external_adapter_skill(&skill_dir)?;
    let graph_path = temp.path().join("graph.yaml");
    fs::write(
        &graph_path,
        "name: external-adapter-host-resolution\nsteps:\n  - id: invoke\n    skill: ./external-skill\n",
    )?;
    let mut host = RecordingHost::with_responses([Some(ResolutionResponse {
        actor: ResolutionResponseActor::Human,
        payload: JsonValue::String("approved".to_owned()),
    })]);

    let result = Runtime::new(
        ExternalAdapterSkillAdapter::default(),
        local_runtime_options_with_sandbox_fallback(),
    )
    .run_graph_file_with_host(&graph_path, &mut host);

    assert!(matches!(result, Err(RuntimeError::SkillFailed { .. })));
    assert_eq!(host.requests.borrow().len(), 1);
    assert!(matches!(
        host.events
            .borrow()
            .iter()
            .find(|event| matches!(event, ExecutionEvent::ResolutionRequested { .. })),
        Some(ExecutionEvent::ResolutionRequested { .. })
    ));
    assert!(matches!(
        host.events
            .borrow()
            .iter()
            .find(|event| matches!(event, ExecutionEvent::ResolutionResolved { .. })),
        Some(ExecutionEvent::ResolutionResolved { .. })
    ));
    Ok(())
}

#[test]
fn external_adapter_skill_adapter_fails_closed_without_inline_manifest()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;

    let Err(error) =
        ExternalAdapterSkillAdapter::default().invoke(skill_invocation(temp.path(), None, [])?)
    else {
        return Err("external-adapter source without manifest must fail closed".into());
    };

    assert!(matches!(
        error,
        RuntimeError::SkillFailed { message, .. }
            if message.contains("missing a manifest")
    ));
    Ok(())
}

#[test]
fn external_adapter_skill_adapter_preserves_supervisor_fail_closed_response_mismatch()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let response_path = temp.path().join("response.json");
    let mut response = completed_response();
    response.invocation_id = "external_adapter.external-smoke.invoke".to_owned();
    response.adapter_id = "adapter.other".to_owned();
    fs::write(&response_path, serde_json::to_vec(&response)?)?;
    let script = write_cat_response_script(temp.path())?;
    let manifest = manifest_for_script(&script)?;

    let Err(error) = ExternalAdapterSkillAdapter::default().invoke(skill_invocation(
        temp.path(),
        Some(manifest),
        [
            ("RUNX_RESPONSE_PATH", path_string(&response_path)?),
            local_sandbox_fallback_env(),
        ],
    )?) else {
        return Err("mismatched response identity must fail closed through SkillAdapter".into());
    };

    assert!(matches!(
        error,
        RuntimeError::SkillFailed { message, .. }
            if message.contains("adapter_id") && message.contains("adapter.other")
    ));
    Ok(())
}

#[test]
fn external_adapter_skill_adapter_filters_ambient_env_from_invocation()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let capture_path = temp.path().join("captured-invocation.json");
    let response_path = temp.path().join("response.json");
    let mut response = completed_response();
    response.invocation_id = "external_adapter.external-smoke.invoke".to_owned();
    fs::write(&response_path, serde_json::to_vec(&response)?)?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r invocation
printf '%s' "$invocation" > "$RUNX_CAPTURE_INVOCATION"
/bin/cat "$RUNX_RESPONSE_PATH"
"#,
    )?;
    let mut manifest = manifest_for_script(&script)?;
    manifest.sandbox_intent.profile = "workspace-write".into();
    manifest.sandbox_intent.writable_paths = Some(vec!["captured-invocation.json".into()]);

    let output = ExternalAdapterSkillAdapter::default().invoke(skill_invocation(
        temp.path(),
        Some(manifest),
        [
            ("RUNX_CWD", path_string(temp.path())?),
            (
                "RUNX_CAPTURE_INVOCATION",
                path_string(capture_path.as_path())?,
            ),
            ("RUNX_RESPONSE_PATH", path_string(response_path.as_path())?),
            local_sandbox_fallback_env(),
            ("RUNX_API_TOKEN", "do-not-forward-runx-token".to_owned()),
            ("SECRET_TOKEN", "do-not-forward".to_owned()),
        ],
    )?)?;

    assert_eq!(output.status, InvocationStatus::Success);
    let captured: ExternalAdapterInvocation =
        serde_json::from_slice(&fs::read(capture_path.as_path())?)?;
    let scoped_env = captured
        .env
        .as_ref()
        .ok_or("expected RUNX control env in external adapter invocation")?;
    assert!(scoped_env.contains_key("RUNX_RESPONSE_PATH"));
    assert!(
        !scoped_env.contains_key("SECRET_TOKEN"),
        "ambient shell secrets must not be forwarded to external adapters"
    );
    assert!(
        !scoped_env.contains_key("RUNX_API_TOKEN"),
        "secret-like RUNX env must not be forwarded to external adapters"
    );
    assert!(
        !serde_json::to_string(&captured)?.contains("do-not-forward"),
        "ambient secret value must not be serialized into adapter stdin"
    );
    Ok(())
}

#[test]
fn external_adapter_skill_adapter_rejects_process_env_credential_delivery()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let script = write_script(
        temp.path(),
        r#"set -eu
IFS= read -r _invocation
printf '{"schema":"runx.external_adapter.response.v1","protocol_version":"runx.external_adapter.v1","invocation_id":"external_adapter.external-smoke.invoke","adapter_id":"adapter.github.issue-intake","status":"completed","stdout":"should-not-run","exit_code":0,"observed_at":"2026-05-21T15:00:00Z"}'
"#,
    )?;
    let manifest = manifest_for_script(&script)?;

    let result = ExternalAdapterSkillAdapter::default().invoke(skill_invocation_with_source(
        temp.path(),
        skill_source(Some(manifest))?,
        [("GITHUB_TOKEN", "scoped_token".to_owned())],
        allowed_delivery()?,
    )?);

    assert!(matches!(
        result,
        Err(RuntimeError::SkillFailed { ref message, .. })
            if message.contains("structured credential refs")
    ));
    assert!(!format!("{result:?}").contains("ghs_secret_token"));
    assert!(!format!("{result:?}").contains("scoped_token"));
    Ok(())
}

fn write_cat_response_script(dir: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    write_script(
        dir,
        r#"set -eu
IFS= read -r _invocation
/bin/cat "$RUNX_RESPONSE_PATH"
"#,
    )
}

fn local_runtime_options_with_sandbox_fallback() -> RuntimeOptions {
    let mut options = RuntimeOptions::local_development();
    options.env.insert(
        SANDBOX_FALLBACK_ENV.to_owned(),
        SANDBOX_FALLBACK_VALUE.to_owned(),
    );
    options
}

fn local_sandbox_fallback_env() -> (&'static str, String) {
    (SANDBOX_FALLBACK_ENV, SANDBOX_FALLBACK_VALUE.to_owned())
}

fn write_script(dir: &Path, body: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = dir.join("adapter.sh");
    fs::write(path.as_path(), body)?;
    Ok(path)
}

fn write_external_adapter_skill(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::write(
        dir.join("SKILL.md"),
        r#"---
name: external-smoke
source:
  type: external-adapter
  external_adapter:
    manifest:
      schema: runx.external_adapter.manifest.v1
      protocol_version: runx.external_adapter.v1
      adapter_id: adapter.github.issue-intake
      name: GitHub issue intake adapter
      version: 0.1.0
      supported_source_types:
        - external-adapter
      transport:
        kind: process
        command: /bin/sh
        args:
          - adapter.sh
      timeouts:
        startup_ms: 500
        invocation_ms: 2000
      sandbox_intent:
        profile: readonly
        network: false
        cwd_policy: skill-directory
---

Exercise the external adapter runtime wiring path.
"#,
    )?;
    Ok(())
}

fn manifest_for_script(
    script: &Path,
) -> Result<ExternalAdapterManifest, Box<dyn std::error::Error>> {
    Ok(ExternalAdapterManifest {
        schema: ExternalAdapterManifestSchema::V1,
        protocol_version: ExternalAdapterProtocolVersion::V1,
        adapter_id: "adapter.github.issue-intake".into(),
        name: "GitHub issue intake adapter".into(),
        version: "0.1.0".into(),
        supported_source_types: vec!["external-adapter".into()],
        transport: ExternalAdapterTransport {
            kind: ExternalAdapterTransportKind::Process,
            command: Some("/bin/sh".into()),
            args: Some(vec![path_string(script)?]),
            endpoint: None,
        },
        timeouts: ExternalAdapterTimeouts {
            startup_ms: 500,
            invocation_ms: 2_000,
        },
        credential_needs: None,
        sandbox_intent: ExternalAdapterSandboxIntent {
            profile: "readonly".into(),
            network: false,
            cwd_policy: "skill-directory".into(),
            writable_paths: None,
        },
        metadata: None,
    })
}

fn skill_invocation<const N: usize>(
    skill_dir: &Path,
    manifest: Option<ExternalAdapterManifest>,
    env: [(&str, String); N],
) -> Result<SkillInvocation, Box<dyn std::error::Error>> {
    skill_invocation_with_source(
        skill_dir,
        skill_source(manifest)?,
        env,
        CredentialDelivery::none(),
    )
}

fn skill_invocation_with_source<const N: usize>(
    skill_dir: &Path,
    source: SkillSource,
    env: [(&str, String); N],
    credential_delivery: CredentialDelivery,
) -> Result<SkillInvocation, Box<dyn std::error::Error>> {
    Ok(SkillInvocation {
        skill_name: "external-smoke".to_owned(),
        source,
        inputs: [(
            "issue_number".to_owned(),
            JsonValue::Number(JsonNumber::I64(77)),
        )]
        .into_iter()
        .collect(),
        resolved_inputs: JsonObject::new(),
        current_context: Vec::new(),
        skill_directory: skill_dir.to_path_buf(),
        env: env
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
        credential_delivery,
    })
}

fn skill_source(
    manifest: Option<ExternalAdapterManifest>,
) -> Result<SkillSource, Box<dyn std::error::Error>> {
    let mut raw = JsonObject::new();
    raw.insert(
        "type".to_owned(),
        JsonValue::String("external-adapter".to_owned()),
    );
    if let Some(manifest) = manifest {
        let mut external_adapter = JsonObject::new();
        external_adapter.insert("manifest".to_owned(), contract_json_value(&manifest)?);
        raw.insert(
            "external_adapter".to_owned(),
            JsonValue::Object(external_adapter),
        );
    }
    Ok(SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::ExternalAdapter,
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
    })
}

fn skill_source_manifest_path(path: &str) -> Result<SkillSource, Box<dyn std::error::Error>> {
    let mut external_adapter = JsonObject::new();
    external_adapter.insert(
        "manifest_path".to_owned(),
        JsonValue::String(path.to_owned()),
    );
    let mut raw = JsonObject::new();
    raw.insert(
        "type".to_owned(),
        JsonValue::String("external-adapter".to_owned()),
    );
    raw.insert(
        "external_adapter".to_owned(),
        JsonValue::Object(external_adapter),
    );
    Ok(SkillSource {
        act: None,
        source_type: runx_parser::SourceKind::ExternalAdapter,
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
    })
}

fn invocation_with_env<const N: usize>(env: [(&str, String); N]) -> ExternalAdapterInvocation {
    ExternalAdapterInvocation {
        schema: ExternalAdapterInvocationSchema::V1,
        protocol_version: ExternalAdapterProtocolVersion::V1,
        invocation_id: "external_inv_123".into(),
        adapter_id: "adapter.github.issue-intake".into(),
        run_id: "run_123".into(),
        step_id: "issue-intake".into(),
        source_type: "external-adapter".into(),
        skill_ref: "runx/github-issue-intake".into(),
        harness_ref: reference(ReferenceType::Harness, "runx:harness:hrn_123"),
        host_ref: reference(ReferenceType::Host, "runx:host:local-cli"),
        inputs: [
            (
                "repo".to_owned(),
                JsonValue::String("runxhq/runx".to_owned()),
            ),
            (
                "issue_number".to_owned(),
                JsonValue::Number(JsonNumber::I64(77)),
            ),
        ]
        .into_iter()
        .collect(),
        resolved_inputs: Some(
            [(
                "repo".to_owned(),
                JsonValue::String("runxhq/runx".to_owned()),
            )]
            .into_iter()
            .collect(),
        ),
        cwd: None,
        receipt_dir: Some("/workspace/.runx/receipts".into()),
        env: Some(
            env.into_iter()
                .map(|(key, value)| (key.to_owned(), JsonValue::String(value)))
                .collect(),
        ),
        credential_refs: None,
        metadata: None,
    }
}

fn completed_response() -> ExternalAdapterResponse {
    let mut output = JsonObject::new();
    output.insert(
        "decision".to_owned(),
        JsonValue::String("request_review".to_owned()),
    );
    output.insert(
        "summary".to_owned(),
        JsonValue::String("Issue needs triage".to_owned()),
    );

    ExternalAdapterResponse {
        schema: RESPONSE_SCHEMA.to_owned(),
        protocol_version: PROTOCOL_VERSION.to_owned(),
        invocation_id: "external_inv_123".to_owned(),
        adapter_id: "adapter.github.issue-intake".to_owned(),
        status: ExternalAdapterStatus::Completed,
        stdout: Some("{\"summary\":\"Issue needs triage\"}".to_owned()),
        stderr: Some(String::new()),
        exit_code: Some(Some(0)),
        output: Some(output),
        artifacts: None,
        errors: None,
        telemetry: None,
        metadata: None,
        observed_at: "2026-05-21T15:00:00Z".to_owned(),
    }
}

fn host_resolution_frame(invocation_id: &str) -> ExternalAdapterHostResolutionFrame {
    ExternalAdapterHostResolutionFrame {
        schema: ExternalAdapterHostResolutionSchema::V1,
        protocol_version: ExternalAdapterProtocolVersion::V1,
        frame_id: "host_resolution_1".into(),
        invocation_id: invocation_id.to_owned().into(),
        adapter_id: "adapter.github.issue-intake".into(),
        request: ResolutionRequest::Input {
            id: "input_request_1".into(),
            questions: vec![Question {
                id: "triage_label".into(),
                prompt: "Triage label".into(),
                description: None,
                required: true,
                question_type: "text".into(),
            }],
        },
        requested_at: "2026-05-21T15:00:00Z".into(),
    }
}

fn allowed_delivery() -> Result<CredentialDelivery, CredentialDeliveryError> {
    CredentialDelivery::from_allowed_binding(
        &CredentialBindingDecision::Allow {
            reasons: vec!["credential material matches admitted grant".to_owned()],
        },
        &credential(),
        &CredentialDeliveryProfile::env_token("github", "api_key", "GITHUB_TOKEN")?,
        &InMemoryMaterialResolver::with_material(
            "secret://github/main",
            ResolvedCredentialMaterial::api_key("secret://github/main", "ghs_secret_token"),
        ),
        credential_delivery_observation(),
    )
}

fn credential_observation_only() -> CredentialDelivery {
    CredentialDelivery::none().with_public_observation(credential_delivery_observation())
}

fn credential_delivery_observation() -> CredentialDeliveryObservation {
    CredentialDeliveryObservation {
        schema: CredentialDeliveryObservationSchema::V1,
        observation_id: "credential_delivery_observation_1".into(),
        request_id: "credential_delivery_request_1".into(),
        response_id: Some("credential_delivery_response_1".into()),
        status: CredentialDeliveryObservationStatus::Delivered,
        harness_ref: reference(ReferenceType::Harness, "runx:harness:hrn_123"),
        host_ref: Some(reference(ReferenceType::Host, "runx:host:local-cli")),
        profile_id: "github-api-key-env".into(),
        provider: "github".into(),
        purpose: CredentialDeliveryPurpose::ProviderApi,
        delivery_mode: Some(CredentialDeliveryMode::ProcessEnv),
        credential_refs: vec![reference(
            ReferenceType::Credential,
            "runx:credential:grant_github_main",
        )],
        material_ref_hash: Some("sha256:material-ref-hash".into()),
        delivered_roles: vec![CredentialMaterialRole::ApiKey],
        redaction_refs: Some(vec![reference(
            ReferenceType::RedactionPolicy,
            "runx:evidence:redaction-policy/github-token",
        )]),
        observed_at: "2026-05-21T15:00:00Z".into(),
    }
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

fn reference(reference_type: ReferenceType, uri: &str) -> Reference {
    Reference {
        reference_type,
        uri: uri.to_owned().into(),
        provider: None,
        locator: None,
        label: None,
        observed_at: None,
        proof_kind: None,
    }
}

fn path_string(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    Ok(path
        .to_str()
        .ok_or("test path must be valid UTF-8")?
        .to_owned())
}

fn contract_json_value(value: &impl serde::Serialize) -> Result<JsonValue, serde_json::Error> {
    let value = serde_json::to_value(value)?;
    serde_json::from_value(value)
}

struct RecordingHost {
    events: RefCell<Vec<ExecutionEvent>>,
    requests: RefCell<Vec<ResolutionRequest>>,
    responses: RefCell<VecDeque<Option<ResolutionResponse>>>,
}

impl RecordingHost {
    fn with_responses<const N: usize>(responses: [Option<ResolutionResponse>; N]) -> Self {
        Self {
            events: RefCell::new(Vec::new()),
            requests: RefCell::new(Vec::new()),
            responses: RefCell::new(VecDeque::from(responses)),
        }
    }
}

impl Host for RecordingHost {
    fn report(&mut self, event: ExecutionEvent) -> Result<(), RuntimeError> {
        self.events.borrow_mut().push(event);
        Ok(())
    }

    fn resolve(
        &mut self,
        request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        self.requests.borrow_mut().push(request);
        Ok(self.responses.borrow_mut().pop_front().flatten())
    }
}
