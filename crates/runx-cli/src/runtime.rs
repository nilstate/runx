// Module rationale: CLI runtime wiring binds payment
// finality supervisor selection, external adapter translation, and receipt
// metadata persistence at one audited command boundary.
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use runx_contracts::{
    ExternalAdapterInvocation, ExternalAdapterInvocationSchema, ExternalAdapterManifest,
    ExternalAdapterProtocolVersion, JsonObject, JsonValue, Reference, ReferenceType,
};
use runx_pay::{
    DeterministicPaymentFinalitySupervisor, PaymentFinalitySupervisor,
    PaymentFinalitySupervisorError, PaymentFinalitySupervisorEvidence,
    PaymentFinalitySupervisorRequest, PaymentRuntimeEffect,
    ledger::{X402_PAY_PAYMENT_PROFILE, persist_x402_payment_ledger_projection_event},
    supervisor::{
        payment_finality_supervisor_evidence_payload, payment_supervisor_evidence_from_payload,
    },
};
use runx_runtime::{
    CredentialDelivery, HarnessReplayOutput, LocalOrchestrator, ProviderPermissionEffect,
    RUNX_RECEIPT_DIR_ENV, RuntimeEffectRegistry,
    adapters::external_adapter::{
        ExternalAdapterProcessOutcome, ExternalAdapterProcessSupervisor, ExternalAdapterSupervisor,
    },
};

pub const RUNX_PAYMENT_FINALITY_SUPERVISOR_MANIFEST_ENV: &str =
    "RUNX_PAYMENT_FINALITY_SUPERVISOR_MANIFEST";
const PAYMENT_FINALITY_SUPERVISOR_SKILL_REF: &str = "runx/payment-finality-supervisor";

pub fn local_orchestrator(
    env: &BTreeMap<String, String>,
) -> Result<LocalOrchestrator, runx_runtime::RuntimeEffectError> {
    payment_effect_registry(env)
        .map(|effects| LocalOrchestrator::with_effects_and_environment(effects, env.clone()))
}

pub fn payment_effect_registry(
    env: &BTreeMap<String, String>,
) -> Result<RuntimeEffectRegistry, runx_runtime::RuntimeEffectError> {
    let mut registry = RuntimeEffectRegistry::with_effect(PaymentRuntimeEffect::new(
        ConfiguredPaymentFinalitySupervisor::from_env(env),
    ))?;
    registry.register_effect(ProviderPermissionEffect::default())?;
    Ok(registry)
}

pub fn persist_payment_ledger_projection(
    output: &HarnessReplayOutput,
    env: &BTreeMap<String, String>,
) -> Result<(), String> {
    if metadata_string(output, "payment_ledger_profile") != Some(X402_PAY_PAYMENT_PROFILE) {
        return Ok(());
    }
    let Some(receipt_dir) = env.get(RUNX_RECEIPT_DIR_ENV).map(PathBuf::from) else {
        return Ok(());
    };
    let scenario_id = metadata_string(output, "payment_ledger_scenario_id")
        .ok_or_else(|| "metadata.payment_ledger_scenario_id is required".to_owned())?;
    persist_x402_payment_ledger_projection_event(
        receipt_dir,
        &format!("gx_{}", output.fixture.name),
        output.receipt.created_at.as_str(),
        &output.receipt,
        &output.steps,
        scenario_id,
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn metadata_string<'a>(output: &'a HarnessReplayOutput, key: &str) -> Option<&'a str> {
    output
        .fixture
        .metadata
        .get(key)
        .and_then(|value| match value {
            JsonValue::String(value) => Some(value.as_str()),
            _ => None,
        })
}

enum ConfiguredPaymentFinalitySupervisor {
    Deterministic(DeterministicPaymentFinalitySupervisor),
    External(Box<ExternalAdapterPaymentFinalitySupervisor>),
    Unavailable(String),
}

impl ConfiguredPaymentFinalitySupervisor {
    fn from_env(env: &BTreeMap<String, String>) -> Self {
        let Some(path) = env.get(RUNX_PAYMENT_FINALITY_SUPERVISOR_MANIFEST_ENV) else {
            return Self::Deterministic(DeterministicPaymentFinalitySupervisor);
        };
        let path = PathBuf::from(path);
        match ExternalAdapterPaymentFinalitySupervisor::from_manifest_path(
            path.clone(),
            env.clone(),
        ) {
            Ok(supervisor) => Self::External(Box::new(supervisor)),
            Err(message) => Self::Unavailable(format!(
                "{}={} is invalid: {message}",
                RUNX_PAYMENT_FINALITY_SUPERVISOR_MANIFEST_ENV,
                path.display()
            )),
        }
    }
}

