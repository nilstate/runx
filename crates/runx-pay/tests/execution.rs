use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use runx_contracts::{
    AuthorityVerb, ExecutionEvent, JsonNumber, JsonObject, JsonValue, ProofKind, ReferenceType,
    ResolutionRequest, ResolutionResponse, ResolutionResponseActor,
};
use runx_core::state_machine::GraphStatus;
use runx_pay::PAYMENT_EFFECT_FAMILY;
use runx_pay::effect_state::{
    EffectMutationStatus, EffectRecoveryState, EffectStateStore, FileBackedEffectStateStore,
    RUNX_EFFECT_STATE_PATH_ENV,
};
use runx_pay::supervisor::{
    PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID, PaymentSupervisorSettlementEvidence,
    payment_finality_supervisor_evidence_payload,
};
use runx_pay::{
    PaymentFinalitySupervisor, PaymentFinalitySupervisorError, PaymentFinalitySupervisorEvidence,
    PaymentFinalitySupervisorRequest, PaymentRuntimeEffect,
};
use runx_receipts::ReceiptTreeConfig;
use runx_runtime::effects::RuntimeEffectRegistry;
use runx_runtime::{
    Host, InvocationStatus, RUNX_RUN_ID_ENV, Runtime, RuntimeError, RuntimeOptions, SkillAdapter,
    SkillInvocation, SkillOutput, validate_runtime_receipt_tree,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const PAID_ECHO_IDEMPOTENCY_KEY: &str = "payment:paid-echo-001";
const PAID_ECHO_RAIL_SESSION_MATERIAL_REF: &str = "rail-session-material:mock:paid-echo-001";
const X402_APPROVAL_IDEMPOTENCY_KEY: &str = "payment:x402-pay-approval-001";
const X402_APPROVAL_PROOF_REF: &str = "receipt-proof:mock:x402-pay-approval-001";

#[test]
fn approved_payment_approval_emits_approval_output_and_runs_fulfill()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::new()?;
    let runtime = Runtime::new(
        RecordingAdapter::default(),
        runtime_options_with_effects(vec![x402_approval_supervisor_evidence()]),
    );
    let mut host = ApprovalHost::approved(true);

    let run = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host)?;

    assert_eq!(run.state.status, GraphStatus::Succeeded);
    assert_eq!(step_ids(&run.steps), vec!["approve-spend", "fulfill"]);
    let approval_step = step_run(&run.steps, "approve-spend")?;
    assert_eq!(
        approval_value(approval_step, "approved")?,
        JsonValue::Bool(true)
    );
    assert_eq!(
        approval_value(approval_step, "gate_id")?,
        JsonValue::String("spend-approval".to_owned())
    );
    assert!(
        approval_step
            .outputs
            .get("payment_approval")
            .is_some_and(|value| matches!(value, JsonValue::Object(_)))
    );
    assert_eq!(host.requests.borrow().len(), 1);
    Ok(())
}

#[test]
fn payment_admission_identity_reaches_supervisor_request() -> Result<(), Box<dyn std::error::Error>>
{
    let fixture = GraphFixture::with_fulfill_options(
        FulfillAdmission::ValidWithPaymentAdmission,
        FulfillScope::PaymentSpend,
    )?;
    let runtime = Runtime::new(
        RecordingAdapter::default(),
        runtime_options_with_effects(vec![x402_approval_supervisor_evidence_with_identity()]),
    );
    let mut host = ApprovalHost::approved(true);

    let run = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host)?;

    assert_eq!(run.state.status, GraphStatus::Succeeded);
    Ok(())
}

#[test]
fn denied_payment_approval_emits_denied_output_and_blocks_fulfill()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::new()?;
    let runtime = Runtime::new(
        RecordingAdapter::default(),
        runtime_options_with_effects(Vec::new()),
    );
    let mut host = ApprovalHost::approved(false);

    let checkpoint =
        runtime.run_graph_file_until_steps_with_host(fixture.graph_path(), 1, &mut host)?;

    assert_eq!(step_ids(&checkpoint.steps), vec!["approve-spend"]);
    let approval_step = step_run(&checkpoint.steps, "approve-spend")?;
    assert_eq!(
        approval_value(approval_step, "approved")?,
        JsonValue::Bool(false)
    );

    let result = runtime.resume_graph_file_with_host(fixture.graph_path(), checkpoint, &mut host);
    match result {
        Err(RuntimeError::GraphBlocked { step_id, reason }) => {
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("approve-spend.payment_approval.data.approved"),
                "blocked reason should name the failed transition gate"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "expected fulfill to be blocked, ran steps {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }
    Ok(())
}

#[test]
fn payment_approval_step_is_recorded_with_receipt() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::new()?;
    let runtime = Runtime::new(
        RecordingAdapter::default(),
        runtime_options_with_effects(vec![x402_approval_supervisor_evidence()]),
    );
    let mut host = ApprovalHost::approved(true);

    let run = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host)?;

    let approval_step = step_run(&run.steps, "approve-spend")?;
    assert_eq!(approval_step.attempt, 1);
    assert_eq!(
        approval_step.receipt.subject.reference.uri,
        "hrn_x402-pay-approval_approve-spend"
    );
    assert_eq!(
        run.state
            .steps
            .iter()
            .find(|step| step.step_id == "approve-spend")
            .and_then(|step| step.receipt_id.as_deref()),
        Some(approval_step.receipt.id.as_str())
    );
    Ok(())
}

#[test]
fn payment_graph_seals_with_strict_parent_child_receipt_proof()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::new()?;
    let runtime = Runtime::new(
        RecordingAdapter::default(),
        runtime_options_with_effects(vec![x402_approval_supervisor_evidence()]),
    );
    let mut host = ApprovalHost::approved(true);

    let run = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host)?;
    let child_receipts = run
        .steps
        .iter()
        .map(|step| step.receipt.clone())
        .collect::<Vec<_>>();

    assert!(
        validate_runtime_receipt_tree(&run.receipt, child_receipts, ReceiptTreeConfig::default())
            .is_ok(),
        "payment graph receipt must validate through strict runtime proof acceptance"
    );
    let fulfill = step_run(&run.steps, "fulfill")?;
    assert!(
        fulfill
            .receipt
            .authority
            .grant_refs
            .iter()
            .any(|reference| reference.reference_type == ReferenceType::Grant),
        "payment receipt authority must cite the admitted payment authority ref"
    );
    assert!(
        fulfill
            .receipt
            .authority
            .grant_refs
            .iter()
            .any(|reference| reference.reference_type == ReferenceType::Credential),
        "payment receipt authority must cite the admitted spend capability ref"
    );
    assert!(
        fulfill.receipt.acts[0]
            .criterion_bindings
            .iter()
            .flat_map(|criterion| criterion.verification_refs.iter())
            .any(|reference| reference.uri == X402_APPROVAL_PROOF_REF
                && reference.proof_kind.as_ref() == Some(&ProofKind::EffectEvidence)),
        "payment fulfillment act must carry the rail proof reference into the sealed receipt"
    );
    Ok(())
}

#[test]
fn payment_spend_success_without_runtime_supervisor_is_denied_before_graph_success()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::new()?;
    let runtime = Runtime::new(
        RecordingAdapter::default(),
        runtime_options_with_effects(Vec::new()),
    );
    let mut host = ApprovalHost::approved(true);

    let result = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host);

    match result {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("supervisor-verified rail proof")
                    || reason.contains("no supervisor settlement"),
                "payment authority denial should name the missing supervisor evidence, got: {reason}"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "payment spend must not succeed from skill proof alone, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }
    Ok(())
}

#[test]
fn payment_spend_success_without_rail_proof_is_denied_before_graph_success()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::new()?;
    let runtime = Runtime::new(
        RecordingAdapter::without_rail_proof(),
        runtime_options_with_effects(Vec::new()),
    );
    let mut host = ApprovalHost::approved(true);

    let result = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host);

    match result {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("rail proof"),
                "payment authority denial should identify the missing rail proof"
            );
        }
        Ok(run) => {
            assert_ne!(run.state.status, GraphStatus::Succeeded);
            return Err(std::io::Error::other(
                "payment spend step without rail proof must not succeed the graph",
            )
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }
    assert!(
        !host
            .events
            .borrow()
            .iter()
            .any(|event| matches!(event, ExecutionEvent::Completed { .. })),
        "graph completion must not be reported after missing rail proof"
    );
    Ok(())
}

