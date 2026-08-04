#![allow(clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::Path;

use runx_contracts::{
    ExecutionEvent, JsonObject, JsonValue, ProofKind, ReferenceType, ResolutionRequest,
    ResolutionResponse, ResolutionResponseActor,
};
use runx_parser::GraphStep;
use runx_runtime::effects::ResolvedEffectTarget;
use runx_runtime::{
    EffectApprovalRequirement, EffectOutputRequest, EffectStepRequest, Host, InvocationOutput,
    LocalReceiptStore, PROVIDER_MUTATE_TOOL, PROVIDER_PERMISSION_EFFECT_FAMILY,
    PROVIDER_PERMISSION_GRANT_ID_ENV, PROVIDER_PERMISSION_GRANTED_SCOPES_ENV,
    PROVIDER_PERMISSION_PRINCIPAL_REF_ENV, PROVIDER_READ_TOOL, ProviderApprovalEvidence,
    ProviderEffectAuthority, ProviderEffectClass, ProviderEffectIntent, ProviderEffectIntentInput,
    ProviderEffectResolved, ProviderPermissionEffect, RuntimeEffect, RuntimeError,
    encode_provider_scopes_env,
};

const PROVIDER: &str = "slack";
const OPERATION: &str = "channel.post";
const TARGET: &str = "slack://workspace/channel";
const SCOPE: &str = "channel.post";
const GRANT_ID: &str = "grant_slack_operator";
const PRINCIPAL_REF: &str = "runx:principal:operator:test";
const CREATED_AT: &str = "2026-07-20T00:00:00Z";

#[test]
fn provider_effect_receipts_bind_approval_ack_readback_and_grant() {
    let payload = JsonObject::from([(
        "text".to_owned(),
        JsonValue::String("hello from runx".to_owned()),
    )]);
    let inputs = provider_inputs(PROVIDER_MUTATE_TOOL, payload.clone());
    let step = provider_step(PROVIDER_MUTATE_TOOL, "write", true);
    let env = provider_env();
    let effect = ProviderPermissionEffect::default();
    let admission = effect
        .admit(effect_request(&step, &inputs, &env))
        .expect("provider admission")
        .expect("owned provider effect");
    let mut host = RecordingHost::approving();
    let admission = effect
        .resolve_approval(
            EffectApprovalRequirement::Required,
            &step,
            admission,
            &mut host,
        )
        .expect("exact provider approval");
    assert_eq!(host.requests.len(), 1);

    let resolved = resolved_effect(ProviderEffectClass::Mutation, &payload, Some("request-1"));
    let attempt = resolved
        .clone()
        .begin(Some(ProviderApprovalEvidence {
            actor: "human".to_owned(),
            approval_key: "approval-key-does-not-affect-attempt-identity".to_owned(),
            plan_digest: resolved.plan_digest().to_owned(),
        }))
        .expect("provider attempt");
    let claim = provider_claim(
        attempt.resolved().plan_digest(),
        attempt.idempotency_key(),
        Some("operation-123"),
    );
    let mut output = successful_output(&claim);
    effect
        .prepare_output(EffectOutputRequest {
            step: &step,
            admission: &admission,
            claim: &claim,
            output: &mut output,
        })
        .expect("provider finality projection");

    let receipt = runx_runtime::receipts::step_receipt_with_authority_grant_refs(
        "provider-effect-receipt",
        "mutate",
        1,
        &output,
        &claim,
        effect
            .authority_grant_refs(&admission)
            .expect("authority grant refs"),
        CREATED_AT,
    )
    .expect("provider effect receipt");
    let temp = tempfile::tempdir().expect("receipt store");
    let store = LocalReceiptStore::new(temp.path());
    store.write_receipt(&receipt).expect("verified receipt");
    let stored = store
        .read_exact(receipt.id.as_str())
        .expect("stored receipt");
    let refs = verification_refs(&stored);

    assert_eq!(stored.authority.grant_refs.len(), 1);
    assert_eq!(
        stored.authority.grant_refs[0].uri.as_str(),
        "runx:grant:grant_slack_operator"
    );
    assert_eq!(
        refs.iter()
            .filter(|reference| reference.proof_kind == Some(ProofKind::EffectEvidence))
            .count(),
        3
    );
    assert_eq!(
        refs.iter()
            .filter(|reference| reference.proof_kind == Some(ProofKind::EffectFinality))
            .count(),
        1
    );
    assert!(
        refs.iter()
            .any(|reference| { reference.uri.as_str() == "runx:provider_ack:operation-123" })
    );
    assert!(
        refs.iter()
            .any(|reference| { reference.uri.as_str() == "runx:provider_readback:operation-123" })
    );
}

