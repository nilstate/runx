// Module rationale: the x402 payment ledger projection,
// idempotent local event append, and receipt artifact assembly remain one
// audited boundary until the payment state modules are split.
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use runx_contracts::{ClosureDisposition, Receipt, Reference, sha256_prefixed};
use serde::{Deserialize, Serialize};
use serde_json::{self, Value as JsonWireValue, json};
use thiserror::Error;

use runx_runtime::StepRun;

use crate::packets::{
    PaymentPacketError, read_effect_evidence_packet, read_paid_tool_packet,
    read_payment_refusal_packet, read_payment_reservation_packet,
};
use crate::supervisor::{
    PaymentSupervisorProof, PaymentSupervisorProofMatch, is_payment_rail_proof_ref,
    payment_supervisor_proof_from_metadata, validate_payment_supervisor_proof,
};

pub const PAYMENT_LEDGER_PROJECTION_SCHEMA_VERSION: &str = "runx.payment_ledger_projection.v1";
pub const X402_PAY_PAYMENT_PROFILE: &str = "x402-pay";
pub const PAYMENT_LEDGER_PROJECTED_EVENT_KIND: &str = "payment_ledger_projected";
pub const PAYMENT_LEDGER_EVENT_LEDGER_DIR: &str = "ledgers";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentLedgerProjection {
    pub schema_version: String,
    pub payment_profile: String,
    pub scenario_id: String,
    pub source_receipt_id: String,
    pub disposition: PaymentLedgerDisposition,
    pub accrual: PaymentLedgerAccrual,
    pub refusal: Option<PaymentLedgerRefusal>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentLedgerProjectionArtifact {
    pub artifact_id: String,
    pub artifact_type: String,
    pub path: PathBuf,
    pub event_payload: PaymentLedgerProjectedEventPayload,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentLedgerRuntimeEvent {
    pub ledger_path: PathBuf,
    pub artifact: PaymentLedgerProjectionArtifact,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentLedgerProjectedEventPayload {
    pub kind: String,
    pub payment_profile: String,
    pub projection_artifact_id: String,
    pub projection_artifact_path: String,
    pub source_receipt_id: String,
    pub scenario_id: String,
    pub disposition: PaymentLedgerDisposition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentLedgerDisposition {
    Settled,
    Refused,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentLedgerAccrual {
    pub amount_minor: u64,
    pub currency: String,
    pub rail: String,
    pub counterparty: String,
    pub operation: String,
    pub idempotency_key: String,
    pub rail_proof_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentLedgerRefusal {
    pub reason_code: String,
    pub refused_stage: String,
    pub rail_call_performed: bool,
    pub ledger_spend_recorded: bool,
}

#[derive(Clone, Debug)]
pub struct PaymentLedgerProjectionInput<'a> {
    pub graph_receipt: &'a Receipt,
    pub scenario_id: &'a str,
    pub evidence: Vec<PaymentLedgerEvidence<'a>>,
}

#[derive(Clone, Debug)]
pub struct PaymentLedgerEvidence<'a> {
    pub receipt: &'a Receipt,
    pub packet: PaymentLedgerEvidencePacket,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentLedgerEvidencePacket {
    Reservation(PaymentReservationEvidence),
    RailSettlement(Box<PaymentRailSettlementEvidence>),
    Refusal(PaymentRefusalEvidence),
    PaidTool(PaidToolEvidence),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentReservationEvidence {
    pub amount_minor: u64,
    pub currency: String,
    pub rail: String,
    pub counterparty: String,
    pub operation: String,
    pub idempotency_key: String,
    pub spend_capability_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRailSettlementEvidence {
    pub amount_minor: u64,
    pub currency: String,
    pub rail: String,
    pub proof_ref: String,
    pub idempotency_key: String,
    pub supervisor_proof: Option<PaymentSupervisorProof>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRefusalEvidence {
    pub reason_code: String,
    pub refused_stage: String,
    pub rail_call_performed: bool,
    pub ledger_spend_recorded: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaidToolEvidence {
    pub payment_proof_ref: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PaymentLedgerProjectionError {
    #[error("payment ledger projection requires at least one reservation evidence packet")]
    MissingReservation,
    #[error("payment ledger projection requires a rail settlement or refusal evidence packet")]
    MissingDispositionEvidence,
    #[error(
        "settlement evidence proof ref {proof_ref} is not present as a typed payment rail proof on receipt {receipt_id}"
    )]
    MissingReceiptRailProof {
        receipt_id: String,
        proof_ref: String,
    },
    #[error("settlement evidence proof ref {proof_ref} is missing supervisor proof")]
    MissingSupervisorProof { proof_ref: String },
    #[error("settlement evidence supervisor proof mismatch: {message}")]
    SupervisorProofMismatch { message: String },
    #[error("paid tool evidence proof ref {proof_ref} has no matching settlement proof")]
    PaidToolProofMismatch { proof_ref: String },
    #[error(
        "child receipt {child_receipt_id} is not referenced by graph receipt {graph_receipt_id}"
    )]
    ChildReceiptNotReferenced {
        graph_receipt_id: String,
        child_receipt_id: String,
    },
    #[error("settlement evidence does not match reservation evidence")]
    SettlementReservationMismatch,
    #[error("payment ledger projection source receipt id {source_receipt_id} is not a receipt ref")]
    InvalidSourceReceiptId { source_receipt_id: String },
    #[error("payment ledger projection artifact already exists with different contents at {path}")]
    ArtifactConflict { path: PathBuf },
    #[error("payment ledger projection artifact I/O failed at {path}: {message}")]
    ArtifactIo { path: PathBuf, message: String },
    #[error("payment ledger projection artifact JSON failed at {path}: {message}")]
    ArtifactJson { path: PathBuf, message: String },
    #[error("payment ledger projection evidence is missing {field}")]
    MissingEvidenceField { field: &'static str },
    #[error("payment ledger projection evidence field {field} has an invalid value")]
    InvalidEvidenceField { field: &'static str },
    #[error("payment ledger projection run id {run_id} is not safe for a local ledger file")]
    InvalidRunLedgerId { run_id: String },
    #[error("payment ledger projection event already exists with different contents at {path}")]
    LedgerEventConflict { path: PathBuf },
    #[error("payment ledger projection event I/O failed at {path}: {message}")]
    LedgerEventIo { path: PathBuf, message: String },
    #[error("payment ledger projection event JSON failed at {path}: {message}")]
    LedgerEventJson { path: PathBuf, message: String },
}

impl From<PaymentPacketError> for PaymentLedgerProjectionError {
    fn from(error: PaymentPacketError) -> Self {
        match error {
            PaymentPacketError::MissingField { field } => Self::MissingEvidenceField { field },
            PaymentPacketError::InvalidField { field } => Self::InvalidEvidenceField { field },
        }
    }
}

// Function rationale: the projection validates reservation,
// settlement/refusal evidence, child receipts, and accrual in one audited pass.
pub fn build_payment_ledger_projection(
    input: PaymentLedgerProjectionInput<'_>,
) -> Result<PaymentLedgerProjection, PaymentLedgerProjectionError> {
    validate_child_receipts(input.graph_receipt, &input.evidence)?;

    let reservation = input
        .evidence
        .iter()
        .find_map(|evidence| match &evidence.packet {
            PaymentLedgerEvidencePacket::Reservation(reservation) => Some(reservation),
            _ => None,
        })
        .ok_or(PaymentLedgerProjectionError::MissingReservation)?;

    let refusal = input
        .evidence
        .iter()
        .find_map(|evidence| match &evidence.packet {
            PaymentLedgerEvidencePacket::Refusal(refusal) => Some(refusal),
            _ => None,
        });

    let settlement = input
        .evidence
        .iter()
        .find_map(|evidence| match &evidence.packet {
            PaymentLedgerEvidencePacket::RailSettlement(settlement) => {
                Some((evidence, settlement.as_ref()))
            }
            _ => None,
        });

    let (disposition, accrual, refusal) = if let Some(refusal) = refusal {
        (
            PaymentLedgerDisposition::Refused,
            refused_accrual(reservation),
            Some(PaymentLedgerRefusal {
                reason_code: refusal.reason_code.clone(),
                refused_stage: refusal.refused_stage.clone(),
                rail_call_performed: refusal.rail_call_performed,
                ledger_spend_recorded: refusal.ledger_spend_recorded,
            }),
        )
    } else if let Some((evidence, settlement)) = settlement {
        validate_settlement_matches_reservation(reservation, settlement)?;
        let act_id = validate_receipt_rail_proof(evidence.receipt, settlement)?;
        validate_settlement_supervisor_proof(reservation, evidence.receipt, settlement, &act_id)?;
        validate_paid_tool_refs(&input.evidence, &settlement.proof_ref)?;
        (
            PaymentLedgerDisposition::Settled,
            PaymentLedgerAccrual {
                amount_minor: settlement.amount_minor,
                currency: settlement.currency.clone(),
                rail: settlement.rail.clone(),
                counterparty: reservation.counterparty.clone(),
                operation: reservation.operation.clone(),
                idempotency_key: settlement.idempotency_key.clone(),
                rail_proof_refs: vec![settlement.proof_ref.clone()],
            },
            None,
        )
    } else {
        return Err(PaymentLedgerProjectionError::MissingDispositionEvidence);
    };

    Ok(PaymentLedgerProjection {
        schema_version: PAYMENT_LEDGER_PROJECTION_SCHEMA_VERSION.to_owned(),
        payment_profile: X402_PAY_PAYMENT_PROFILE.to_owned(),
        scenario_id: input.scenario_id.to_owned(),
        source_receipt_id: receipt_ref(input.graph_receipt),
        disposition,
        accrual,
        refusal,
        evidence_refs: evidence_refs(&input.evidence),
    })
}

// Function rationale: artifact path derivation, JSON
// serialization, hashing, and reference construction must stay byte-aligned.
pub fn write_payment_ledger_projection_artifact(
    receipt_dir: impl AsRef<Path>,
    projection: &PaymentLedgerProjection,
) -> Result<PaymentLedgerProjectionArtifact, PaymentLedgerProjectionError> {
    let receipt_id = source_receipt_file_stem(&projection.source_receipt_id)?;
    let artifact_id = format!(
        "{}:{}",
        projection.payment_profile, projection.source_receipt_id
    );
    let artifact_dir = receipt_dir
        .as_ref()
        .join("artifacts")
        .join("payment-ledger")
        .join(&projection.payment_profile);
    let artifact_path = artifact_dir.join(format!("{receipt_id}.json"));
    let mut contents = serde_json::to_vec_pretty(projection).map_err(|source| {
        PaymentLedgerProjectionError::ArtifactJson {
            path: artifact_path.clone(),
            message: source.to_string(),
        }
    })?;
    contents.push(b'\n');

    fs::create_dir_all(&artifact_dir).map_err(|source| {
        PaymentLedgerProjectionError::ArtifactIo {
            path: artifact_dir.clone(),
            message: source.to_string(),
        }
    })?;

    if artifact_path.exists() {
        let existing = fs::read(&artifact_path).map_err(|source| {
            PaymentLedgerProjectionError::ArtifactIo {
                path: artifact_path.clone(),
                message: source.to_string(),
            }
        })?;
        if existing != contents {
            return Err(PaymentLedgerProjectionError::ArtifactConflict {
                path: artifact_path,
            });
        }
    } else {
        fs::write(&artifact_path, &contents).map_err(|source| {
            PaymentLedgerProjectionError::ArtifactIo {
                path: artifact_path.clone(),
                message: source.to_string(),
            }
        })?;
    }

    let projection_artifact_path = artifact_path.to_string_lossy().into_owned();
    Ok(PaymentLedgerProjectionArtifact {
        artifact_id: artifact_id.clone(),
        artifact_type: PAYMENT_LEDGER_PROJECTION_SCHEMA_VERSION.to_owned(),
        path: artifact_path,
        event_payload: PaymentLedgerProjectedEventPayload {
            kind: PAYMENT_LEDGER_PROJECTED_EVENT_KIND.to_owned(),
            payment_profile: projection.payment_profile.clone(),
            projection_artifact_id: artifact_id,
            projection_artifact_path,
            source_receipt_id: projection.source_receipt_id.clone(),
            scenario_id: projection.scenario_id.clone(),
            disposition: projection.disposition.clone(),
        },
    })
}

pub fn persist_x402_payment_ledger_projection_event(
    receipt_dir: impl AsRef<Path>,
    run_id: &str,
    created_at: &str,
    graph_receipt: &Receipt,
    steps: &[StepRun],
    scenario_id: &str,
) -> Result<Option<PaymentLedgerRuntimeEvent>, PaymentLedgerProjectionError> {
    if !matches!(
        graph_receipt.seal.disposition,
        ClosureDisposition::Closed | ClosureDisposition::Blocked
    ) || !steps.iter().any(has_payment_reservation_packet)
    {
        return Ok(None);
    }
    let projection =
        build_x402_payment_ledger_projection_from_steps(graph_receipt, steps, scenario_id)?;
    let artifact = write_payment_ledger_projection_artifact(&receipt_dir, &projection)?;
    let ledger_path = append_payment_ledger_projected_event(
        receipt_dir,
        run_id,
        created_at,
        &artifact.event_payload,
    )?;
    Ok(Some(PaymentLedgerRuntimeEvent {
        ledger_path,
        artifact,
    }))
}

pub fn build_x402_payment_ledger_projection_from_steps(
    graph_receipt: &Receipt,
    steps: &[StepRun],
    scenario_id: &str,
) -> Result<PaymentLedgerProjection, PaymentLedgerProjectionError> {
    let mut evidence = Vec::new();
    for step in steps {
        if let Some(reservation) = reservation_evidence(step)? {
            evidence.push(PaymentLedgerEvidence {
                receipt: &step.receipt,
                packet: PaymentLedgerEvidencePacket::Reservation(reservation),
            });
        }
        if let Some(settlement) = settlement_evidence(step)? {
            evidence.push(PaymentLedgerEvidence {
                receipt: &step.receipt,
                packet: PaymentLedgerEvidencePacket::RailSettlement(Box::new(settlement)),
            });
        }
        if let Some(refusal) = refusal_evidence(step)? {
            evidence.push(PaymentLedgerEvidence {
                receipt: &step.receipt,
                packet: PaymentLedgerEvidencePacket::Refusal(refusal),
            });
        }
        if let Some(paid_tool) = paid_tool_evidence(step)? {
            evidence.push(PaymentLedgerEvidence {
                receipt: &step.receipt,
                packet: PaymentLedgerEvidencePacket::PaidTool(paid_tool),
            });
        }
    }
    build_payment_ledger_projection(PaymentLedgerProjectionInput {
        graph_receipt,
        scenario_id,
        evidence,
    })
}

// Function rationale: append is the idempotency boundary:
// read existing events, compare semantic identity, reject conflicts, then write.
pub fn append_payment_ledger_projected_event(
    receipt_dir: impl AsRef<Path>,
    run_id: &str,
    created_at: &str,
    payload: &PaymentLedgerProjectedEventPayload,
) -> Result<PathBuf, PaymentLedgerProjectionError> {
    validate_run_ledger_id(run_id)?;
    let ledger_dir = receipt_dir.as_ref().join(PAYMENT_LEDGER_EVENT_LEDGER_DIR);
    let ledger_path = ledger_dir.join(format!("{run_id}.jsonl"));
    let payload_bytes = serde_json::to_vec(payload).map_err(|source| {
        PaymentLedgerProjectionError::LedgerEventJson {
            path: ledger_path.clone(),
            message: source.to_string(),
        }
    })?;
    let record = payment_ledger_projected_record(run_id, created_at, payload, &payload_bytes);
    let line = serde_json::to_vec(&record).map_err(|source| {
        PaymentLedgerProjectionError::LedgerEventJson {
            path: ledger_path.clone(),
            message: source.to_string(),
        }
    })?;

    if ledger_path.exists() {
        let contents = fs::read_to_string(&ledger_path).map_err(|source| {
            PaymentLedgerProjectionError::LedgerEventIo {
                path: ledger_path.clone(),
                message: source.to_string(),
            }
        })?;
        for line in contents
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let existing = serde_json::from_str::<JsonWireValue>(line).map_err(|source| {
                PaymentLedgerProjectionError::LedgerEventJson {
                    path: ledger_path.clone(),
                    message: source.to_string(),
                }
            })?;
            if is_same_payment_ledger_event(&existing, payload) {
                if existing == record {
                    return Ok(ledger_path);
                }
                return Err(PaymentLedgerProjectionError::LedgerEventConflict {
                    path: ledger_path,
                });
            }
        }
    } else {
        fs::create_dir_all(&ledger_dir).map_err(|source| {
            PaymentLedgerProjectionError::LedgerEventIo {
                path: ledger_dir.clone(),
                message: source.to_string(),
            }
        })?;
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ledger_path)
        .map_err(|source| PaymentLedgerProjectionError::LedgerEventIo {
            path: ledger_path.clone(),
            message: source.to_string(),
        })?;
    file.write_all(&line)
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|source| PaymentLedgerProjectionError::LedgerEventIo {
            path: ledger_path.clone(),
            message: source.to_string(),
        })?;
    Ok(ledger_path)
}

fn refused_accrual(reservation: &PaymentReservationEvidence) -> PaymentLedgerAccrual {
    PaymentLedgerAccrual {
        amount_minor: 0,
        currency: reservation.currency.clone(),
        rail: reservation.rail.clone(),
        counterparty: reservation.counterparty.clone(),
        operation: reservation.operation.clone(),
        idempotency_key: reservation.idempotency_key.clone(),
        rail_proof_refs: Vec::new(),
    }
}

fn validate_child_receipts(
    graph_receipt: &Receipt,
    evidence: &[PaymentLedgerEvidence<'_>],
) -> Result<(), PaymentLedgerProjectionError> {
    let empty = Vec::new();
    let graph_child_receipts = graph_receipt
        .lineage
        .as_ref()
        .map_or(&empty, |lineage| &lineage.children)
        .iter()
        .map(|reference| reference.uri.as_str())
        .collect::<HashSet<_>>();
    for evidence in evidence {
        let child_ref = receipt_ref(evidence.receipt);
        if !graph_child_receipts.contains(child_ref.as_str()) {
            return Err(PaymentLedgerProjectionError::ChildReceiptNotReferenced {
                graph_receipt_id: graph_receipt.id.to_string(),
                child_receipt_id: evidence.receipt.id.to_string(),
            });
        }
    }
    Ok(())
}

fn validate_settlement_matches_reservation(
    reservation: &PaymentReservationEvidence,
    settlement: &PaymentRailSettlementEvidence,
) -> Result<(), PaymentLedgerProjectionError> {
    if reservation.amount_minor == settlement.amount_minor
        && reservation.currency == settlement.currency
        && reservation.rail == settlement.rail
        && reservation.idempotency_key == settlement.idempotency_key
    {
        Ok(())
    } else {
        Err(PaymentLedgerProjectionError::SettlementReservationMismatch)
    }
}

fn validate_receipt_rail_proof(
    receipt: &Receipt,
    settlement: &PaymentRailSettlementEvidence,
) -> Result<String, PaymentLedgerProjectionError> {
    let act_id = receipt
        .acts
        .iter()
        .find(|act| {
            act.criterion_bindings
                .iter()
                .flat_map(|criterion| criterion.verification_refs.iter())
                .any(|reference| is_matching_payment_rail_proof(reference, settlement))
        })
        .map(|act| act.id.to_string())
        .ok_or_else(|| PaymentLedgerProjectionError::MissingReceiptRailProof {
            receipt_id: receipt.id.to_string(),
            proof_ref: settlement.proof_ref.clone(),
        })?;
    Ok(act_id)
}

fn is_matching_payment_rail_proof(
    reference: &Reference,
    settlement: &PaymentRailSettlementEvidence,
) -> bool {
    is_payment_rail_proof_ref(reference)
        && reference.uri == settlement.proof_ref
        && reference.locator.as_deref() == Some(settlement.idempotency_key.as_str())
}

fn validate_paid_tool_refs(
    evidence: &[PaymentLedgerEvidence<'_>],
    proof_ref: &str,
) -> Result<(), PaymentLedgerProjectionError> {
    for evidence in evidence {
        if let PaymentLedgerEvidencePacket::PaidTool(paid_tool) = &evidence.packet
            && paid_tool.payment_proof_ref != proof_ref
        {
            return Err(PaymentLedgerProjectionError::PaidToolProofMismatch {
                proof_ref: paid_tool.payment_proof_ref.clone(),
            });
        }
    }
    Ok(())
}

fn validate_settlement_supervisor_proof(
    reservation: &PaymentReservationEvidence,
    receipt: &Receipt,
    settlement: &PaymentRailSettlementEvidence,
    act_id: &str,
) -> Result<(), PaymentLedgerProjectionError> {
    let proof = settlement.supervisor_proof.as_ref().ok_or_else(|| {
        PaymentLedgerProjectionError::MissingSupervisorProof {
            proof_ref: settlement.proof_ref.clone(),
        }
    })?;
    validate_payment_supervisor_proof(
        proof,
        PaymentSupervisorProofMatch {
            proof_ref: &settlement.proof_ref,
            rail: &settlement.rail,
            counterparty: &reservation.counterparty,
            amount_minor: settlement.amount_minor,
            currency: &settlement.currency,
            idempotency_key: &settlement.idempotency_key,
            spend_capability_ref: &reservation.spend_capability_ref,
            act_id,
            receipt_ref: &receipt.id,
            receipt_digest: &receipt.digest,
        },
    )
    .map_err(
        |source| PaymentLedgerProjectionError::SupervisorProofMismatch {
            message: source.to_string(),
        },
    )
}

fn evidence_refs(evidence: &[PaymentLedgerEvidence<'_>]) -> Vec<String> {
    let mut refs = Vec::new();
    for evidence in evidence {
        if matches!(
            evidence.packet,
            PaymentLedgerEvidencePacket::RailSettlement(_)
                | PaymentLedgerEvidencePacket::Refusal(_)
        ) {
            push_unique(
                &mut refs,
                evidence.receipt.subject.reference.uri.clone().into_string(),
            );
            push_unique(&mut refs, receipt_ref(evidence.receipt));
        }
    }
    for evidence in evidence {
        if let PaymentLedgerEvidencePacket::Reservation(reservation) = &evidence.packet {
            push_unique(&mut refs, reservation.spend_capability_ref.clone());
        }
    }
    refs
}

fn receipt_ref(receipt: &Receipt) -> String {
    format!("runx:receipt:{}", receipt.id)
}

fn source_receipt_file_stem(source_receipt_id: &str) -> Result<&str, PaymentLedgerProjectionError> {
    const PREFIX: &str = "runx:receipt:";
    let Some(receipt_id) = source_receipt_id.strip_prefix(PREFIX) else {
        return Err(PaymentLedgerProjectionError::InvalidSourceReceiptId {
            source_receipt_id: source_receipt_id.to_owned(),
        });
    };
    // Content-addressed ids are `sha256:<hex>`, so the `:` separator is allowed
    // alongside the legacy `_`/`-` identifier characters; path separators are not.
    if receipt_id.is_empty()
        || !receipt_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ':')
        })
    {
        return Err(PaymentLedgerProjectionError::InvalidSourceReceiptId {
            source_receipt_id: source_receipt_id.to_owned(),
        });
    }
    Ok(receipt_id)
}

fn push_unique(refs: &mut Vec<String>, reference: String) {
    if !refs.contains(&reference) {
        refs.push(reference);
    }
}

fn has_payment_reservation_packet(step: &StepRun) -> bool {
    with_step_outputs(step, |outputs| {
        Ok(read_payment_reservation_packet(outputs)?.map(|_| ()))
    })
    .ok()
    .flatten()
    .is_some()
}

fn reservation_evidence(
    step: &StepRun,
) -> Result<Option<PaymentReservationEvidence>, PaymentLedgerProjectionError> {
    with_step_outputs(step, |outputs| {
        let Some(packet) = read_payment_reservation_packet(outputs)? else {
            return Ok(None);
        };
        Ok(Some(PaymentReservationEvidence {
            amount_minor: packet.amount_minor,
            currency: packet.currency,
            rail: packet.rail,
            counterparty: packet.counterparty,
            operation: packet.operation,
            idempotency_key: packet.idempotency_key,
            spend_capability_ref: packet.spend_capability_ref,
        }))
    })
}

fn settlement_evidence(
    step: &StepRun,
) -> Result<Option<PaymentRailSettlementEvidence>, PaymentLedgerProjectionError> {
    with_step_outputs(step, |outputs| {
        let Some(packet) = read_effect_evidence_packet(outputs)? else {
            return Ok(None);
        };
        let Some(proof) = packet.proof else {
            return Ok(None);
        };
        let result = packet
            .result
            .ok_or(PaymentLedgerProjectionError::MissingEvidenceField {
                field: "effect_evidence_packet.data.rail_result",
            })?;
        Ok(Some(PaymentRailSettlementEvidence {
            amount_minor: result.amount_minor.ok_or(
                PaymentLedgerProjectionError::MissingEvidenceField {
                    field: "rail_result.amount_minor",
                },
            )?,
            currency: result.currency.ok_or(
                PaymentLedgerProjectionError::MissingEvidenceField {
                    field: "rail_result.currency",
                },
            )?,
            rail: result
                .rail
                .ok_or(PaymentLedgerProjectionError::MissingEvidenceField {
                    field: "rail_result.rail",
                })?,
            proof_ref: proof.proof_ref,
            idempotency_key: proof.idempotency_key,
            supervisor_proof: payment_supervisor_proof_from_metadata(&step.outcome.metadata)
                .map_err(
                    |source| PaymentLedgerProjectionError::SupervisorProofMismatch {
                        message: source.to_string(),
                    },
                )?,
        }))
    })
}

fn refusal_evidence(
    step: &StepRun,
) -> Result<Option<PaymentRefusalEvidence>, PaymentLedgerProjectionError> {
    with_step_outputs(step, |outputs| {
        let Some(refusal) = read_payment_refusal_packet(outputs)? else {
            return Ok(None);
        };
        Ok(Some(PaymentRefusalEvidence {
            reason_code: refusal.reason_code,
            refused_stage: step.step_id.clone(),
            rail_call_performed: refusal.rail_call_performed,
            ledger_spend_recorded: refusal.ledger_spend_recorded,
        }))
    })
}

fn paid_tool_evidence(
    step: &StepRun,
) -> Result<Option<PaidToolEvidence>, PaymentLedgerProjectionError> {
    with_step_outputs(step, |outputs| {
        let Some(packet) = read_paid_tool_packet(outputs)? else {
            return Ok(None);
        };
        Ok(Some(PaidToolEvidence {
            payment_proof_ref: packet.payment_proof_ref,
        }))
    })
}

fn with_step_outputs<T>(
    step: &StepRun,
    extract: impl Fn(&runx_contracts::JsonObject) -> Result<Option<T>, PaymentLedgerProjectionError>,
) -> Result<Option<T>, PaymentLedgerProjectionError> {
    extract(&step.contract)
}

fn validate_run_ledger_id(run_id: &str) -> Result<(), PaymentLedgerProjectionError> {
    if !run_id.is_empty()
        && run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        Ok(())
    } else {
        Err(PaymentLedgerProjectionError::InvalidRunLedgerId {
            run_id: run_id.to_owned(),
        })
    }
}

fn payment_ledger_projected_record(
    run_id: &str,
    created_at: &str,
    payload: &PaymentLedgerProjectedEventPayload,
    payload_bytes: &[u8],
) -> JsonWireValue {
    json!({
        "entry": {
            "type": "run_event",
            "version": "1",
            "data": {
                "kind": PAYMENT_LEDGER_PROJECTED_EVENT_KIND,
                "status": "completed",
                "step_id": null,
                "detail": payload
            },
            "meta": {
                "artifact_id": format!("ax_payment_ledger_projected_{}", sha256_prefixed(payload.source_receipt_id.as_bytes()).trim_start_matches("sha256:")),
                "run_id": run_id,
                "step_id": null,
                "producer": {
                    "skill": X402_PAY_PAYMENT_PROFILE,
                    "runner": "graph"
                },
                "created_at": created_at,
                "hash": sha256_prefixed(payload_bytes),
                "size_bytes": payload_bytes.len(),
                "parent_artifact_id": payload.projection_artifact_id,
                "receipt_id": payload.source_receipt_id,
                "redacted": false
            }
        }
    })
}

fn is_same_payment_ledger_event(
    record: &JsonWireValue,
    payload: &PaymentLedgerProjectedEventPayload,
) -> bool {
    let entry = &record["entry"];
    entry["type"].as_str() == Some("run_event")
        && entry["data"]["kind"].as_str() == Some(PAYMENT_LEDGER_PROJECTED_EVENT_KIND)
        && entry["data"]["detail"]["source_receipt_id"].as_str()
            == Some(payload.source_receipt_id.as_str())
        && entry["data"]["detail"]["projection_artifact_id"].as_str()
            == Some(payload.projection_artifact_id.as_str())
}
