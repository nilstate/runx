//! Shared Rust contract types for runx JSON and protocol boundaries.

// Lets the `#[derive(RunxSchema)]` output reference `::runx_contracts::schema`
// from inside this crate, the same way serde_derive references `::serde`.
extern crate self as runx_contracts;

pub mod act;
pub mod agent_context;
pub mod artifact;
pub mod authority;
pub mod cli;
pub mod credential_delivery;
pub mod decision;
pub mod dev;
pub mod doctor;
pub mod execution;
pub mod external_adapter;
pub mod fingerprint;
pub mod fixture;
pub mod handoff;
pub mod host_protocol;
pub mod json;
pub mod ledger;
pub mod links;
pub mod list;
pub mod maturity;
pub mod operational_policy;
pub mod operational_proposal;
pub mod output;
pub mod packet_index;
pub mod policy_proof;
pub mod receipt;
pub mod receipts;
pub mod redaction;
pub mod reference;
pub mod registry;
pub mod registry_binding;
pub mod review;
pub mod run_summary;
pub mod schema;
pub mod schema_artifacts;
pub mod signal;
pub mod source_packet;
pub mod suppression;
pub mod thread_outbox_provider;
pub mod tools;
pub mod verification;

pub use act::assignment::{
    ActAssignment, ActAssignmentActor, ActAssignmentHost, ActAssignmentHostKind,
    ActAssignmentIdempotency, ActAssignmentSchema, BuildActAssignment, IntentKeyInput,
    derive_content_hash, derive_intent_key, derive_trigger_key,
};
pub use act::result::{
    ActResultEnvelope, ActResultNeedsAgentEnvelope, ActResultNeedsAgentStatus, ActResultNull,
    ActResultSignal, ActResultTerminalEnvelope, ActResultTerminalStatus,
};
pub use act::{
    Act, ActForm, ActSchema, ChangePlan, ChangeRequest, CriterionBinding, CriterionStatus,
    GovernedActRef, Intent, RevisionDetails, SuccessCriterion, TargetSurface, VerificationDetails,
};
pub use agent_context::{
    AgentContextEnvelope, AgentContextProfiles, ContextArtifactMeta, ContextArtifactProducer,
    ContextEntry, ContextEntryVersion, ExecutionLocation, ProfileFile, ProvenanceEntry,
};
pub use artifact::{ARTIFACT_SCHEMA, Artifact, ArtifactProducedBy, ArtifactSchema};
pub use authority::{
    Authority, AuthorityApproval, AuthorityAttenuation, AuthorityBounds, AuthorityCapability,
    AuthorityCondition, AuthorityConditionPredicate, AuthorityEffectCredentialForm,
    AuthorityEffectGuard, AuthorityEffectGuardKind, AuthorityEffectLimit, AuthorityResourceFamily,
    AuthoritySchema, AuthoritySubsetComparison, AuthoritySubsetProof, AuthoritySubsetRelation,
    AuthoritySubsetResult, AuthorityTerm, AuthorityVerb,
};
pub use credential_delivery::{
    CredentialDeliveryEnvBinding, CredentialDeliveryHandle, CredentialDeliveryMode,
    CredentialDeliveryObservation, CredentialDeliveryObservationSchema,
    CredentialDeliveryObservationStatus, CredentialDeliveryProfile,
    CredentialDeliveryProfileSchema, CredentialDeliveryPurpose, CredentialDeliveryRequest,
    CredentialDeliveryRequestSchema, CredentialDeliveryResponse, CredentialDeliveryResponseSchema,
    CredentialDeliveryStatus, CredentialMaterialRole,
};
pub use decision::{
    Closure, ClosureDisposition, Decision, DecisionChoice, DecisionInputs, DecisionJustification,
};
pub use dev::{
    DevFixtureAssertion, DevFixtureAssertionKind, DevFixtureResult, DevFixtureStatus, DevReport,
    DevReportSchema, DevReportStatus,
};
pub use doctor::{
    DoctorDiagnostic, DoctorDiagnosticSeverity, DoctorLocation, DoctorRepair,
    DoctorRepairConfidence, DoctorRepairKind, DoctorRepairRisk, DoctorReport, DoctorReportSchema,
    DoctorStatus, DoctorSummary,
};
pub use execution::{
    ExecutionSemantics, GovernedDisposition, InputContextCapture, OutcomeState, ReceiptOutcome,
    ReceiptSurfaceRef,
};
pub use external_adapter::{
    EXTERNAL_ADAPTER_PROTOCOL_VERSION, ExternalAdapterArtifactObservation,
    ExternalAdapterCancellationFrame, ExternalAdapterCancellationSchema,
    ExternalAdapterCredentialNeed, ExternalAdapterCredentialPurpose,
    ExternalAdapterCredentialReference, ExternalAdapterCredentialRequest,
    ExternalAdapterCredentialRequestSchema, ExternalAdapterErrorObservation,
    ExternalAdapterHostResolutionFrame, ExternalAdapterHostResolutionSchema,
    ExternalAdapterInvocation, ExternalAdapterInvocationSchema, ExternalAdapterManifest,
    ExternalAdapterManifestSchema, ExternalAdapterProtocolVersion, ExternalAdapterResponse,
    ExternalAdapterSandboxIntent, ExternalAdapterStatus, ExternalAdapterTelemetryObservation,
    ExternalAdapterTelemetryValue, ExternalAdapterTimeouts, ExternalAdapterTransport,
    ExternalAdapterTransportKind,
};
pub use fingerprint::{Fingerprint, FingerprintAlgorithm, hex_lower, sha256_hex, sha256_prefixed};
pub use fixture::{Fixture, FixtureLane};
pub use handoff::{
    HandoffDisposition, HandoffSignal, HandoffSignalActor, HandoffSignalSchema,
    HandoffSignalSource, HandoffSignalSourceRef, HandoffState, HandoffStateSchema, HandoffStatus,
    SuppressionReason,
};
pub use host_protocol::{
    AgentActInvocation, AgentActSourceType, ApprovalDecision, ApprovalGate, ExecutionEvent,
    HostNeedsAgentState, HostRunApproval, HostRunApprovalDecision, HostRunKind, HostRunLineage,
    HostRunLineageKind, HostRunResult, HostRunState, HostRunVerification,
    HostRunVerificationStatus, HostTerminalState, Question, ResolutionRequest, ResolutionResponse,
    ResolutionResponseActor,
};
pub use json::{
    JsonNumber, JsonObject, JsonValue, json_bool_field, json_object, json_object_field,
    json_string_field,
};
pub use ledger::{
    LedgerCanonicalization, LedgerChain, LedgerChainVersion, LedgerEntry, LedgerEntryMeta,
    LedgerEntrySchemaVersion, LedgerHashAlgorithm, LedgerPayload, LedgerPayloadVersion,
    LedgerProducer, LedgerSha256Hex,
};
pub use links::{DuplicateCandidate, Links};
pub use list::{
    RunxListEmit, RunxListItem, RunxListItemKind, RunxListReport, RunxListRequestedKind,
    RunxListSchema, RunxListSource, RunxListStatus,
};
pub use operational_policy::{
    OperationalPolicy, OperationalPolicyAction, OperationalPolicyAdmission,
    OperationalPolicyAdmissionRequest, OperationalPolicyAdmissionStatus,
    OperationalPolicyAutomationPermissions, OperationalPolicyDedupePolicy,
    OperationalPolicyDedupeStrategy, OperationalPolicyDuplicateBehavior, OperationalPolicyError,
    OperationalPolicyMissingBehavior, OperationalPolicyOutcomeCloseMode,
    OperationalPolicyOutcomePolicy, OperationalPolicyOwnerRoute, OperationalPolicyPublishMode,
    OperationalPolicyReadback, OperationalPolicyRunnerReadback, OperationalPolicyRunnerRule,
    OperationalPolicyRunnerState, OperationalPolicySchema, OperationalPolicySourceReadback,
    OperationalPolicySourceRule, OperationalPolicySourceThreadPolicy,
    OperationalPolicyTargetReadback, OperationalPolicyTargetRule,
    OperationalPolicyValidationFinding, admit_operational_policy_request,
    lint_operational_policy_contract, operational_policy_runner_kind,
    operational_policy_source_provider, project_operational_policy_readback,
    validate_operational_policy_contract, validate_operational_policy_semantics,
};
pub use operational_proposal::{
    OPERATIONAL_PROPOSAL_SCHEMA, OperationalProposal, OperationalProposalAuthority,
    OperationalProposalHumanGate, OperationalProposalIdempotency, OperationalProposalOutcome,
    OperationalProposalRecommendedAction, OperationalProposalRedactionStatus,
    OperationalProposalSchema,
};
pub use output::{
    Output, OutputField, OutputFieldSpec, OutputType, OutputValidationError,
    output_contract_digest, output_value_schema, validate_output_value,
};
pub use packet_index::{PacketIndex, PacketIndexEntry, PacketIndexSchema};
pub use policy_proof::{
    AuthorityKind, AuthorityProof, AuthorityProofApprovalDecision,
    AuthorityProofApprovalDecisionValue, AuthorityProofCredentialMaterial,
    AuthorityProofCredentialMaterialStatus, AuthorityProofRedaction,
    AuthorityProofRedactionSecretMaterial, AuthorityProofRedactionStatus,
    AuthorityProofRedactionStream, AuthorityProofRequested, AuthorityProofSandbox,
    AuthorityProofSandboxFilesystem, AuthorityProofSandboxNetwork, AuthorityProofSandboxRuntime,
    AuthorityProofSchemaVersion, CredentialEnvelope, CredentialEnvelopeKind,
    CredentialGrantReference, ScopeAdmission, ScopeAdmissionStatus,
};
pub use receipt::{
    EFFECT_FINALITY_RECEIPT_SCHEMA, EffectFinalityPhase, EffectFinalityReceipt,
    EffectFinalityReceiptSchema, FanoutReceiptDecision, FanoutReceiptStrategy,
    FanoutReceiptSyncPoint, Lineage, RECEIPT_CANONICALIZATION, RECEIPT_SCHEMA, Receipt, ReceiptAct,
    ReceiptAuthority, ReceiptCommitment, ReceiptCommitmentScope, ReceiptEnforcement,
    ReceiptIdempotency, ReceiptInputContext, ReceiptIssuer, ReceiptIssuerType, ReceiptSchema,
    ReceiptSignature, RunnerProvenance, Seal, SignatureAlgorithm, Subject, receipt_subject_kind,
};
pub use redaction::{HashAlgorithm, HashCommitment, REDACTION_SCHEMA, Redaction, RedactionSchema};
pub use reference::{ActRef, ProofKind, Reference, ReferenceLink, ReferenceType};
pub use registry_binding::{
    RegistryBinding, RegistryBindingHarness, RegistryBindingRegistry, RegistryBindingSchema,
    RegistryBindingSkill, RegistryBindingState, RegistryBindingUpstream, RegistryHarnessStatus,
    RegistryTrustTier,
};
pub use review::{ReviewReceiptImprovementProposal, ReviewReceiptOutput, ReviewReceiptVerdict};
pub use run_summary::{RunSummary, RunSummarySchema, RunSummaryStatus};
pub use schema_artifacts::{SchemaArtifact, generated_schema_artifacts};
pub use signal::{
    SIGNAL_SCHEMA, Signal, SignalAuthenticity, SignalSchema, SignalTrustLevel, signal_type,
};
pub use source_packet::{SOURCE_PACKET_SCHEMA, SourcePacket, SourcePacketSchema};
pub use suppression::{SuppressionRecord, SuppressionRecordSchema, SuppressionScope};
pub use thread_outbox_provider::{
    THREAD_OUTBOX_PROVIDER_PROTOCOL_VERSION, ThreadOutboxProviderCredentialNeed,
    ThreadOutboxProviderCredentialProfile, ThreadOutboxProviderError, ThreadOutboxProviderFetch,
    ThreadOutboxProviderFetchProviderTarget, ThreadOutboxProviderFetchSchema,
    ThreadOutboxProviderFetchTarget, ThreadOutboxProviderFetchThreadTarget,
    ThreadOutboxProviderIdempotency, ThreadOutboxProviderIdempotencyObservation,
    ThreadOutboxProviderIdempotencyStatus, ThreadOutboxProviderLocator,
    ThreadOutboxProviderManifest, ThreadOutboxProviderManifestSchema,
    ThreadOutboxProviderObservation, ThreadOutboxProviderObservationSchema,
    ThreadOutboxProviderObservationStatus, ThreadOutboxProviderOperation,
    ThreadOutboxProviderPayloadFormat, ThreadOutboxProviderProtocolVersion,
    ThreadOutboxProviderPush, ThreadOutboxProviderPushSchema, ThreadOutboxProviderReadbackSummary,
    ThreadOutboxProviderReceiptCapabilities, ThreadOutboxProviderReceiptContext,
    ThreadOutboxProviderRedactionCapabilities, ThreadOutboxProviderRenderedPayload,
    ThreadOutboxProviderThreadLocator, ThreadOutboxProviderTransport,
    ThreadOutboxProviderTransportKind,
};
pub use tools::{
    RuntimeCommand, ToolCommandInputMode, ToolIdempotencyPolicy, ToolInput, ToolManifest,
    ToolManifestSchema, ToolMcpServer, ToolOutput, ToolOutputBinding, ToolRetryPolicy, ToolSandbox,
    ToolSandboxCwdPolicy, ToolSandboxProfile, ToolSource, ToolSourceType,
};
pub use verification::{
    ReceiptVerificationSummary, VERIFICATION_SCHEMA, Verification, VerificationCheck,
    VerificationSchema, VerificationStatus,
};