#[test]
fn provider_effect_receipts_reads_do_not_request_approval() {
    let payload =
        JsonObject::from([("query".to_owned(), JsonValue::String("incident".to_owned()))]);
    let inputs = provider_inputs(PROVIDER_READ_TOOL, payload.clone());
    let step = provider_step(PROVIDER_READ_TOOL, "read", false);
    let env = provider_env();
    let effect = ProviderPermissionEffect::default();
    let admission = effect
        .admit(effect_request(&step, &inputs, &env))
        .expect("provider admission")
        .expect("owned provider effect");
    let mut host = RecordingHost::default();
    let admission = effect
        .resolve_approval(
            EffectApprovalRequirement::Forbidden,
            &step,
            admission,
            &mut host,
        )
        .expect("approval-free read transition");
    assert!(host.requests.is_empty());

    let attempt = resolved_effect(ProviderEffectClass::Read, &payload, None)
        .begin(None)
        .expect("read attempt");
    let claim = provider_claim(
        attempt.resolved().plan_digest(),
        attempt.idempotency_key(),
        None,
    );
    let mut output = successful_output(&claim);
    effect
        .prepare_output(EffectOutputRequest {
            step: &step,
            admission: &admission,
            claim: &claim,
            output: &mut output,
        })
        .expect("provider read finality projection");

    let refs = metadata_verification_refs(&output);
    assert_eq!(
        refs.iter()
            .filter(|reference| reference.proof_kind == Some(ProofKind::EffectEvidence))
            .count(),
        1
    );
    assert_eq!(
        refs.iter()
            .filter(|reference| reference.proof_kind == Some(ProofKind::EffectFinality))
            .count(),
        1
    );
}

#[test]
fn provider_effect_mutations_require_host_attested_human_approval() {
    let inputs = provider_inputs(PROVIDER_MUTATE_TOOL, JsonObject::new());
    let step = provider_step(PROVIDER_MUTATE_TOOL, "write", true);
    let env = provider_env();
    let effect = ProviderPermissionEffect::default();
    let admission = effect
        .admit(effect_request(&step, &inputs, &env))
        .expect("provider admission")
        .expect("owned provider effect");
    let mut host = RecordingHost::agent_approving();

    let error = effect
        .resolve_approval(
            EffectApprovalRequirement::Required,
            &step,
            admission,
            &mut host,
        )
        .expect_err("agent approval must not authorize a provider mutation");

    assert!(error.to_string().contains("host-attested human"));
    assert_eq!(host.requests.len(), 1);
}

#[test]
fn provider_effect_redaction_keeps_secret_payload_out_of_approval_and_receipt() {
    const SECRET: &str = "credential-material-must-never-cross";
    let payload = JsonObject::from([
        (
            "text".to_owned(),
            JsonValue::String("safe message".to_owned()),
        ),
        (
            "credential".to_owned(),
            JsonValue::String(SECRET.to_owned()),
        ),
    ]);
    let inputs = provider_inputs(PROVIDER_MUTATE_TOOL, payload.clone());
    let step = provider_step(PROVIDER_MUTATE_TOOL, "write", true);
    let env = provider_env();
    let effect = ProviderPermissionEffect::default();
    let admission = effect
        .admit(effect_request(&step, &inputs, &env))
        .expect("provider admission")
        .expect("owned provider effect");
    let mut host = RecordingHost::approving();
    let admission = effect
        .resolve_approval(
            EffectApprovalRequirement::Required,
            &step,
            admission,
            &mut host,
        )
        .expect("provider approval");
    let approval_json = serde_json::to_string(&host.requests).expect("approval request JSON");
    assert!(!approval_json.contains(SECRET));

    let resolved = resolved_effect(ProviderEffectClass::Mutation, &payload, Some("request-1"));
    let attempt = resolved
        .clone()
        .begin(Some(ProviderApprovalEvidence {
            actor: "human".to_owned(),
            approval_key: "approval-key".to_owned(),
            plan_digest: resolved.plan_digest().to_owned(),
        }))
        .expect("provider attempt");
    let claim = provider_claim(
        attempt.resolved().plan_digest(),
        attempt.idempotency_key(),
        Some("operation-secret-safe"),
    );
    let mut output = successful_output(&claim);
    effect
        .prepare_output(EffectOutputRequest {
            step: &step,
            admission: &admission,
            claim: &claim,
            output: &mut output,
        })
        .expect("provider finality projection");
    let receipt = runx_runtime::receipts::step_receipt_with_authority_grant_refs(
        "provider-effect-redaction",
        "mutate",
        1,
        &output,
        &claim,
        effect
            .authority_grant_refs(&admission)
            .expect("authority grant refs"),
        CREATED_AT,
    )
    .expect("provider effect receipt");

    assert!(!format!("{resolved:?}").contains(SECRET));
    assert!(
        !serde_json::to_string(&receipt)
            .expect("receipt JSON")
            .contains(SECRET)
    );
}