#[test]
fn payment_spend_authority_is_detected_from_reserved_authority_not_scope_string()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::with_fulfill_options(FulfillAdmission::Valid, FulfillScope::None)?;
    let runtime = Runtime::new(
        RecordingAdapter::without_rail_proof(),
        runtime_options_with_effects(Vec::new()),
    );
    let mut host = ApprovalHost::approved(true);

    let result = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host);

    match result {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("rail proof"),
                "authority denial should still happen without a payment:spend scope string"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "payment authority in inputs must be enforced even without scope string, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }
    Ok(())
}

#[test]
fn payment_spend_missing_reserved_payment_authority_blocks_before_adapter_invocation()
-> Result<(), Box<dyn std::error::Error>> {
    assert_payment_admission_denied_before_adapter(
        FulfillAdmission::MissingReservedPaymentAuthority,
        "reserved_payment_authority",
    )
}

#[test]
fn payment_spend_missing_spend_capability_ref_blocks_before_adapter_invocation()
-> Result<(), Box<dyn std::error::Error>> {
    assert_payment_admission_denied_before_adapter(
        FulfillAdmission::MissingSpendCapabilityRef,
        "spend_capability_ref",
    )
}

#[test]
fn payment_spend_missing_idempotency_key_blocks_before_adapter_invocation()
-> Result<(), Box<dyn std::error::Error>> {
    assert_payment_admission_denied_before_adapter(
        FulfillAdmission::MissingIdempotencyKey,
        "idempotency.key",
    )
}

#[test]
fn payment_spend_missing_subset_proof_blocks_before_adapter_invocation()
-> Result<(), Box<dyn std::error::Error>> {
    assert_payment_admission_denied_before_adapter(
        FulfillAdmission::MissingSubsetProof,
        "subset proof",
    )
}

#[test]
fn payment_spend_amount_widening_blocks_before_adapter_invocation()
-> Result<(), Box<dyn std::error::Error>> {
    assert_payment_admission_denied_before_adapter(FulfillAdmission::AmountWidening, "not a subset")
}

#[test]
fn non_payment_step_without_rail_admission_inputs_invokes_adapter()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture =
        GraphFixture::with_fulfill_options(FulfillAdmission::MissingAll, FulfillScope::None)?;
    let adapter = RecordingAdapter::default();
    let invocations = adapter.invocations();
    let runtime = Runtime::new(adapter, runtime_options_with_effects(Vec::new()));
    let mut host = ApprovalHost::approved(true);

    let run = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host)?;

    assert_eq!(run.state.status, GraphStatus::Succeeded);
    assert_eq!(
        invocations.borrow().as_slice(),
        &["pay-fulfill-rail".to_owned()],
        "non-payment steps should not require payment rail admission inputs"
    );
    Ok(())
}

#[test]
fn x402_paid_echo_returns_echo_only_after_sealed_payment_proof()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = PaidEchoFixture::new()?;
    let adapter = PaidEchoAdapter::new(PaidEchoRailProof::Present);
    let invocations = adapter.invocations();
    let runtime = Runtime::new(
        adapter,
        runtime_options_with_effects(vec![paid_echo_supervisor_evidence(
            PAID_ECHO_IDEMPOTENCY_KEY,
        )]),
    );
    let mut host = ApprovalHost::approved(true);

    let run = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host)?;

    assert_eq!(run.state.status, GraphStatus::Succeeded);
    assert_eq!(
        invocations
            .borrow()
            .iter()
            .map(|invocation| invocation.skill_name.as_str())
            .collect::<Vec<_>>(),
        vec!["pay-quote", "pay-reserve", "pay-fulfill-rail", "paid-echo"],
        "paid echo must run after quote, reserve, and rail fulfillment"
    );

    let fulfill = step_run(&run.steps, "fulfill")?;
    assert!(
        fulfill.receipt.acts[0]
            .criterion_bindings
            .iter()
            .flat_map(|criterion| criterion.verification_refs.iter())
            .any(
                |reference| reference.uri == "receipt-proof:mock:paid-echo-001"
                    && reference.proof_kind.as_ref() == Some(&ProofKind::EffectEvidence)
            ),
        "rail fulfillment must seal a typed payment rail proof before echo"
    );

    let echo = step_run(&run.steps, "echo")?;
    let skill_claim = object_field(&echo.outputs, "skill_claim")?;
    let paid_echo_result = object_field(skill_claim, "paid_echo_result")?;
    assert_eq!(
        paid_echo_result.get("message"),
        Some(&JsonValue::String("hello from paid echo".to_owned()))
    );
    assert_eq!(
        paid_echo_result.get("payment_proof_ref"),
        Some(&JsonValue::String(
            "receipt-proof:mock:paid-echo-001".to_owned()
        ))
    );

    let echo_invocation = invocations
        .borrow()
        .iter()
        .find(|invocation| invocation.skill_name == "paid-echo")
        .cloned()
        .ok_or_else(|| std::io::Error::other("missing paid echo invocation"))?;
    assert_eq!(
        echo_invocation.inputs.get("payment_credential_ref"),
        Some(&JsonValue::String(
            "credential:mock:paid-echo-001".to_owned()
        ))
    );
    assert_eq!(
        echo_invocation.inputs.get("payment_proof_ref"),
        Some(&JsonValue::String(
            "receipt-proof:mock:paid-echo-001".to_owned()
        ))
    );

    let echo_text = serde_json::to_string(&echo.outputs)?;
    assert!(!echo_text.contains("credential_envelope"));
    assert!(!echo_text.contains("rail_session_material_ref"));
    assert!(!echo_text.contains(PAID_ECHO_RAIL_SESSION_MATERIAL_REF));

    let graph_receipt_text = serde_json::to_string(&run.receipt)?;
    assert!(!graph_receipt_text.contains("credential_envelope"));
    assert!(!graph_receipt_text.contains("rail_session_material_ref"));
    assert!(!graph_receipt_text.contains(PAID_ECHO_RAIL_SESSION_MATERIAL_REF));
    Ok(())
}

#[test]
fn x402_paid_echo_replays_sealed_idempotency_without_second_rail()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = PaidEchoFixture::new()?;
    let state_dir = tempfile::tempdir()?;
    let effect_state_path = state_dir.path().join("effect-state.json");
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        effect_state_path.to_string_lossy().into_owned(),
    );
    env.insert(
        RUNX_RUN_ID_ENV.to_owned(),
        "run:test-payment-replay".to_owned(),
    );
    let adapter = PaidEchoAdapter::new(PaidEchoRailProof::Present);
    let invocations = adapter.invocations();
    let runtime = Runtime::new(
        adapter,
        RuntimeOptions {
            env,
            effects: runtime_effects(vec![paid_echo_supervisor_evidence(
                PAID_ECHO_IDEMPOTENCY_KEY,
            )]),
            ..RuntimeOptions::local_development()
        },
    );

    let mut first_host = ApprovalHost::approved(true);
    let first = runtime.run_graph_file_with_host(fixture.graph_path(), &mut first_host)?;
    assert_eq!(first.state.status, GraphStatus::Succeeded);

    let mut second_host = ApprovalHost::approved(true);
    let second = runtime.run_graph_file_with_host(fixture.graph_path(), &mut second_host)?;
    assert_eq!(second.state.status, GraphStatus::Succeeded);
    assert_eq!(
        step_run(&second.steps, "fulfill")?.receipt.id,
        step_run(&first.steps, "fulfill")?.receipt.id,
        "idempotency replay must return the first sealed step receipt id"
    );
    assert_eq!(
        step_run(&second.steps, "fulfill")?.receipt.digest,
        step_run(&first.steps, "fulfill")?.receipt.digest,
        "idempotency replay must rebuild the first sealed step receipt digest"
    );
    assert_eq!(
        object_field(
            object_field(&step_run(&second.steps, "echo")?.outputs, "skill_claim")?,
            "paid_echo_result"
        )?
        .get("payment_proof_ref"),
        Some(&JsonValue::String(
            "receipt-proof:mock:paid-echo-001".to_owned()
        ))
    );

    let fulfill_count = invocations
        .borrow()
        .iter()
        .filter(|invocation| invocation.skill_name == "pay-fulfill-rail")
        .count();
    assert_eq!(
        fulfill_count, 1,
        "sealed idempotency replay must not execute a second rail call"
    );
    let echo_count = invocations
        .borrow()
        .iter()
        .filter(|invocation| invocation.skill_name == "paid-echo")
        .count();
    assert_eq!(
        echo_count, 2,
        "replay must still forward the scoped credential/proof to the paid tool"
    );
    let state_text = std::fs::read_to_string(&effect_state_path)?;
    assert!(
        !state_text.contains(PAID_ECHO_RAIL_SESSION_MATERIAL_REF),
        "effect replay state must not persist rail session material"
    );
    Ok(())
}

