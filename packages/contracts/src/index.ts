export const contractsPackage = "@runxhq/contracts";

export {
  RUNX_SCHEMA_BASE_URL,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  RUNX_CONTROL_SCHEMA_REFS,
  RUNX_AUXILIARY_SCHEMA_IDS,
} from "./internal.js";

export {
  credentialGrantReferenceSchema,
  credentialEnvelopeSchema,
  scopeAdmissionSchema,
  validateCredentialEnvelopeContract,
  validateScopeAdmissionContract,
  type CredentialGrantReferenceContract,
  type CredentialEnvelopeContract,
  type ScopeAdmissionContract,
} from "./schemas/credentials.js";

export {
  outputContractScalarSchema,
  outputContractObjectEntrySchema,
  outputContractEntrySchema,
  outputContractSchema,
  validateOutputContractContract,
  type OutputContractScalarContract,
  type OutputContractObjectEntryContract,
  type OutputContractEntryContract,
  type OutputContractContract,
} from "./schemas/output.js";

export {
  artifactProducerSchema,
  artifactMetaSchema,
  artifactEnvelopeSchema,
  type ArtifactProducerContract,
  type ArtifactMetaContract,
  type ArtifactEnvelopeContract,
} from "./schemas/artifact.js";

export {
  agentContextProvenanceSchema,
  contextDocumentSchema,
  contextSchema,
  qualityProfileContextSchema,
  executionLocationSchema,
  agentContextEnvelopeSchema,
  validateAgentContextEnvelopeContract,
  type AgentContextProvenanceContract,
  type ContextDocumentContract,
  type ContextContract,
  type QualityProfileContextContract,
  type ExecutionLocationContract,
  type AgentContextEnvelopeContract,
} from "./schemas/context.js";

export {
  agentWorkRequestSchema,
  questionSchema,
  approvalGateSchema,
  validateAgentWorkRequestContract,
  validateQuestionContract,
  validateApprovalGateContract,
  type AgentWorkRequestContract,
  type QuestionContract,
  type ApprovalGateContract,
} from "./schemas/agent-work.js";

export {
  inputResolutionRequestSchema,
  approvalResolutionRequestSchema,
  cognitiveResolutionRequestSchema,
  resolutionRequestSchema,
  resolutionResponseSchema,
  adapterInvokeTerminalResultSchema,
  adapterInvokeNeedsResolutionResultSchema,
  adapterInvokeResultSchema,
  validateResolutionRequestContract,
  validateResolutionResponseContract,
  validateAdapterInvokeResultContract,
  type InputResolutionRequestContract,
  type ApprovalResolutionRequestContract,
  type CognitiveResolutionRequestContract,
  type ResolutionRequestContract,
  type ResolutionResponseContract,
  type AdapterInvokeResultContract,
} from "./schemas/resolution.js";

export {
  registryBindingSchema,
  reviewReceiptOutputSchema,
  validateRegistryBindingContract,
  validateReviewReceiptOutputContract,
  type RegistryBindingContract,
  type ReviewReceiptOutputContract,
} from "./schemas/registry.js";

export {
  doctorRepairSchema,
  doctorLocationSchema,
  doctorDiagnosticSchema,
  doctorSummarySchema,
  doctorV1Schema,
  validateDoctorReportContract,
  type DoctorRepairContract,
  type DoctorLocationContract,
  type DoctorDiagnosticContract,
  type DoctorSummaryContract,
  type DoctorReportContract,
} from "./schemas/doctor.js";

export {
  devV1Schema,
  validateDevReportContract,
  type DevFixtureAssertionContract,
  type DevFixtureResultContract,
  type DevReportContract,
} from "./schemas/dev.js";

export {
  runxListRequestedKindSchema,
  runxListItemKindSchema,
  runxListSourceSchema,
  runxListItemSchema,
  listV1Schema,
  validateRunxListReportContract,
  type RunxListRequestedKindContract,
  type RunxListItemKindContract,
  type RunxListSourceContract,
  type RunxListEmitContract,
  type RunxListItemContract,
  type RunxListReportContract,
} from "./schemas/list.js";

export {
  receiptV1Schema,
  type ReceiptContract,
} from "./schemas/receipt.js";

export {
  localReceiptSchema,
  localSkillReceiptSchema,
  localGraphReceiptSchema,
  localReceiptSchemaVersion,
  localReceiptDispositions,
  localOutcomeStates,
  validateLocalReceiptContract,
  validateLocalSkillReceiptContract,
  validateLocalGraphReceiptContract,
  type LocalReceiptContract,
  type LocalSkillReceiptContract,
  type LocalGraphReceiptContract,
} from "./schemas/local-receipt.js";

export {
  outcomeResolutionSchema,
  outcomeResolutionSchemaVersion,
  validateOutcomeResolutionContract,
  type OutcomeResolutionContract,
} from "./schemas/outcome-resolution.js";

export {
  validateArtifactEnvelopeContract,
} from "./schemas/artifact.js";

export {
  hostedReceiptManifestSchema,
  hostedReceiptIndexEntrySchema,
  hostedArtifactIndexEntrySchema,
  validateHostedReceiptManifestContract,
  type HostedReceiptManifestContract,
  type HostedReceiptIndexEntryContract,
  type HostedArtifactIndexEntryContract,
} from "./schemas/hosted-receipt-manifest.js";