#[cfg(feature = "catalog")]
mod production_recovery {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use runx_parser::{parse_graph_yaml, validate_graph};
    use runx_runtime::adapters::cli_tool::CliToolAdapter;
    use runx_runtime::{
        HOSTED_API_BASE_URL_ENV, HOSTED_API_TOKEN_ENV, HttpMethod, RUNX_RECEIPT_DIR_ENV,
        RUNX_RUN_ID_ENV, Runtime, RuntimeEffectRegistry, RuntimeHttpError, RuntimeHttpRequest,
        RuntimeHttpResponse, RuntimeHttpTransport, RuntimeOptions,
    };

    use super::*;

    #[test]
    fn timeout_after_provider_acceptance_recovers_with_one_logical_mutation()
    -> Result<(), Box<dyn std::error::Error>> {
        let workspace = tempfile::tempdir().expect("workspace");
        let receipt_dir = workspace.path().join("receipts");
        let transport = TimeoutThenReadbackTransport::default();
        let effects = RuntimeEffectRegistry::with_effect(
            ProviderPermissionEffect::with_http_transport(transport.clone()),
        )
        .expect("provider registry");
        let mut options = RuntimeOptions {
            created_at: CREATED_AT.to_owned(),
            effects,
            ..RuntimeOptions::local_development(std::env::vars().collect())
        };
        options.env.extend(provider_env());
        options.env.insert(
            HOSTED_API_BASE_URL_ENV.to_owned(),
            "https://api.runx.recovery".to_owned(),
        );
        options
            .env
            .insert(HOSTED_API_TOKEN_ENV.to_owned(), "rxk_recovery".to_owned());
        options.env.insert(
            RUNX_RECEIPT_DIR_ENV.to_owned(),
            receipt_dir.to_string_lossy().into_owned(),
        );
        options.env.insert(
            RUNX_RUN_ID_ENV.to_owned(),
            "provider-timeout-recovery".to_owned(),
        );
        options.env.insert(
            "RUNX_HOME".to_owned(),
            workspace.path().join("home").to_string_lossy().into_owned(),
        );
        let runtime = Runtime::new(CliToolAdapter, options);
        let graph = validate_graph(
            parse_graph_yaml(PROVIDER_RECOVERY_GRAPH).expect("provider recovery graph YAML"),
        )
        .expect("provider recovery graph");
        let mut host = RecordingHost::approving();

        let first_error = runtime
            .run_graph_with_host(workspace.path(), graph.clone(), &mut host)
            .expect_err("first provider response must be ambiguous");
        let (plan_digest, idempotency_key) = match first_error {
            RuntimeError::ProviderEffectUnknown {
                plan_digest,
                idempotency_key,
                ..
            } => (plan_digest, idempotency_key),
            error => return Err(format!("unexpected first provider error: {error}").into()),
        };
        let pending_path = receipt_dir.join("provider-effects.json");
        let pending: JsonValue = serde_json::from_slice(
            &std::fs::read(&pending_path).expect("durable provider state after timeout"),
        )
        .expect("provider state JSON");
        assert_eq!(
            pending
                .as_object()
                .and_then(|state| state.get("entries"))
                .and_then(JsonValue::as_object)
                .and_then(|entries| entries.values().next())
                .and_then(JsonValue::as_object)
                .and_then(|entry| entry.get("phase"))
                .and_then(JsonValue::as_str),
            Some("unknown")
        );
        assert!(
            serde_json::to_string(&pending)
                .expect("state JSON")
                .contains(&idempotency_key)
        );

        let recovered = runtime
            .run_graph_with_host(workspace.path(), graph, &mut host)
            .expect("retry must recover provider finality");
        assert_eq!(transport.operation_attempts(), 2);
        assert_eq!(transport.logical_mutations(), 1);
        assert_eq!(
            transport.idempotency_keys(),
            vec![idempotency_key.clone(); 2]
        );
        let step = recovered.steps.first().expect("recovered provider step");
        let operation = step
            .contract
            .get("provider_operation")
            .and_then(JsonValue::as_object)
            .and_then(|packet| packet.get("data"))
            .and_then(JsonValue::as_object)
            .expect("provider operation packet");
        assert_eq!(
            operation.get("plan_digest").and_then(JsonValue::as_str),
            Some(plan_digest.as_str())
        );
        assert_eq!(
            operation.get("idempotency_key").and_then(JsonValue::as_str),
            Some(idempotency_key.as_str())
        );
        assert_eq!(
            operation.get("finality").and_then(JsonValue::as_str),
            Some("confirmed")
        );
        let final_state: JsonValue = serde_json::from_slice(
            &std::fs::read(&pending_path).expect("provider state after finality"),
        )
        .expect("final provider state JSON");
        assert!(
            final_state
                .as_object()
                .and_then(|state| state.get("entries"))
                .and_then(JsonValue::as_object)
                .is_some_and(JsonObject::is_empty)
        );
        assert_eq!(host.requests.len(), 2);
        Ok(())
    }