#[test]
fn x402_paid_echo_replay_with_mismatched_amount_denies_before_second_rail()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = PaidEchoFixture::new()?;
    let state_dir = tempfile::tempdir()?;
    let effect_state_path = state_dir.path().join("effect-state.json");
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        effect_state_path.to_string_lossy().into_owned(),
    );
    env.insert(
        RUNX_RUN_ID_ENV.to_owned(),
        "run:test-payment-replay".to_owned(),
    );
    let adapter = PaidEchoAdapter::with_idempotency_keys_and_amounts(
        PaidEchoRailProof::Present,
        [PAID_ECHO_IDEMPOTENCY_KEY, PAID_ECHO_IDEMPOTENCY_KEY],
        [125, 250],
    );
    let invocations = adapter.invocations();
    let runtime = Runtime::new(
        adapter,
        RuntimeOptions {
            env,
            effects: runtime_effects(vec![paid_echo_supervisor_evidence(
                PAID_ECHO_IDEMPOTENCY_KEY,
            )]),
            ..RuntimeOptions::local_development()
        },
    );

    let mut first_host = ApprovalHost::approved(true);
    let first = runtime.run_graph_file_with_host(fixture.graph_path(), &mut first_host)?;
    assert_eq!(first.state.status, GraphStatus::Succeeded);

    let mut second_host = ApprovalHost::approved(true);
    let second = runtime.run_graph_file_with_host(fixture.graph_path(), &mut second_host);
    match second {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("was sealed for 125 USD") && reason.contains("requested 250 USD"),
                "mismatched replay denial should name the stored and requested spend facts, got: {reason}"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "mismatched idempotency replay should deny the second run, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }

    let fulfill_count = invocations
        .borrow()
        .iter()
        .filter(|invocation| invocation.skill_name == "pay-fulfill-rail")
        .count();
    assert_eq!(
        fulfill_count, 1,
        "mismatched replay must deny before a second rail call"
    );
    Ok(())
}

#[test]
fn x402_paid_echo_reused_spend_capability_with_new_idempotency_denied_from_persisted_state_before_second_rail()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = PaidEchoFixture::new()?;
    let state_dir = tempfile::tempdir()?;
    let effect_state_path = state_dir.path().join("effect-state.json");
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        effect_state_path.to_string_lossy().into_owned(),
    );
    env.insert(
        RUNX_RUN_ID_ENV.to_owned(),
        "run:test-payment-reuse".to_owned(),
    );
    let adapter = PaidEchoAdapter::with_idempotency_keys(
        PaidEchoRailProof::Present,
        [PAID_ECHO_IDEMPOTENCY_KEY, "payment:paid-echo-002"],
    );
    let invocations = adapter.invocations();
    let runtime = Runtime::new(
        adapter,
        RuntimeOptions {
            env,
            effects: runtime_effects(vec![paid_echo_supervisor_evidence(
                PAID_ECHO_IDEMPOTENCY_KEY,
            )]),
            ..RuntimeOptions::local_development()
        },
    );

    let mut first_host = ApprovalHost::approved(true);
    let first = runtime.run_graph_file_with_host(fixture.graph_path(), &mut first_host)?;
    assert_eq!(first.state.status, GraphStatus::Succeeded);

    let mut second_host = ApprovalHost::approved(true);
    let second = runtime.run_graph_file_with_host(fixture.graph_path(), &mut second_host);
    match second {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("already consumed"),
                "second spend should be denied from persisted consumption, got: {reason}"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "reused spend capability with a new idempotency key should deny the second run, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }

    let fulfill_count = invocations
        .borrow()
        .iter()
        .filter(|invocation| invocation.skill_name == "pay-fulfill-rail")
        .count();
    assert_eq!(
        fulfill_count, 1,
        "persisted consumed spend capability must deny before a second rail call"
    );
    Ok(())
}

#[test]
fn x402_paid_echo_run_cap_exhaustion_is_governed_denial_before_second_rail()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = PaidEchoFixture::new()?;
    let state_dir = tempfile::tempdir()?;
    let effect_state_path = state_dir.path().join("effect-state.json");
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        effect_state_path.to_string_lossy().into_owned(),
    );
    env.insert(
        RUNX_RUN_ID_ENV.to_owned(),
        "run:test-payment-run-cap".to_owned(),
    );
    let adapter = PaidEchoAdapter::with_run_cap_and_spend_capability_refs(
        PaidEchoRailProof::Present,
        [PAID_ECHO_IDEMPOTENCY_KEY, "payment:paid-echo-run-cap-002"],
        [125, 125],
        [
            "runx:payment-capability:paid-echo-spend-1",
            "runx:payment-capability:paid-echo-spend-2",
        ],
        200,
    );
    let invocations = adapter.invocations();
    let runtime = Runtime::new(
        adapter,
        RuntimeOptions {
            env,
            effects: runtime_effects(vec![paid_echo_supervisor_evidence(
                PAID_ECHO_IDEMPOTENCY_KEY,
            )]),
            ..RuntimeOptions::local_development()
        },
    );

    let mut first_host = ApprovalHost::approved(true);
    let first = runtime.run_graph_file_with_host(fixture.graph_path(), &mut first_host)?;
    assert_eq!(first.state.status, GraphStatus::Succeeded);

    let mut second_host = ApprovalHost::approved(true);
    let second = runtime.run_graph_file_with_host(fixture.graph_path(), &mut second_host);
    match second {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("max_per_run_units")
                    && reason.contains("attempted 250")
                    && reason.contains("max 200"),
                "run cap denial should be a governed authority refusal, got: {reason}"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "run cap exhaustion should deny the second run, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }

    let fulfill_count = invocations
        .borrow()
        .iter()
        .filter(|invocation| invocation.skill_name == "pay-fulfill-rail")
        .count();
    assert_eq!(
        fulfill_count, 1,
        "aggregate run cap denial must happen before a second rail call"
    );
    let state_text = std::fs::read_to_string(effect_state_path)?;
    assert!(state_text.contains("\"reserved_minor\": 125"));
    assert!(!state_text.contains("payment:paid-echo-run-cap-002"));
    Ok(())
}