impl PaymentFinalitySupervisor for ConfiguredPaymentFinalitySupervisor {
    fn supervise(
        &self,
        request: PaymentFinalitySupervisorRequest<'_>,
    ) -> Result<PaymentFinalitySupervisorEvidence, PaymentFinalitySupervisorError> {
        match self {
            Self::Deterministic(supervisor) => supervisor.supervise(request),
            Self::External(supervisor) => supervisor.supervise(request),
            Self::Unavailable(message) => Err(PaymentFinalitySupervisorError::InvalidEvidence {
                message: message.clone(),
            }),
        }
    }
}

struct ExternalAdapterPaymentFinalitySupervisor<S = ExternalAdapterProcessSupervisor> {
    manifest: ExternalAdapterManifest,
    supervisor: S,
    environment: BTreeMap<String, String>,
}

impl ExternalAdapterPaymentFinalitySupervisor {
    fn from_manifest_path(
        path: PathBuf,
        environment: BTreeMap<String, String>,
    ) -> Result<Self, String> {
        let raw = fs::read_to_string(&path)
            .map_err(|source| format!("could not read manifest: {source}"))?;
        let manifest: ExternalAdapterManifest = serde_json::from_str(&raw)
            .map_err(|source| format!("manifest JSON is invalid: {source}"))?;
        Ok(Self::new(
            manifest,
            ExternalAdapterProcessSupervisor,
            environment,
        ))
    }
}

impl<S> ExternalAdapterPaymentFinalitySupervisor<S> {
    fn new(
        manifest: ExternalAdapterManifest,
        supervisor: S,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            manifest,
            supervisor,
            environment,
        }
    }
}

impl<S> PaymentFinalitySupervisor for ExternalAdapterPaymentFinalitySupervisor<S>
where
    S: ExternalAdapterSupervisor + Send + Sync,
{
    fn supervise(
        &self,
        request: PaymentFinalitySupervisorRequest<'_>,
    ) -> Result<PaymentFinalitySupervisorEvidence, PaymentFinalitySupervisorError> {
        let invocation = payment_finality_invocation(&self.manifest, &request, &self.environment)?;
        let outcome = self
            .supervisor
            .invoke_external_adapter(
                &self.manifest,
                &invocation,
                &self.environment,
                &CredentialDelivery::none(),
            )
            .map_err(|source| PaymentFinalitySupervisorError::InvalidEvidence {
                message: format!("external adapter payment finality supervisor failed: {source}"),
            })?;
        let payload = payment_finality_payload_from_outcome(outcome)?;
        let evidence = payment_supervisor_evidence_from_payload(&payload).map_err(|source| {
            PaymentFinalitySupervisorError::InvalidEvidence {
                message: source.to_string(),
            }
        })?;
        Ok(PaymentFinalitySupervisorEvidence::new(
            request.family,
            payment_finality_supervisor_evidence_payload(&evidence),
        ))
    }
}

fn payment_finality_invocation(
    manifest: &ExternalAdapterManifest,
    request: &PaymentFinalitySupervisorRequest<'_>,
    env: &BTreeMap<String, String>,
) -> Result<ExternalAdapterInvocation, PaymentFinalitySupervisorError> {
    let proof_ref = required_payload_string(&request.payload, "proof_ref")?;
    let invocation_id = format!("payment_finality.{}.invoke", identifier_segment(proof_ref));
    let run_id = format!("payment_finality.{}", identifier_segment(proof_ref));
    let mut inputs = request.payload.clone();
    inputs.insert(
        "effect_family".to_owned(),
        JsonValue::String(request.family.to_owned()),
    );
    Ok(ExternalAdapterInvocation {
        schema: ExternalAdapterInvocationSchema::V1,
        protocol_version: ExternalAdapterProtocolVersion::V1,
        invocation_id: invocation_id.into(),
        adapter_id: manifest.adapter_id.clone(),
        run_id: run_id.clone().into(),
        step_id: "payment_finality".into(),
        source_type: "external-adapter".into(),
        skill_ref: PAYMENT_FINALITY_SUPERVISOR_SKILL_REF.into(),
        harness_ref: Reference::with_uri(ReferenceType::Harness, format!("runx:harness:{run_id}")),
        host_ref: Reference::with_uri(ReferenceType::Host, "runx:host:cli"),
        inputs,
        resolved_inputs: None,
        cwd: env
            .get(runx_runtime::RUNX_CWD_ENV)
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .map(Into::into),
        receipt_dir: env.get(RUNX_RECEIPT_DIR_ENV).cloned().map(Into::into),
        env: None,
        credential_refs: None,
        metadata: None,
    })
}