    #[derive(Clone, Default)]
    struct TimeoutThenReadbackTransport {
        state: Arc<TimeoutThenReadbackState>,
    }

    #[derive(Default)]
    struct TimeoutThenReadbackState {
        operation_attempts: AtomicU64,
        logical_mutations: AtomicU64,
        idempotency_keys: Mutex<Vec<String>>,
        accepted: Mutex<BTreeMap<String, JsonObject>>,
    }

    impl TimeoutThenReadbackTransport {
        fn operation_attempts(&self) -> u64 {
            self.state.operation_attempts.load(Ordering::Relaxed)
        }

        fn logical_mutations(&self) -> u64 {
            self.state.logical_mutations.load(Ordering::Relaxed)
        }

        fn idempotency_keys(&self) -> Vec<String> {
            self.state
                .idempotency_keys
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl RuntimeHttpTransport for TimeoutThenReadbackTransport {
        fn send(
            &self,
            request: RuntimeHttpRequest,
        ) -> Result<RuntimeHttpResponse, RuntimeHttpError> {
            if request.method == HttpMethod::Get && request.url.ends_with("/v1/me") {
                return Ok(RuntimeHttpResponse::new(
                    200,
                    r#"{"status":"success","principal":{"principal_id":"operator:test"}}"#,
                ));
            }
            if request.method != HttpMethod::Post
                || !request.url.ends_with("/v1/provider-operations")
            {
                return Err(transport_error("unexpected hosted API request"));
            }
            let request: JsonObject = serde_json::from_str(
                request
                    .body
                    .as_deref()
                    .ok_or_else(|| transport_error("provider request body is missing"))?,
            )
            .map_err(|error| transport_error(format!("invalid provider JSON: {error}")))?;
            let operation = required_string(&request, "operation")?;
            let target = required_string(&request, "target")?;
            let access = required_string(&request, "access")?;
            let input = request
                .get("input")
                .and_then(JsonValue::as_object)
                .ok_or_else(|| transport_error("provider input is missing"))?;
            let key = required_string(input, "idempotency_key")?.to_owned();
            self.state
                .idempotency_keys
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(key.clone());
            let attempt = self
                .state
                .operation_attempts
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1);
            let mut accepted = self
                .state
                .accepted
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let accepted = accepted
                .entry(key.clone())
                .or_insert_with(|| {
                    self.state.logical_mutations.fetch_add(1, Ordering::Relaxed);
                    JsonObject::from([
                        (
                            "operation_id".to_owned(),
                            JsonValue::String("provider-operation-1".to_owned()),
                        ),
                        (
                            "readback_ref".to_owned(),
                            JsonValue::String(
                                "runx:provider_readback:provider-operation-1".to_owned(),
                            ),
                        ),
                    ])
                })
                .clone();
            if attempt == 1 {
                return Err(transport_error(
                    "request deadline exceeded after provider acceptance",
                ));
            }
            Ok(RuntimeHttpResponse::new(
                200,
                serde_json::json!({
                    "status": "success",
                    "provider": PROVIDER,
                    "operation": operation,
                    "target": target,
                    "access": access,
                    "operation_id": required_string(&accepted, "operation_id")?,
                    "idempotency_key": key,
                    "readback_ref": required_string(&accepted, "readback_ref")?,
                    "result": {"message_locator": "slack://workspace/channel/message-1"}
                })
                .to_string(),
            ))
        }
    }