#[test]
fn x402_paid_echo_partial_mutation_escalates_without_second_rail()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = PaidEchoFixture::new()?;
    let state_dir = tempfile::tempdir()?;
    let effect_state_path = state_dir.path().join("effect-state.json");
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_EFFECT_STATE_PATH_ENV.to_owned(),
        effect_state_path.to_string_lossy().into_owned(),
    );
    env.insert(
        RUNX_RUN_ID_ENV.to_owned(),
        "run:test-payment-partial".to_owned(),
    );
    let adapter = PaidEchoAdapter::new(PaidEchoRailProof::Partial);
    let invocations = adapter.invocations();
    let runtime = Runtime::new(
        adapter,
        RuntimeOptions {
            env,
            effects: runtime_effects(Vec::new()),
            ..RuntimeOptions::local_development()
        },
    );

    let mut first_host = ApprovalHost::approved(true);
    let first = runtime.run_graph_file_with_host(fixture.graph_path(), &mut first_host);
    match first {
        Err(RuntimeError::SkillFailed {
            skill_name,
            message,
        }) => {
            assert_eq!(skill_name, "fulfill");
            assert!(
                message.contains("partial rail mutation"),
                "first run should fail after recording a partial rail mutation, got: {message}"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "partial rail mutation should fail the first run before echo, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }

    let mut second_host = ApprovalHost::approved(true);
    let second = runtime.run_graph_file_with_host(fixture.graph_path(), &mut second_host);
    match second {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("recovery escalated"),
                "second run should escalate recovery instead of retrying rail, got: {reason}"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "in-flight rail mutation should escalate before a second rail call, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }

    let fulfill_count = invocations
        .borrow()
        .iter()
        .filter(|invocation| invocation.skill_name == "pay-fulfill-rail")
        .count();
    assert_eq!(
        fulfill_count, 1,
        "partial recovery escalation must not issue a second rail mutation"
    );
    let store = FileBackedEffectStateStore::open(&effect_state_path)?;
    let mutation = store
        .lookup_mutation(
            PAYMENT_EFFECT_FAMILY,
            &runx_pay::effect_state::EffectIdempotencyKey::new(
                "mock",
                "merchant:paid-echo",
                PAID_ECHO_IDEMPOTENCY_KEY,
            ),
        )
        .ok_or("rail mutation should be persisted")?;
    assert_eq!(mutation.status, EffectMutationStatus::Escalated);
    assert_eq!(mutation.recovery_state, EffectRecoveryState::Escalated);
    Ok(())
}

#[test]
fn x402_paid_echo_denied_approval_never_invokes_payment_or_echo()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = PaidEchoFixture::new()?;
    let adapter = PaidEchoAdapter::new(PaidEchoRailProof::Present);
    let invocations = adapter.invocations();
    let runtime = Runtime::new(adapter, runtime_options_with_effects(Vec::new()));
    let mut host = ApprovalHost::approved(false);

    let result = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host);

    match result {
        Err(RuntimeError::GraphBlocked { step_id, reason }) => {
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("approve-spend.payment_approval.data.approved"),
                "blocked reason should name the failed payment approval gate"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "denied paid echo should block before fulfill/echo, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }

    assert_eq!(
        invocations
            .borrow()
            .iter()
            .map(|invocation| invocation.skill_name.as_str())
            .collect::<Vec<_>>(),
        vec!["pay-quote", "pay-reserve"],
        "approval denial must stop before rail fulfillment and paid echo"
    );
    Ok(())
}

#[test]
fn x402_paid_echo_missing_rail_proof_never_invokes_echo() -> Result<(), Box<dyn std::error::Error>>
{
    let fixture = PaidEchoFixture::new()?;
    let adapter = PaidEchoAdapter::new(PaidEchoRailProof::Missing);
    let invocations = adapter.invocations();
    let runtime = Runtime::new(adapter, runtime_options_with_effects(Vec::new()));
    let mut host = ApprovalHost::approved(true);

    let result = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host);

    match result {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains("rail proof"),
                "payment authority denial should identify the missing rail proof"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "proofless payment should deny before echo, ran {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }

    assert_eq!(
        invocations
            .borrow()
            .iter()
            .map(|invocation| invocation.skill_name.as_str())
            .collect::<Vec<_>>(),
        vec!["pay-quote", "pay-reserve", "pay-fulfill-rail"],
        "missing rail proof must stop before the paid echo tool receives a credential"
    );
    Ok(())
}

fn assert_payment_admission_denied_before_adapter(
    admission: FulfillAdmission,
    expected_reason_fragment: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let fixture = GraphFixture::with_fulfill_options(admission, FulfillScope::PaymentSpend)?;
    let adapter = RecordingAdapter::default();
    let invocations = adapter.invocations();
    let runtime = Runtime::new(adapter, runtime_options_with_effects(Vec::new()));
    let mut host = ApprovalHost::approved(true);

    let result = runtime.run_graph_file_with_host(fixture.graph_path(), &mut host);

    match result {
        Err(RuntimeError::AuthorityDenied {
            verb,
            step_id,
            reason,
        }) => {
            assert_eq!(verb, AuthorityVerb::Commit);
            assert_eq!(step_id, "fulfill");
            assert!(
                reason.contains(expected_reason_fragment),
                "payment authority denial should name the missing admission input"
            );
        }
        Ok(run) => {
            return Err(std::io::Error::other(format!(
                "expected fulfill to be denied, ran steps {:?}",
                step_ids(&run.steps)
            ))
            .into());
        }
        Err(error) => {
            return Err(std::io::Error::other(format!("unexpected runtime error: {error}")).into());
        }
    }
    assert!(
        invocations.borrow().is_empty(),
        "payment rail admission must deny before invoking the adapter"
    );
    Ok(())
}

fn runtime_options_with_effects(
    evidence: Vec<PaymentSupervisorSettlementEvidence>,
) -> RuntimeOptions {
    let mut env = BTreeMap::new();
    env.insert(
        RUNX_RUN_ID_ENV.to_owned(),
        "run:test-payment-execution".to_owned(),
    );
    RuntimeOptions {
        env,
        effects: runtime_effects(evidence),
        ..RuntimeOptions::local_development()
    }
}

fn runtime_effects(evidence: Vec<PaymentSupervisorSettlementEvidence>) -> RuntimeEffectRegistry {
    RuntimeEffectRegistry::with_effect(PaymentRuntimeEffect::new(
        ExpectedPaymentFinalitySupervisor::new(evidence),
    ))
}

#[derive(Clone, Debug)]
struct ExpectedPaymentFinalitySupervisor {
    evidence_by_proof_ref: BTreeMap<String, PaymentSupervisorSettlementEvidence>,
}

impl ExpectedPaymentFinalitySupervisor {
    fn new(evidence: Vec<PaymentSupervisorSettlementEvidence>) -> Self {
        Self {
            evidence_by_proof_ref: evidence
                .into_iter()
                .map(|evidence| (evidence.proof_ref.clone(), evidence))
                .collect(),
        }
    }
}

impl PaymentFinalitySupervisor for ExpectedPaymentFinalitySupervisor {
    fn supervise(
        &self,
        request: PaymentFinalitySupervisorRequest<'_>,
    ) -> Result<PaymentFinalitySupervisorEvidence, PaymentFinalitySupervisorError> {
        let proof_ref = supervisor_payload_string(&request, "proof_ref")?;
        let rail = supervisor_payload_string(&request, "rail")?;
        let counterparty = supervisor_payload_string(&request, "counterparty")?;
        let amount_minor = supervisor_payload_u64(&request, "amount_minor")?;
        let currency = supervisor_payload_string(&request, "currency")?;
        let idempotency_key = supervisor_payload_string(&request, "idempotency_key")?;
        let evidence = self
            .evidence_by_proof_ref
            .get(proof_ref)
            .cloned()
            .ok_or_else(|| PaymentFinalitySupervisorError::InvalidEvidence {
                message: format!("no supervisor settlement for proof ref {proof_ref}"),
            })?;
        expect_supervisor_field("rail", rail, &evidence.rail)?;
        expect_supervisor_field("counterparty", counterparty, &evidence.counterparty)?;
        expect_supervisor_u64("amount_minor", amount_minor, evidence.amount_minor)?;
        expect_supervisor_field("currency", currency, &evidence.currency)?;
        expect_supervisor_field(
            "idempotency_key",
            idempotency_key,
            &evidence.idempotency_key,
        )?;
        expect_optional_supervisor_field(
            &request,
            "payment_admission_id",
            evidence.payment_admission_id.as_deref(),
        )?;
        expect_optional_supervisor_field(
            &request,
            "money_movement_id",
            evidence.money_movement_id.as_deref(),
        )?;
        expect_optional_supervisor_field(
            &request,
            "kernel_token_digest",
            evidence.kernel_token_digest.as_deref(),
        )?;
        Ok(PaymentFinalitySupervisorEvidence::new(
            request.family,
            payment_finality_supervisor_evidence_payload(&evidence),
        ))
    }
}

fn expect_optional_supervisor_field(
    request: &PaymentFinalitySupervisorRequest<'_>,
    field: &'static str,
    expected: Option<&str>,
) -> Result<(), PaymentFinalitySupervisorError> {
    if let Some(expected) = expected {
        let actual = supervisor_payload_string(request, field)?;
        expect_supervisor_field(field, expected, actual)?;
    }
    Ok(())
}

fn supervisor_payload_string<'a>(
    request: &'a PaymentFinalitySupervisorRequest<'_>,
    field: &'static str,
) -> Result<&'a str, PaymentFinalitySupervisorError> {
    match request.payload.get(field) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(PaymentFinalitySupervisorError::InvalidEvidence {
            message: format!("missing or invalid supervisor payload field {field}"),
        }),
    }
}

fn supervisor_payload_u64(
    request: &PaymentFinalitySupervisorRequest<'_>,
    field: &'static str,
) -> Result<u64, PaymentFinalitySupervisorError> {
    match request.payload.get(field) {
        Some(JsonValue::Number(JsonNumber::U64(value))) => Ok(*value),
        Some(JsonValue::Number(JsonNumber::I64(value))) => {
            u64::try_from(*value).map_err(|_| PaymentFinalitySupervisorError::InvalidEvidence {
                message: format!("supervisor payload field {field} must be unsigned"),
            })
        }
        _ => Err(PaymentFinalitySupervisorError::InvalidEvidence {
            message: format!("missing or invalid supervisor payload field {field}"),
        }),
    }
}