fn payment_finality_payload_from_outcome(
    outcome: ExternalAdapterProcessOutcome,
) -> Result<JsonObject, PaymentFinalitySupervisorError> {
    let Some(output) = outcome.response.output else {
        return Err(PaymentFinalitySupervisorError::InvalidEvidence {
            message: "external adapter payment finality supervisor returned no output".to_owned(),
        });
    };
    match output.get("payment_finality_evidence") {
        Some(JsonValue::Object(payload)) => Ok(payload.clone()),
        Some(_) => Err(PaymentFinalitySupervisorError::InvalidEvidence {
            message: "external adapter payment_finality_evidence must be an object".to_owned(),
        }),
        None => Ok(output),
    }
}

fn required_payload_string<'a>(
    payload: &'a JsonObject,
    field: &'static str,
) -> Result<&'a str, PaymentFinalitySupervisorError> {
    match payload.get(field) {
        Some(JsonValue::String(value)) if !value.is_empty() => Ok(value),
        Some(_) => Err(PaymentFinalitySupervisorError::InvalidEvidence {
            message: format!("payment finality request field {field} must be a non-empty string"),
        }),
        None => Err(PaymentFinalitySupervisorError::InvalidEvidence {
            message: format!("payment finality request field {field} is missing"),
        }),
    }
}