    fn required_string<'a>(
        object: &'a JsonObject,
        field: &str,
    ) -> Result<&'a str, RuntimeHttpError> {
        object
            .get(field)
            .and_then(JsonValue::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| transport_error(format!("provider {field} is missing")))
    }

    fn transport_error(message: impl Into<String>) -> RuntimeHttpError {
        RuntimeHttpError::Transport {
            message: message.into(),
        }
    }

    const PROVIDER_RECOVERY_GRAPH: &str = r#"
name: provider-timeout-recovery
steps:
  - id: provider-operation
    tool: provider.mutate
    scopes: [channel.post]
    mutation: true
    idempotency_key: request-1
    policy:
      provider_permission:
        verb: write
    inputs:
      expected_provider: slack
      operation: channel.post
      target: slack://workspace/channel
      idempotency_key: request-1
      result_fields: [message_locator]
      input:
        text: hello from recovery
"#;
}

#[derive(Default)]
struct RecordingHost {
    requests: Vec<ResolutionRequest>,
    actor: Option<ResolutionResponseActor>,
}

impl RecordingHost {
    fn approving() -> Self {
        Self {
            actor: Some(ResolutionResponseActor::Human),
            ..Self::default()
        }
    }

    fn agent_approving() -> Self {
        Self {
            actor: Some(ResolutionResponseActor::Agent),
            ..Self::default()
        }
    }
}

impl Host for RecordingHost {
    fn report(&mut self, _event: ExecutionEvent) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn resolve(
        &mut self,
        request: ResolutionRequest,
    ) -> Result<Option<ResolutionResponse>, RuntimeError> {
        self.requests.push(request);
        Ok(self.actor.clone().map(|actor| ResolutionResponse {
            actor,
            payload: JsonValue::Bool(true),
        }))
    }

    fn log(&mut self, _message: String) -> Result<(), RuntimeError> {
        Ok(())
    }
}

fn effect_request<'a>(
    step: &'a GraphStep,
    inputs: &'a JsonObject,
    env: &'a BTreeMap<String, String>,
) -> EffectStepRequest<'a> {
    EffectStepRequest {
        step,
        target: ResolvedEffectTarget {
            skill_name: None,
            tool_ref: step.tool.as_deref(),
        },
        inputs,
        env,
        graph_dir: Path::new("."),
    }
}

fn provider_inputs(tool: &str, payload: JsonObject) -> JsonObject {
    let mut inputs = JsonObject::from([
        (
            "expected_provider".to_owned(),
            JsonValue::String(PROVIDER.to_owned()),
        ),
        (
            "operation".to_owned(),
            JsonValue::String(OPERATION.to_owned()),
        ),
        ("target".to_owned(), JsonValue::String(TARGET.to_owned())),
        ("input".to_owned(), JsonValue::Object(payload)),
    ]);
    if tool == PROVIDER_MUTATE_TOOL {
        inputs.insert(
            "idempotency_key".to_owned(),
            JsonValue::String("request-1".to_owned()),
        );
    }
    inputs
}