fn expect_supervisor_field(
    field: &'static str,
    expected: &str,
    actual: &str,
) -> Result<(), PaymentFinalitySupervisorError> {
    if expected == actual {
        Ok(())
    } else {
        Err(PaymentFinalitySupervisorError::FieldMismatch {
            field,
            expected: expected.to_owned(),
            actual: actual.to_owned(),
        })
    }
}

fn expect_supervisor_u64(
    field: &'static str,
    expected: u64,
    actual: u64,
) -> Result<(), PaymentFinalitySupervisorError> {
    if expected == actual {
        Ok(())
    } else {
        Err(PaymentFinalitySupervisorError::FieldMismatch {
            field,
            expected: expected.to_string(),
            actual: actual.to_string(),
        })
    }
}

fn x402_approval_supervisor_evidence() -> PaymentSupervisorSettlementEvidence {
    payment_supervisor_evidence(
        X402_APPROVAL_PROOF_REF,
        "mock",
        "merchant-123",
        125,
        "USD",
        X402_APPROVAL_IDEMPOTENCY_KEY,
    )
}

fn x402_approval_supervisor_evidence_with_identity() -> PaymentSupervisorSettlementEvidence {
    let mut evidence = x402_approval_supervisor_evidence();
    evidence.payment_admission_id = Some("sha256:payment-admission-001".to_owned());
    evidence.money_movement_id = Some("sha256:money-movement-001".to_owned());
    evidence.kernel_token_digest = Some("sha256:kernel-token-001".to_owned());
    evidence.proof_locator = Some(X402_APPROVAL_PROOF_REF.to_owned());
    evidence.proof_status = Some("fulfilled".to_owned());
    evidence
}

fn paid_echo_supervisor_evidence(idempotency_key: &str) -> PaymentSupervisorSettlementEvidence {
    payment_supervisor_evidence(
        "receipt-proof:mock:paid-echo-001",
        "mock",
        "merchant:paid-echo",
        125,
        "USD",
        idempotency_key,
    )
}

fn payment_admission_identity() -> Value {
    json!({
        "token": {
            "money_movement_id": "sha256:money-movement-001"
        },
        "token_digest": "sha256:payment-admission-001",
        "payment_admission_id": "sha256:payment-admission-001",
        "money_movement_id": "sha256:money-movement-001",
        "kernel_token_digest": "sha256:kernel-token-001"
    })
}

fn payment_supervisor_evidence(
    proof_ref: &str,
    rail: &str,
    counterparty: &str,
    amount_minor: u64,
    currency: &str,
    idempotency_key: &str,
) -> PaymentSupervisorSettlementEvidence {
    PaymentSupervisorSettlementEvidence {
        verifier_id: PAYMENT_RAIL_SUPERVISOR_VERIFIER_ID.to_owned(),
        proof_ref: proof_ref.to_owned(),
        rail: rail.to_owned(),
        counterparty: counterparty.to_owned(),
        amount_minor,
        currency: currency.to_owned(),
        idempotency_key: idempotency_key.to_owned(),
        payment_admission_id: None,
        money_movement_id: None,
        kernel_token_digest: None,
        proof_locator: None,
        proof_status: None,
        settlement_status: Some("fulfilled".to_owned()),
        provider_event_ref: Some(format!("provider:event:{idempotency_key}")),
    }
}

struct RecordingAdapter {
    invocations: Rc<RefCell<Vec<String>>>,
    stdout: String,
}

impl Default for RecordingAdapter {
    fn default() -> Self {
        Self::with_stdout(
            r#"{"effect_evidence_packet":{"data":{"rail_result":{"status":"fulfilled","rail":"mock","amount_minor":125,"currency":"USD"},"rail_proof":{"proof_ref":"receipt-proof:mock:x402-pay-approval-001","idempotency_key":"payment:x402-pay-approval-001"},"credential_envelope":{"form":"paid_tool_credential","credential_ref":"credential:mock:x402-pay-approval-001"}}}}"#,
        )
    }
}

impl RecordingAdapter {
    fn without_rail_proof() -> Self {
        Self::with_stdout(
            r#"{"effect_evidence_packet":{"data":{"rail_result":{"status":"fulfilled","rail":"mock","amount_minor":125,"currency":"USD"},"credential_envelope":{"form":"paid_tool_credential","credential_ref":"credential:mock:x402-pay-approval-001"}}}}"#,
        )
    }

    fn with_stdout(stdout: &str) -> Self {
        Self {
            invocations: Rc::new(RefCell::new(Vec::new())),
            stdout: stdout.to_owned(),
        }
    }

    fn invocations(&self) -> Rc<RefCell<Vec<String>>> {
        Rc::clone(&self.invocations)
    }
}

impl SkillAdapter for RecordingAdapter {
    fn adapter_type(&self) -> &'static str {
        "x402-pay-approval-test"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        self.invocations.borrow_mut().push(request.skill_name);
        Ok(SkillOutput {
            status: InvocationStatus::Success,
            stdout: self.stdout.clone(),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
            metadata: JsonObject::new(),
        })
    }
}

#[derive(Clone, Copy)]
enum PaidEchoRailProof {
    Present,
    Missing,
    Partial,
}

#[derive(Clone, Debug)]
struct PaidEchoInvocation {
    skill_name: String,
    inputs: JsonObject,
}

struct PaidEchoAdapter {
    invocations: Rc<RefCell<Vec<PaidEchoInvocation>>>,
    rail_proof: PaidEchoRailProof,
    idempotency_keys: Rc<RefCell<VecDeque<String>>>,
    current_idempotency_key: Rc<RefCell<String>>,
    amount_minor_by_run: Rc<RefCell<VecDeque<u64>>>,
    current_amount_minor: Rc<RefCell<u64>>,
    spend_capability_refs: Rc<RefCell<VecDeque<String>>>,
    current_spend_capability_ref: Rc<RefCell<String>>,
    max_per_run_units: u64,
}

impl PaidEchoAdapter {
    fn new(rail_proof: PaidEchoRailProof) -> Self {
        Self::with_idempotency_keys(rail_proof, [PAID_ECHO_IDEMPOTENCY_KEY])
    }

    fn with_idempotency_keys<const N: usize>(
        rail_proof: PaidEchoRailProof,
        idempotency_keys: [&str; N],
    ) -> Self {
        Self::with_idempotency_keys_and_amounts(rail_proof, idempotency_keys, [125])
    }

    fn with_idempotency_keys_and_amounts<const K: usize, const A: usize>(
        rail_proof: PaidEchoRailProof,
        idempotency_keys: [&str; K],
        amount_minor_by_run: [u64; A],
    ) -> Self {
        Self::with_run_cap(rail_proof, idempotency_keys, amount_minor_by_run, 25_000)
    }

    fn with_run_cap<const K: usize, const A: usize>(
        rail_proof: PaidEchoRailProof,
        idempotency_keys: [&str; K],
        amount_minor_by_run: [u64; A],
        max_per_run_units: u64,
    ) -> Self {
        Self::with_run_cap_and_spend_capability_refs(
            rail_proof,
            idempotency_keys,
            amount_minor_by_run,
            ["runx:payment-capability:paid-echo-spend-1"],
            max_per_run_units,
        )
    }

    fn with_run_cap_and_spend_capability_refs<const K: usize, const A: usize, const C: usize>(
        rail_proof: PaidEchoRailProof,
        idempotency_keys: [&str; K],
        amount_minor_by_run: [u64; A],
        spend_capability_refs: [&str; C],
        max_per_run_units: u64,
    ) -> Self {
        Self {
            invocations: Rc::new(RefCell::new(Vec::new())),
            rail_proof,
            idempotency_keys: Rc::new(RefCell::new(VecDeque::from(
                idempotency_keys.map(str::to_owned),
            ))),
            current_idempotency_key: Rc::new(RefCell::new(PAID_ECHO_IDEMPOTENCY_KEY.to_owned())),
            amount_minor_by_run: Rc::new(RefCell::new(VecDeque::from(amount_minor_by_run))),
            current_amount_minor: Rc::new(RefCell::new(125)),
            spend_capability_refs: Rc::new(RefCell::new(VecDeque::from(
                spend_capability_refs.map(str::to_owned),
            ))),
            current_spend_capability_ref: Rc::new(RefCell::new(
                "runx:payment-capability:paid-echo-spend-1".to_owned(),
            )),
            max_per_run_units,
        }
    }