fn identifier_segment(value: &str) -> String {
    let segment: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if segment.is_empty() {
        "unknown".to_owned()
    } else {
        segment
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use runx_contracts::{
        EXTERNAL_ADAPTER_PROTOCOL_VERSION, ExternalAdapterResponse, ExternalAdapterStatus,
        ExternalAdapterTimeouts, ExternalAdapterTransport, ExternalAdapterTransportKind,
        JsonNumber,
    };
    use runx_pay::PAYMENT_EFFECT_FAMILY;

    use super::*;

    #[test]
    fn external_adapter_payment_finality_supervisor_round_trips_evidence() -> Result<(), String> {
        let supervisor = RecordingSupervisor::with_payload(nested_evidence_output());
        let adapter = ExternalAdapterPaymentFinalitySupervisor::new(
            test_manifest(),
            supervisor,
            BTreeMap::new(),
        );
        let result = adapter
            .supervise(test_request())
            .map_err(|error| error.to_string())?;

        assert_eq!(result.family, PAYMENT_EFFECT_FAMILY);
        assert_eq!(
            result.payload.get("proof_ref"),
            Some(&JsonValue::String("proof_x402_1".to_owned()))
        );
        let invocation = adapter
            .supervisor
            .last_invocation
            .lock()
            .map_err(|_| "recording supervisor lock poisoned".to_owned())?
            .clone()
            .ok_or_else(|| "invocation captured".to_owned())?;
        assert_eq!(invocation.source_type.as_str(), "external-adapter");
        assert_eq!(
            invocation.inputs.get("effect_family"),
            Some(&JsonValue::String(PAYMENT_EFFECT_FAMILY.to_owned()))
        );
        Ok(())
    }

    #[test]
    fn external_adapter_payment_finality_supervisor_accepts_direct_evidence_output()
    -> Result<(), String> {
        let supervisor = RecordingSupervisor::with_payload(evidence_payload());
        let adapter = ExternalAdapterPaymentFinalitySupervisor::new(
            test_manifest(),
            supervisor,
            BTreeMap::new(),
        );
        let result = adapter
            .supervise(test_request())
            .map_err(|error| error.to_string())?;

        assert_eq!(
            result.payload.get("provider_event_ref"),
            Some(&JsonValue::String("0xfeed".to_owned()))
        );
        Ok(())
    }

    #[test]
    fn external_adapter_payment_finality_supervisor_rejects_missing_output() {
        let supervisor = RecordingSupervisor::without_output();
        let adapter = ExternalAdapterPaymentFinalitySupervisor::new(
            test_manifest(),
            supervisor,
            BTreeMap::new(),
        );
        let result = adapter.supervise(test_request());

        assert!(matches!(
            result,
            Err(PaymentFinalitySupervisorError::InvalidEvidence { .. })
        ));
    }

    struct RecordingSupervisor {
        output: Option<JsonObject>,
        last_invocation: Mutex<Option<ExternalAdapterInvocation>>,
    }

    impl RecordingSupervisor {
        fn with_payload(output: JsonObject) -> Self {
            Self {
                output: Some(output),
                last_invocation: Mutex::new(None),
            }
        }

        fn without_output() -> Self {
            Self {
                output: None,
                last_invocation: Mutex::new(None),
            }
        }
    }

    impl ExternalAdapterSupervisor for RecordingSupervisor {
        fn invoke_external_adapter(
            &self,
            manifest: &ExternalAdapterManifest,
            invocation: &ExternalAdapterInvocation,
            _runtime_environment: &BTreeMap<String, String>,
            _credential_delivery: &CredentialDelivery,
        ) -> Result<
            ExternalAdapterProcessOutcome,
            runx_runtime::adapters::external_adapter::ExternalAdapterSupervisorError,
        > {
            *self.last_invocation.lock().map_err(|_| {
                runx_runtime::adapters::external_adapter::ExternalAdapterSupervisorError::Io {
                    context: "recording external adapter invocation".to_owned(),
                    source: std::io::Error::other("recording supervisor lock poisoned"),
                }
            })? = Some(invocation.clone());
            Ok(ExternalAdapterProcessOutcome {
                response: ExternalAdapterResponse {
                    schema: "runx.external_adapter.response.v1".to_owned(),
                    protocol_version: EXTERNAL_ADAPTER_PROTOCOL_VERSION.to_owned(),
                    invocation_id: invocation.invocation_id.to_string(),
                    adapter_id: manifest.adapter_id.to_string(),
                    status: ExternalAdapterStatus::Completed,
                    stdout: None,
                    stderr: None,
                    exit_code: Some(Some(0)),
                    output: self.output.clone(),
                    artifacts: None,
                    errors: None,
                    telemetry: None,
                    metadata: None,
                    observed_at: "2026-06-11T00:00:00Z".to_owned(),
                },
                process_exit_code: Some(0),
                duration_ms: 1,
            })
        }
    }

    fn test_manifest() -> ExternalAdapterManifest {
        ExternalAdapterManifest {
            schema: runx_contracts::ExternalAdapterManifestSchema::V1,
            protocol_version: ExternalAdapterProtocolVersion::V1,
            adapter_id: "x402-finality-test".into(),
            name: "x402 finality test".into(),
            version: "0.1.0".into(),
            supported_source_types: vec!["external-adapter".into()],
            transport: ExternalAdapterTransport {
                kind: ExternalAdapterTransportKind::Process,
                command: Some("node".into()),
                args: Some(vec!["scripts/x402-testnet-settle.mjs".to_owned()]),
                endpoint: None,
            },
            timeouts: ExternalAdapterTimeouts {
                startup_ms: 1_000,
                invocation_ms: 30_000,
            },
            credential_needs: None,
            metadata: None,
        }
    }

    fn test_request() -> PaymentFinalitySupervisorRequest<'static> {
        PaymentFinalitySupervisorRequest {
            family: PAYMENT_EFFECT_FAMILY,
            payload: supervisor_payload(),
        }
    }

    fn supervisor_payload() -> JsonObject {
        let mut payload = JsonObject::new();
        payload.insert(
            "skill_settlement_status".to_owned(),
            JsonValue::String("fulfilled".to_owned()),
        );
        payload.insert(
            "proof_ref".to_owned(),
            JsonValue::String("proof_x402_1".to_owned()),
        );
        payload.insert("rail".to_owned(), JsonValue::String("x402".to_owned()));
        payload.insert(
            "counterparty".to_owned(),
            JsonValue::String("merchant:demo".to_owned()),
        );
        payload.insert(
            "amount_minor".to_owned(),
            JsonValue::Number(JsonNumber::U64(125)),
        );
        payload.insert("currency".to_owned(), JsonValue::String("USD".to_owned()));
        payload.insert(
            "idempotency_key".to_owned(),
            JsonValue::String("idem_1".to_owned()),
        );
        payload
    }

    fn nested_evidence_output() -> JsonObject {
        let mut output = JsonObject::new();
        output.insert(
            "payment_finality_evidence".to_owned(),
            JsonValue::Object(evidence_payload()),
        );
        output
    }

    fn evidence_payload() -> JsonObject {
        let mut payload = JsonObject::new();
        payload.insert(
            "verifier_id".to_owned(),
            JsonValue::String(runx_pay::supervisor::PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned()),
        );
        payload.insert(
            "proof_ref".to_owned(),
            JsonValue::String("proof_x402_1".to_owned()),
        );
        payload.insert("rail".to_owned(), JsonValue::String("x402".to_owned()));
        payload.insert(
            "counterparty".to_owned(),
            JsonValue::String("merchant:demo".to_owned()),
        );
        payload.insert(
            "amount_minor".to_owned(),
            JsonValue::Number(JsonNumber::U64(125)),
        );
        payload.insert("currency".to_owned(), JsonValue::String("USD".to_owned()));
        payload.insert(
            "idempotency_key".to_owned(),
            JsonValue::String("idem_1".to_owned()),
        );
        payload.insert(
            "settlement_status".to_owned(),
            JsonValue::String("fulfilled".to_owned()),
        );
        payload.insert(
            "provider_event_ref".to_owned(),
            JsonValue::String("0xfeed".to_owned()),
        );
        payload
    }
}