fn provider_step(tool: &str, verb: &str, mutating: bool) -> GraphStep {
    GraphStep {
        id: "provider_operation".to_owned(),
        label: None,
        skill: None,
        tool: Some(tool.to_owned()),
        run: None,
        artifacts: None,
        outputs: None,
        runner: None,
        inputs: JsonObject::new(),
        context: BTreeMap::new(),
        context_edges: Vec::new(),
        context_skills: Vec::new(),
        scopes: vec![SCOPE.to_owned()],
        allowed_tools: None,
        retry: None,
        policy: Some(JsonObject::from([(
            PROVIDER_PERMISSION_EFFECT_FAMILY.to_owned(),
            JsonValue::Object(JsonObject::from([
                (
                    "grant_id".to_owned(),
                    JsonValue::String(GRANT_ID.to_owned()),
                ),
                ("verb".to_owned(), JsonValue::String(verb.to_owned())),
            ])),
        )])),
        fanout_group: None,
        when: None,
        mutating,
        idempotency_key: Some("provider-operation-step".to_owned()),
        mint_authority: None,
        requested_scope_from: None,
    }
}

fn provider_env() -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            PROVIDER_PERMISSION_GRANT_ID_ENV.to_owned(),
            GRANT_ID.to_owned(),
        ),
        (
            PROVIDER_PERMISSION_GRANTED_SCOPES_ENV.to_owned(),
            encode_provider_scopes_env(&[SCOPE.to_owned()]).expect("scope transport"),
        ),
        (
            PROVIDER_PERMISSION_PRINCIPAL_REF_ENV.to_owned(),
            PRINCIPAL_REF.to_owned(),
        ),
    ])
}

fn resolved_effect(
    class: ProviderEffectClass,
    payload: &JsonObject,
    request_key: Option<&str>,
) -> ProviderEffectResolved {
    ProviderEffectResolved::new(
        ProviderEffectIntent::new(ProviderEffectIntentInput {
            class,
            provider: PROVIDER,
            operation: OPERATION,
            target: TARGET,
            payload,
            required_scopes: vec![SCOPE.to_owned()],
            amount: None,
            request_key,
        })
        .expect("provider intent"),
        ProviderEffectAuthority::new(GRANT_ID, PRINCIPAL_REF).expect("provider authority"),
    )
    .expect("resolved provider effect")
}

fn provider_claim(
    plan_digest: &str,
    idempotency_key: &str,
    operation_id: Option<&str>,
) -> JsonObject {
    let mut operation = JsonObject::from([
        (
            "finality".to_owned(),
            JsonValue::String("confirmed".to_owned()),
        ),
        (
            "plan_digest".to_owned(),
            JsonValue::String(plan_digest.to_owned()),
        ),
        (
            "idempotency_key".to_owned(),
            JsonValue::String(idempotency_key.to_owned()),
        ),
        (
            "readback_ref".to_owned(),
            JsonValue::String(format!(
                "runx:provider_readback:{}",
                operation_id.unwrap_or("read")
            )),
        ),
    ]);
    if let Some(operation_id) = operation_id {
        operation.insert(
            "operation_id".to_owned(),
            JsonValue::String(operation_id.to_owned()),
        );
    }
    JsonObject::from([(
        "provider_operation".to_owned(),
        JsonValue::Object(operation),
    )])
}

fn successful_output(claim: &JsonObject) -> InvocationOutput {
    InvocationOutput::runtime_success(JsonValue::Object(claim.clone()), 1, JsonObject::new())
}

fn metadata_verification_refs(output: &InvocationOutput) -> Vec<runx_contracts::Reference> {
    output
        .metadata
        .get(runx_runtime::effects::EFFECT_VERIFICATION_REFS_METADATA)
        .and_then(JsonValue::as_object)
        .and_then(|packet| packet.get("refs"))
        .and_then(JsonValue::as_array)
        .expect("effect verification refs")
        .iter()
        .cloned()
        .map(|value| {
            serde_json::from_value(serde_json::to_value(value).expect("reference value"))
                .expect("reference")
        })
        .collect()
}

fn verification_refs(receipt: &runx_contracts::Receipt) -> Vec<&runx_contracts::Reference> {
    receipt
        .acts
        .iter()
        .flat_map(|act| &act.criterion_bindings)
        .flat_map(|binding| &binding.verification_refs)
        .filter(|reference| reference.reference_type == ReferenceType::Verification)
        .collect()
}