    fn invocations(&self) -> Rc<RefCell<Vec<PaidEchoInvocation>>> {
        Rc::clone(&self.invocations)
    }

    fn reserve_idempotency_key(&self) -> String {
        let key = self
            .idempotency_keys
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| self.current_idempotency_key.borrow().clone());
        *self.current_idempotency_key.borrow_mut() = key.clone();
        key
    }

    fn reserve_amount_minor(&self) -> u64 {
        let amount_minor = self
            .amount_minor_by_run
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| *self.current_amount_minor.borrow());
        *self.current_amount_minor.borrow_mut() = amount_minor;
        amount_minor
    }

    fn reserve_spend_capability_ref(&self) -> String {
        let capability_ref = self
            .spend_capability_refs
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| self.current_spend_capability_ref.borrow().clone());
        *self.current_spend_capability_ref.borrow_mut() = capability_ref.clone();
        capability_ref
    }
}

impl SkillAdapter for PaidEchoAdapter {
    fn adapter_type(&self) -> &'static str {
        "paid-echo-test"
    }

    fn invoke(&self, request: SkillInvocation) -> Result<SkillOutput, RuntimeError> {
        self.invocations.borrow_mut().push(PaidEchoInvocation {
            skill_name: request.skill_name.clone(),
            inputs: request.inputs.clone(),
        });
        Ok(match request.skill_name.as_str() {
            "pay-quote" => skill_success(json!({
                "payment_quote_packet": {
                    "data": {
                        "payment_signal": {
                            "signal_type": "effect_required",
                            "challenge_id": "ch_mock_paid_echo_001",
                            "amount_minor": *self.current_amount_minor.borrow(),
                            "currency": "USD",
                            "rail": "mock",
                            "counterparty": "merchant:paid-echo",
                            "operation": "paid.echo"
                        },
                        "payment_quote": {
                            "quote_id": "quote_paid_echo_001",
                            "amount_minor": *self.current_amount_minor.borrow(),
                            "currency": "USD",
                            "rails": ["mock"],
                            "counterparty": "merchant:paid-echo",
                            "operation": "paid.echo"
                        }
                    }
                }
            })),
            "pay-reserve" => {
                let idempotency_key = self.reserve_idempotency_key();
                let amount_minor = self.reserve_amount_minor();
                let spend_capability_ref = self.reserve_spend_capability_ref();
                skill_success(json!({
                    "payment_reservation_packet": {
                        "data": {
                            "payment_decision": paid_echo_reservation_decision(),
                            "reserved_payment_authority": paid_echo_reserved_payment_authority(
                                &idempotency_key,
                                amount_minor,
                                self.max_per_run_units
                            ),
                            "spend_capability_ref": paid_echo_spend_capability_ref(
                                &spend_capability_ref
                            ),
                            "idempotency": { "key": idempotency_key }
                        }
                    }
                }))
            }
            "pay-fulfill-rail" if matches!(self.rail_proof, PaidEchoRailProof::Partial) => {
                let idempotency_key = self.current_idempotency_key.borrow().clone();
                let amount_minor = *self.current_amount_minor.borrow();
                skill_failure_with_stdout(
                    paid_echo_partial_rail_packet(&idempotency_key, amount_minor),
                    "partial rail mutation recorded before terminal proof",
                )
            }
            "pay-fulfill-rail" => {
                let idempotency_key = self.current_idempotency_key.borrow().clone();
                let amount_minor = *self.current_amount_minor.borrow();
                skill_success(paid_echo_rail_packet(
                    self.rail_proof,
                    &idempotency_key,
                    amount_minor,
                ))
            }
            "paid-echo" => {
                if request
                    .inputs
                    .get("payment_credential_ref")
                    .is_some_and(|value| {
                        value == &JsonValue::String("credential:mock:paid-echo-001".to_owned())
                    })
                    && request
                        .inputs
                        .get("payment_proof_ref")
                        .is_some_and(|value| {
                            value
                                == &JsonValue::String("receipt-proof:mock:paid-echo-001".to_owned())
                        })
                {
                    skill_success(json!({
                        "paid_echo_result": {
                            "message": "hello from paid echo",
                            "payment_proof_ref": "receipt-proof:mock:paid-echo-001"
                        }
                    }))
                } else {
                    skill_failure("paid echo requires a scoped payment credential and proof")
                }
            }
            other => skill_failure(&format!("unexpected skill {other}")),
        })
    }
}

fn skill_success(value: Value) -> SkillOutput {
    let stdout = match serde_json::to_string(&value) {
        Ok(stdout) => stdout,
        Err(error) => return skill_failure(&format!("test JSON serialization failed: {error}")),
    };
    SkillOutput {
        status: InvocationStatus::Success,
        stdout,
        stderr: String::new(),
        exit_code: Some(0),
        duration_ms: 1,
        metadata: JsonObject::new(),
    }
}

fn skill_failure(message: &str) -> SkillOutput {
    SkillOutput {
        status: InvocationStatus::Failure,
        stdout: String::new(),
        stderr: message.to_owned(),
        exit_code: Some(1),
        duration_ms: 1,
        metadata: JsonObject::new(),
    }
}

fn skill_failure_with_stdout(value: Value, message: &str) -> SkillOutput {
    let stdout = match serde_json::to_string(&value) {
        Ok(stdout) => stdout,
        Err(error) => {
            return skill_failure(&format!(
                "{message}; test JSON serialization failed: {error}"
            ));
        }
    };
    SkillOutput {
        status: InvocationStatus::Failure,
        stdout,
        stderr: message.to_owned(),
        exit_code: Some(1),
        duration_ms: 1,
        metadata: JsonObject::new(),
    }
}

fn paid_echo_rail_packet(
    rail_proof: PaidEchoRailProof,
    idempotency_key: &str,
    amount_minor: u64,
) -> Value {
    let mut data = json!({
        "rail_result": {
            "status": "fulfilled",
            "rail": "mock",
            "amount_minor": amount_minor,
            "currency": "USD"
        },
        "credential_envelope": {
            "form": "paid_tool_credential",
            "credential_ref": "credential:mock:paid-echo-001"
        },
        "redactions": ["rail_session_material"],
        "recovery_hint": { "status": "sealed" }
    });
    if matches!(rail_proof, PaidEchoRailProof::Present) {
        data["rail_proof"] = json!({
            "proof_ref": "receipt-proof:mock:paid-echo-001",
            "idempotency_key": idempotency_key,
            "rail_session_material_ref": PAID_ECHO_RAIL_SESSION_MATERIAL_REF
        });
    }
    json!({ "effect_evidence_packet": { "data": data } })
}

fn paid_echo_partial_rail_packet(idempotency_key: &str, amount_minor: u64) -> Value {
    json!({
        "effect_evidence_packet": {
            "data": {
                "rail_result": {
                    "status": "partial",
                    "rail": "mock",
                    "amount_minor": amount_minor,
                    "currency": "USD",
                    "counterparty": "merchant:paid-echo"
                },
                "recovery_hint": {
                    "status": "partial",
                    "idempotency_key": idempotency_key,
                    "next_action": "recover_by_idempotency_key"
                }
            }
        }
    })
}

struct ApprovalHost {
    events: RefCell<Vec<ExecutionEvent>>,
    requests: RefCell<Vec<ResolutionRequest>>,
    responses: RefCell<VecDeque<Option<ResolutionResponse>>>,
}

impl ApprovalHost {
    fn approved(approved: bool) -> Self {
        Self {
            events: RefCell::new(Vec::new()),
            requests: RefCell::new(Vec::new()),
            responses: RefCell::new(VecDeque::from([Some(ResolutionResponse {
                actor: ResolutionResponseActor::Human,
                payload: JsonValue::Bool(approved),
            })])),
        }
    }
}

impl Host for ApprovalHost {
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

struct GraphFixture {
    _temp: TempDir,
    graph_path: PathBuf,
}

impl GraphFixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Self::with_fulfill_options(FulfillAdmission::Valid, FulfillScope::PaymentSpend)
    }

    fn with_fulfill_options(
        admission: FulfillAdmission,
        scope: FulfillScope,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        let fulfill_dir = temp.path().join("fulfill");
        fs::create_dir(&fulfill_dir)?;
        fs::write(
            fulfill_dir.join("SKILL.md"),
            r#"---
name: pay-fulfill-rail
description: Fulfill approved payment.
source:
  type: cli-tool
  command: runx-payment-test
---

Fulfill the approved payment.
"#,
        )?;
        let graph_path = temp.path().join("graph.yaml");
        fs::write(&graph_path, graph_yaml(admission, scope)?)?;
        Ok(Self {
            _temp: temp,
            graph_path,
        })
    }

    fn graph_path(&self) -> &Path {
        self.graph_path.as_path()
    }
}