export {
  fixtureV1Schema,
  type FixtureContract,
} from "./schemas/fixture.js";

export {
  toolManifestV1Schema,
  type ToolManifestContract,
} from "./schemas/tool-manifest.js";

export {
  packetIndexV1Schema,
  type PacketIndexEntryContract,
  type PacketIndexContract,
} from "./schemas/packet-index.js";

export {
  capabilityExecutionActorSchema,
  capabilityExecutionTransportSchema,
  capabilityExecutionIdempotencySchema,
  capabilityExecutionV1Schema,
  validateCapabilityExecutionContract,
  type CapabilityExecutionActorContract,
  type CapabilityExecutionTransportContract,
  type CapabilityExecutionIdempotencyContract,
  type CapabilityExecutionContract,
} from "./schemas/capability-execution.js";

export {
  handoffSignalV1Schema,
  handoffStateV1Schema,
  suppressionRecordV1Schema,
  validateHandoffSignalContract,
  validateHandoffStateContract,
  validateSuppressionRecordContract,
  type HandoffSignalContract,
  type HandoffStateContract,
  type SuppressionRecordContract,
} from "./schemas/handoff.js";

import { agentContextEnvelopeSchema } from "./schemas/context.js";
import { agentWorkRequestSchema, approvalGateSchema, questionSchema } from "./schemas/agent-work.js";
import { credentialEnvelopeSchema, scopeAdmissionSchema } from "./schemas/credentials.js";
import { outputContractSchema } from "./schemas/output.js";
import { adapterInvokeResultSchema, resolutionRequestSchema, resolutionResponseSchema } from "./schemas/resolution.js";
import { registryBindingSchema, reviewReceiptOutputSchema } from "./schemas/registry.js";
import { doctorV1Schema } from "./schemas/doctor.js";
import { devV1Schema } from "./schemas/dev.js";
import { listV1Schema } from "./schemas/list.js";
import { receiptV1Schema } from "./schemas/receipt.js";
import { fixtureV1Schema } from "./schemas/fixture.js";
import { toolManifestV1Schema } from "./schemas/tool-manifest.js";
import { packetIndexV1Schema } from "./schemas/packet-index.js";
import { capabilityExecutionV1Schema } from "./schemas/capability-execution.js";
import { handoffSignalV1Schema, handoffStateV1Schema, suppressionRecordV1Schema } from "./schemas/handoff.js";

export const runxContractSchemas = {
  outputContract: outputContractSchema,
  agentContextEnvelope: agentContextEnvelopeSchema,
  agentWorkRequest: agentWorkRequestSchema,
  question: questionSchema,
  approvalGate: approvalGateSchema,
  resolutionRequest: resolutionRequestSchema,
  resolutionResponse: resolutionResponseSchema,
  adapterInvokeResult: adapterInvokeResultSchema,
  credentialEnvelope: credentialEnvelopeSchema,
  scopeAdmission: scopeAdmissionSchema,
  doctor: doctorV1Schema,
  dev: devV1Schema,
  list: listV1Schema,
  receipt: receiptV1Schema,
  fixture: fixtureV1Schema,
  toolManifest: toolManifestV1Schema,
  packetIndex: packetIndexV1Schema,
  capabilityExecution: capabilityExecutionV1Schema,
  handoffSignal: handoffSignalV1Schema,
  handoffState: handoffStateV1Schema,
  suppressionRecord: suppressionRecordV1Schema,
} as const;

export const runxAuxiliarySchemas = {
  registryBinding: registryBindingSchema,
  reviewReceiptOutput: reviewReceiptOutputSchema,
} as const;

export const runxGeneratedSchemaArtifacts = {
  "output-contract.schema.json": outputContractSchema,
  "agent-context-envelope.schema.json": agentContextEnvelopeSchema,
  "agent-work-request.schema.json": agentWorkRequestSchema,
  "question.schema.json": questionSchema,
  "approval-gate.schema.json": approvalGateSchema,
  "resolution-request.schema.json": resolutionRequestSchema,
  "resolution-response.schema.json": resolutionResponseSchema,
  "adapter-invoke-result.schema.json": adapterInvokeResultSchema,
  "credential-envelope.schema.json": credentialEnvelopeSchema,
  "scope-admission.schema.json": scopeAdmissionSchema,
  "doctor.schema.json": doctorV1Schema,
  "dev.schema.json": devV1Schema,
  "list.schema.json": listV1Schema,
  "receipt.schema.json": receiptV1Schema,
  "fixture.schema.json": fixtureV1Schema,
  "tool-manifest.schema.json": toolManifestV1Schema,
  "packet-index.schema.json": packetIndexV1Schema,
  "capability-execution.schema.json": capabilityExecutionV1Schema,
  "handoff-signal.schema.json": handoffSignalV1Schema,
  "handoff-state.schema.json": handoffStateV1Schema,
  "suppression-record.schema.json": suppressionRecordV1Schema,
  "registry-binding.schema.json": registryBindingSchema,
  "review-receipt-output.schema.json": reviewReceiptOutputSchema,
} as const;

export {
  buildHostedOpenApiPublicSchemas,
} from "./openapi-public.js";
export { buildHostedOpenApiRuntimeSchemas } from "./openapi-runtime.js";
export { buildHostedOpenApiSchemas } from "./openapi.js";
