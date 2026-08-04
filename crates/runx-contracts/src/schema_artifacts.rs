//! Published JSON Schema artifact manifest.
//!
//! This is the authoritative Rust-side list consumed by the schema generation
//! gate. Keep filenames aligned with `oss/schemas/*.json`.
use serde_json as schema_json;

use crate::schema::RunxSchema;
use crate::{
    Act, ActAssignment, ActResultEnvelope, AgentActInvocation, AgentContextEnvelope,
    ApprovalDecisionPacket, ApprovalGate, Artifact, Authority, AuthorityProof,
    AuthoritySubsetProof, AuthorityTerm, CredentialDeliveryObservation, CredentialDeliveryProfile,
    CredentialDeliveryRequest, CredentialDeliveryResponse, CredentialEnvelope, DataOperationResult,
    Decision, DevReport, DoctorReport, EffectFinalityReceipt, ExternalAdapterCancellationFrame,
    ExternalAdapterCredentialRequest, ExternalAdapterHostResolutionFrame,
    ExternalAdapterInvocation, ExternalAdapterManifest, ExternalAdapterResponse, Fixture,
    GitBlobDigest, HandoffSignal, HandoffState, LedgerEntry, LocalArtifact, LocalArtifactPage,
    OperationalPolicy, OperationalProposal, OrchestratorExecutionContext,
    OrchestratorHandoffContext, Output, PacketIndex, Question, Receipt, Redaction, Reference,
    ReferenceLink, RegistryBinding, ResolutionRequest, ResolutionResponse, ReviewReceiptOutput,
    RunSummary, RunxListReport, ScopeAdmission, Signal, SkillApplyResult,
    SkillArchitectureDecision, SkillArchitecturePlan, SkillChangeBundle, SkillChangeDraft,
    SkillValidationResult, SourcePacket, SuppressionRecord, ThreadOutboxProviderFetch,
    ThreadOutboxProviderManifest, ThreadOutboxProviderObservation, ThreadOutboxProviderPush,
    ToolManifest, Verification,
};

#[derive(Clone, Debug, PartialEq)]
pub struct SchemaArtifact {
    pub file_name: &'static str,
    pub schema: schema_json::Value,
}