struct PaidEchoFixture {
    _temp: TempDir,
    graph_path: PathBuf,
}

impl PaidEchoFixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let temp = tempfile::tempdir()?;
        write_cli_tool_skill(
            &temp.path().join("quote"),
            "pay-quote",
            Some("payment_quote_packet"),
        )?;
        write_cli_tool_skill(
            &temp.path().join("reserve"),
            "pay-reserve",
            Some("payment_reservation_packet"),
        )?;
        write_cli_tool_skill(
            &temp.path().join("fulfill"),
            "pay-fulfill-rail",
            Some("effect_evidence_packet"),
        )?;
        write_cli_tool_skill(&temp.path().join("echo"), "paid-echo", None)?;
        let graph_path = temp.path().join("graph.yaml");
        fs::write(&graph_path, paid_echo_graph_yaml()?)?;
        Ok(Self {
            _temp: temp,
            graph_path,
        })
    }

    fn graph_path(&self) -> &Path {
        self.graph_path.as_path()
    }
}

fn write_cli_tool_skill(
    dir: &Path,
    name: &str,
    emitted_packet: Option<&str>,
) -> Result<(), std::io::Error> {
    fs::create_dir(dir)?;
    let artifacts = emitted_packet.map_or_else(String::new, |packet| {
        format!("runx:\n  artifacts:\n    named_emits:\n      {packet}: runx.payment.{packet}.v1\n")
    });
    fs::write(
        dir.join("SKILL.md"),
        format!(
            r#"---
name: {name}
description: Payment fixture skill.
source:
  type: cli-tool
  command: runx-payment-test
{artifacts}---

Payment fixture skill.
"#
        ),
    )
}

#[derive(Clone, Copy)]
enum FulfillAdmission {
    Valid,
    ValidWithPaymentAdmission,
    MissingReservedPaymentAuthority,
    MissingSpendCapabilityRef,
    MissingIdempotencyKey,
    MissingSubsetProof,
    AmountWidening,
    MissingAll,
}

#[derive(Clone, Copy)]
enum FulfillScope {
    PaymentSpend,
    None,
}

fn graph_yaml(
    admission: FulfillAdmission,
    scope: FulfillScope,
) -> Result<String, serde_json::Error> {
    let mut fulfill = json!({
        "id": "fulfill",
        "skill": "./fulfill",
    });
    if matches!(scope, FulfillScope::PaymentSpend) {
        fulfill["scopes"] = json!(["payment:spend"]);
    }
    if let Some(inputs) = fulfill_inputs(admission) {
        fulfill["inputs"] = inputs;
    }
    serde_json::to_string_pretty(&json!({
        "name": "x402-pay-approval",
        "steps": [
            {
                "id": "approve-spend",
                "run": { "type": "approval" },
                "inputs": {
                    "gate_id": "spend-approval",
                    "gate_type": "payment",
                    "reason": "Approve payment before fulfillment.",
                    "amount_minor": 125,
                    "currency": "USD"
                },
                "artifacts": { "wrap_as": "payment_approval" }
            },
            fulfill
        ],
        "policy": {
            "guards": [
                {
                    "step": "fulfill",
                    "field": "approve-spend.payment_approval.data.approved",
                    "equals": true
                }
            ]
        }
    }))
}

fn paid_echo_graph_yaml() -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(&json!({
        "name": "x402-pay-paid-echo",
        "steps": [
            {
                "id": "quote",
                "skill": "./quote",
                "inputs": {
                    "payment_signal": {
                        "signal_type": "effect_required",
                        "challenge_id": "ch_mock_paid_echo_001",
                        "amount_minor": 125,
                        "currency": "USD",
                        "rail": "mock",
                        "counterparty": "merchant:paid-echo",
                        "operation": "paid.echo"
                    }
                }
            },
            {
                "id": "reserve",
                "skill": "./reserve",
                "context": {
                    "payment_quote_packet": "quote.payment_quote_packet.data"
                }
            },
            {
                "id": "approve-spend",
                "run": { "type": "approval" },
                "inputs": {
                    "gate_id": "spend-approval",
                    "gate_type": "payment",
                    "reason": "Approve payment before paid echo.",
                    "amount_minor": 125,
                    "currency": "USD"
                },
                "artifacts": { "wrap_as": "payment_approval" }
            },
            {
                "id": "fulfill",
                "skill": "./fulfill",
                "scopes": ["payment:spend"],
                "mutation": true,
                "idempotency_key": "paid-echo-fulfill",
                "context": {
                    "reserved_payment_authority": "reserve.payment_reservation_packet.data.reserved_payment_authority",
                    "spend_capability_ref": "reserve.payment_reservation_packet.data.spend_capability_ref",
                    "idempotency": "reserve.payment_reservation_packet.data.idempotency"
                }
            },
            {
                "id": "echo",
                "skill": "./echo",
                "inputs": {
                    "message": "hello from paid echo"
                },
                "context": {
                    "payment_credential_ref": "fulfill.effect_evidence_packet.data.credential_envelope.credential_ref",
                    "payment_proof_ref": "fulfill.effect_evidence_packet.data.rail_proof.proof_ref"
                }
            }
        ],
        "policy": {
            "guards": [
                {
                    "step": "fulfill",
                    "field": "approve-spend.payment_approval.data.approved",
                    "equals": true
                }
            ]
        }
    }))
}

fn fulfill_inputs(admission: FulfillAdmission) -> Option<Value> {
    match admission {
        FulfillAdmission::Valid => Some(valid_payment_inputs(2_500, true)),
        FulfillAdmission::ValidWithPaymentAdmission => {
            Some(valid_payment_inputs_with_payment_admission(2_500, true))
        }
        FulfillAdmission::MissingReservedPaymentAuthority => Some(json!({
            "spend_capability_ref": spend_capability_ref(),
            "idempotency": approval_idempotency(),
        })),
        FulfillAdmission::MissingSpendCapabilityRef => Some(json!({
            "reserved_payment_authority": reserved_payment_authority(2_500, true),
            "idempotency": approval_idempotency(),
        })),
        FulfillAdmission::MissingIdempotencyKey => Some(json!({
            "reserved_payment_authority": reserved_payment_authority(2_500, true),
            "spend_capability_ref": spend_capability_ref(),
            "idempotency": {}
        })),
        FulfillAdmission::MissingSubsetProof => Some(valid_payment_inputs(2_500, false)),
        FulfillAdmission::AmountWidening => Some(valid_payment_inputs(20_000, true)),
        FulfillAdmission::MissingAll => None,
    }
}

fn valid_payment_inputs(child_max_per_call_units: u64, include_subset_proof: bool) -> Value {
    json!({
        "reserved_payment_authority": reserved_payment_authority(child_max_per_call_units, include_subset_proof),
        "spend_capability_ref": spend_capability_ref(),
        "idempotency": approval_idempotency()
    })
}

fn approval_idempotency() -> Value {
    let mut idempotency = serde_json::Map::new();
    idempotency.insert(
        "key".to_owned(),
        Value::String(X402_APPROVAL_IDEMPOTENCY_KEY.to_owned()),
    );
    Value::Object(idempotency)
}

fn valid_payment_inputs_with_payment_admission(
    child_max_per_call_units: u64,
    include_subset_proof: bool,
) -> Value {
    let mut inputs = valid_payment_inputs(child_max_per_call_units, include_subset_proof);
    if let Some(object) = inputs.as_object_mut() {
        object.insert("payment_admission".to_owned(), payment_admission_identity());
    }
    inputs
}

fn reserved_payment_authority(child_max_per_call_units: u64, include_subset_proof: bool) -> Value {
    let mut authority = json!({
        "parent_authority": payment_term("parent", ["estimate", "prepare", "commit", "verify"], 10_000),
        "child_authority": payment_term("child", ["prepare", "commit"], child_max_per_call_units),
        "reservation_decision": reservation_decision(),
        "child_harness_ref": child_harness_ref(),
        "spend_capability_binding": {
            "child_harness_ref": child_harness_ref(),
            "act_id": "act_fulfill",
            "reservation_decision_id": "decision_payment_reservation",
            "idempotency_key": X402_APPROVAL_IDEMPOTENCY_KEY,
            "amount_minor": 125,
            "currency": "USD",
            "counterparty": "merchant-123",
            "rail": "mock"
        },
        "consumed_spend_capability_refs": []
    });
    if include_subset_proof {
        if let Some(object) = authority.as_object_mut() {
            object.insert(
                "subset_proof".to_owned(),
                payment_subset_proof("child", "parent"),
            );
        }
    }
    authority
}

fn payment_subset_proof(child_term_id: &str, parent_term_id: &str) -> Value {
    json!({
        "parent_authority_ref": reference("grant", "runx:payment-grant:checkout"),
        "comparison_algorithm": "runx.payment-authority-subset.v1",
        "result": "subset",
        "compared_terms": [
            {
                "child_term_id": child_term_id,
                "parent_term_id": parent_term_id,
                "relation": "subset"
            }
        ],
        "checked_at": "2026-05-22T00:00:00Z"
    })
}

fn payment_term<const N: usize>(term_id: &str, verbs: [&str; N], max_per_call_units: u64) -> Value {
    let verbs = verbs.as_slice();
    json!({
        "term_id": term_id,
        "principal_ref": reference("principal", "runx:principal:merchant-agent"),
        "resource_ref": reference("grant", "runx:payment-grant:checkout"),
        "resource_family": "effect",
        "verbs": verbs,
        "bounds": {
            "effect_limits": [{
                "family": "payment",
                "unit": "USD",
                "max_per_call_units": max_per_call_units,
                "max_per_run_units": 25_000,
                "channels": ["mock", "card"],
                "peer": "merchant-123",
                "operation": "checkout",
                "authorization_form": "single_use_capability",
                "preflight_required": true,
                "commitment_required": true,
                "idempotency_required": true,
                "recovery_required": true,
                "receipt_before_success": true,
                "single_use_capability": true
            }]
        },
        "capabilities": ["effect_single_use_capability"],
        "expires_at": "2026-05-21T00:00:00Z",
        "issued_by_ref": reference("grant", "runx:grant:issuer"),
        "credential_ref": reference("credential", "runx:credential:payment-session")
    })
}

fn reservation_decision() -> Value {
    json!({
        "decision_id": "decision_payment_reservation",
        "choice": "continue",
        "inputs": {
            "signal_refs": [],
            "target_ref": null,
            "opportunity_refs": [],
            "selection_ref": null
        },
        "proposed_intent": {
            "purpose": "complete a bounded checkout payment",
            "legitimacy": "authorized by selected reservation decision",
            "success_criteria": [],
            "constraints": [],
            "derived_from": []
        },
        "selected_act_id": "act_fulfill",
        "selected_harness_ref": null,
        "justification": {
            "summary": "reservation selected a bounded spend act",
            "evidence_refs": []
        },
        "closure": null,
        "artifact_refs": []
    })
}

fn paid_echo_reserved_payment_authority(
    idempotency_key: &str,
    amount_minor: u64,
    max_per_run_units: u64,
) -> Value {
    json!({
        "parent_authority": paid_echo_payment_term("paid-echo-parent", ["estimate", "prepare", "commit", "verify"], 10_000, max_per_run_units),
        "child_authority": paid_echo_payment_term("paid-echo-child", ["prepare", "commit"], 2_500, max_per_run_units),
        "reservation_decision": paid_echo_reservation_decision(),
        "subset_proof": paid_echo_subset_proof("paid-echo-child", "paid-echo-parent"),
        "child_harness_ref": paid_echo_child_harness_ref(),
        "spend_capability_binding": {
            "child_harness_ref": paid_echo_child_harness_ref(),
            "act_id": "act_fulfill",
            "reservation_decision_id": "decision_paid_echo_reservation",
            "idempotency_key": idempotency_key,
            "amount_minor": amount_minor,
            "currency": "USD",
            "counterparty": "merchant:paid-echo",
            "rail": "mock"
        },
        "consumed_spend_capability_refs": []
    })
}

fn paid_echo_subset_proof(child_term_id: &str, parent_term_id: &str) -> Value {
    json!({
        "parent_authority_ref": reference("grant", "runx:payment-grant:paid-echo"),
        "comparison_algorithm": "runx.payment-authority-subset.v1",
        "result": "subset",
        "compared_terms": [
            {
                "child_term_id": child_term_id,
                "parent_term_id": parent_term_id,
                "relation": "subset"
            }
        ],
        "checked_at": "2026-05-22T00:00:00Z"
    })
}

fn paid_echo_payment_term<const N: usize>(
    term_id: &str,
    verbs: [&str; N],
    max_per_call_units: u64,
    max_per_run_units: u64,
) -> Value {
    let verbs = verbs.as_slice();
    json!({
        "term_id": term_id,
        "principal_ref": reference("principal", "runx:principal:paid-echo-agent"),
        "resource_ref": reference("grant", "runx:payment-grant:paid-echo"),
        "resource_family": "effect",
        "verbs": verbs,
        "bounds": {
            "effect_limits": [{
                "family": "payment",
                "unit": "USD",
                "max_per_call_units": max_per_call_units,
                "max_per_run_units": max_per_run_units,
                "channels": ["mock"],
                "peer": "merchant:paid-echo",
                "operation": "paid.echo",
                "authorization_form": "single_use_capability",
                "preflight_required": true,
                "commitment_required": true,
                "idempotency_required": true,
                "recovery_required": true,
                "receipt_before_success": true,
                "single_use_capability": true
            }]
        },
        "capabilities": ["effect_single_use_capability"],
        "expires_at": "2026-05-21T00:00:00Z",
        "issued_by_ref": reference("grant", "runx:grant:paid-echo-issuer"),
        "credential_ref": reference("credential", "runx:credential:paid-echo-session")
    })
}

fn paid_echo_reservation_decision() -> Value {
    json!({
        "decision_id": "decision_paid_echo_reservation",
        "choice": "continue",
        "inputs": {
            "signal_refs": [],
            "target_ref": null,
            "opportunity_refs": [],
            "selection_ref": null
        },
        "proposed_intent": {
            "purpose": "complete a bounded paid echo",
            "legitimacy": "authorized by selected reservation decision",
            "success_criteria": [],
            "constraints": [],
            "derived_from": []
        },
        "selected_act_id": "act_fulfill",
        "selected_harness_ref": null,
        "justification": {
            "summary": "reservation selected a bounded paid echo spend act",
            "evidence_refs": []
        },
        "closure": null,
        "artifact_refs": []
    })
}

fn paid_echo_child_harness_ref() -> Value {
    reference("harness", "runx:harness:x402-pay-paid-echo_fulfill")
}

fn paid_echo_spend_capability_ref(capability_ref: &str) -> Value {
    reference("credential", capability_ref)
}

fn child_harness_ref() -> Value {
    reference("harness", "runx:harness:x402-pay-approval_fulfill")
}

fn spend_capability_ref() -> Value {
    reference("credential", "runx:payment-capability:spend-1")
}

fn reference(reference_type: &str, uri: &str) -> Value {
    json!({ "type": reference_type, "uri": uri })
}

fn step_ids(steps: &[runx_runtime::StepRun]) -> Vec<&str> {
    steps.iter().map(|step| step.step_id.as_str()).collect()
}

fn step_run<'a>(
    steps: &'a [runx_runtime::StepRun],
    step_id: &str,
) -> Result<&'a runx_runtime::StepRun, std::io::Error> {
    steps
        .iter()
        .find(|step| step.step_id == step_id)
        .ok_or_else(|| std::io::Error::other(format!("missing step {step_id}")))
}

fn approval_value(step: &runx_runtime::StepRun, field: &str) -> Result<JsonValue, std::io::Error> {
    let payment_approval = object_field(&step.outputs, "payment_approval")?;
    let data = object_field(payment_approval, "data")?;
    data.get(field)
        .cloned()
        .ok_or_else(|| std::io::Error::other(format!("missing payment_approval.data.{field}")))
}

fn object_field<'a>(object: &'a JsonObject, field: &str) -> Result<&'a JsonObject, std::io::Error> {
    match object.get(field) {
        Some(JsonValue::Object(value)) => Ok(value),
        Some(_) => Err(std::io::Error::other(format!("{field} is not an object"))),
        None => Err(std::io::Error::other(format!("{field} is missing"))),
    }
}