#[must_use]
// Function rationale: the artifact manifest is deliberately one
// ordered list so the published schema set is auditable against `oss/schemas`.
pub fn generated_schema_artifacts() -> Vec<SchemaArtifact> {
    vec![
        schema_artifact::<Output>("output.schema.json"),
        schema_artifact::<AgentContextEnvelope>("agent-context-envelope.schema.json"),
        schema_artifact::<AgentActInvocation>("agent-act-invocation.schema.json"),
        schema_artifact::<Question>("question.schema.json"),
        schema_artifact::<ApprovalGate>("approval-gate.schema.json"),
        schema_artifact::<ResolutionRequest>("resolution-request.schema.json"),
        schema_artifact::<ResolutionResponse>("resolution-response.schema.json"),
        schema_artifact::<ActResultEnvelope>("act-result.schema.json"),
        schema_artifact::<CredentialEnvelope>("credential-envelope.schema.json"),
        schema_artifact::<ScopeAdmission>("scope-admission.schema.json"),
        schema_artifact::<AuthorityProof>("authority-proof.schema.json"),
        schema_artifact::<CredentialDeliveryProfile>("credential-delivery-profile.schema.json"),
        schema_artifact::<CredentialDeliveryRequest>("credential-delivery-request.schema.json"),
        schema_artifact::<CredentialDeliveryResponse>("credential-delivery-response.schema.json"),
        schema_artifact::<CredentialDeliveryObservation>(
            "credential-delivery-observation.schema.json",
        ),
        schema_artifact::<ThreadOutboxProviderManifest>(
            "thread-outbox-provider-manifest.schema.json",
        ),
        schema_artifact::<ThreadOutboxProviderPush>("thread-outbox-provider-push.schema.json"),
        schema_artifact::<ThreadOutboxProviderFetch>("thread-outbox-provider-fetch.schema.json"),
        schema_artifact::<ThreadOutboxProviderObservation>(
            "thread-outbox-provider-observation.schema.json",
        ),
        schema_artifact::<DoctorReport>("doctor.schema.json"),
        schema_artifact::<DevReport>("dev.schema.json"),
        schema_artifact::<RunxListReport>("list.schema.json"),
        schema_artifact::<RunSummary>("run-summary.schema.json"),
        schema_artifact::<SkillArchitectureDecision>("skill-architecture-decision.schema.json"),
        public_packet_artifact::<SkillArchitecturePlan>("skill-architecture-plan.schema.json"),
        schema_artifact::<SkillChangeDraft>("skill-change-draft.schema.json"),
        public_packet_artifact::<SkillChangeBundle>("skill-change-bundle.schema.json"),
        public_packet_artifact::<SkillValidationResult>("skill-validation-result.schema.json"),
        public_packet_artifact::<SkillApplyResult>("skill-apply-result.schema.json"),
        schema_artifact::<Fixture>("fixture.schema.json"),
        schema_artifact::<ToolManifest>("tool-manifest.schema.json"),
        schema_artifact::<PacketIndex>("packet-index.schema.json"),
        public_packet_artifact::<LocalArtifact>("local-artifact.schema.json"),
        public_packet_artifact::<LocalArtifactPage>("local-artifact-page.schema.json"),
        public_packet_artifact::<GitBlobDigest>("git-blob-digest.schema.json"),
        public_packet_artifact::<DataOperationResult>("data-operation-result.schema.json"),
        public_packet_artifact::<ApprovalDecisionPacket>("approval-decision.schema.json"),
        schema_artifact::<ActAssignment>("act-assignment.schema.json"),
        schema_artifact::<ExternalAdapterManifest>("external-adapter-manifest.schema.json"),
        schema_artifact::<ExternalAdapterInvocation>("external-adapter-invocation.schema.json"),
        schema_artifact::<ExternalAdapterResponse>("external-adapter-response.schema.json"),
        schema_artifact::<ExternalAdapterHostResolutionFrame>(
            "external-adapter-host-resolution.schema.json",
        ),
        schema_artifact::<ExternalAdapterCancellationFrame>(
            "external-adapter-cancellation.schema.json",
        ),
        schema_artifact::<ExternalAdapterCredentialRequest>(
            "external-adapter-credential-request.schema.json",
        ),
        schema_artifact::<Reference>("reference.schema.json"),
        schema_artifact::<ReferenceLink>("reference-link.schema.json"),
        schema_artifact::<Authority>("authority.schema.json"),
        public_packet_artifact::<AuthorityTerm>("authority-term.schema.json"),
        schema_artifact::<AuthoritySubsetProof>("authority-subset-proof.schema.json"),
        schema_artifact::<Signal>("signal.schema.json"),
        schema_artifact::<SourcePacket>("source-packet.schema.json"),
        schema_artifact::<Decision>("decision.schema.json"),
        schema_artifact::<Act>("act.schema.json"),
        schema_artifact::<Verification>("verification.schema.json"),
        schema_artifact::<Receipt>("receipt.schema.json"),
        schema_artifact::<EffectFinalityReceipt>("effect-finality-receipt.schema.json"),
        schema_artifact::<Artifact>("artifact.schema.json"),
        schema_artifact::<Redaction>("redaction.schema.json"),
        schema_artifact::<LedgerEntry>("ledger-entry.schema.json"),
        schema_artifact::<HandoffSignal>("handoff-signal.schema.json"),
        schema_artifact::<HandoffState>("handoff-state.schema.json"),
        schema_artifact::<SuppressionRecord>("suppression-record.schema.json"),
        schema_artifact::<OperationalPolicy>("operational-policy.schema.json"),
        schema_artifact::<OperationalProposal>("operational-proposal.schema.json"),
        public_packet_artifact::<OrchestratorExecutionContext>(
            "orchestrator-execution-context.schema.json",
        ),
        public_packet_artifact::<OrchestratorHandoffContext>(
            "orchestrator-handoff-context.schema.json",
        ),
        schema_artifact::<RegistryBinding>("registry-binding.schema.json"),
        schema_artifact::<ReviewReceiptOutput>("review-receipt-output.schema.json"),
    ]
}

pub fn schema_artifact<T: RunxSchema>(file_name: &'static str) -> SchemaArtifact {
    SchemaArtifact {
        file_name,
        schema: T::json_schema(),
    }
}

/// Mark a reusable, named boundary contract for packet distribution even when
/// its immediate producer is native rather than a skill manifest. Runner-local
/// input and output shapes must stay in `X.yaml` and use [`schema_artifact`]
/// instead.
pub fn public_packet_artifact<T: RunxSchema>(file_name: &'static str) -> SchemaArtifact {
    let mut artifact = schema_artifact::<T>(file_name);
    if let schema_json::Value::Object(schema) = &mut artifact.schema {
        schema.insert("x-runx-packet".to_owned(), schema_json::Value::Bool(true));
    } else {
        let schema = std::mem::replace(&mut artifact.schema, schema_json::Value::Null);
        artifact.schema = schema_json::json!({
            "allOf": [schema],
            "x-runx-packet": true,
        });
    }
    artifact
}
