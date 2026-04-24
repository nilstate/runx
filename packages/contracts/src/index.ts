export const contractsPackage = "@runxhq/contracts";

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;

type UnknownRecord = Readonly<Record<string, unknown>>;
type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer TValue)[] ? readonly DeepReadonly<TValue>[]
      : T extends (infer TValue)[] ? readonly DeepReadonly<TValue>[]
        : T extends object ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
          : T;

function stringEnum<const TValue extends readonly string[]>(
  values: TValue,
  options: Record<string, unknown> = {},
) {
  const properties = Object.fromEntries(
    values.map((value) => [value, Type.Null()]),
  ) as Record<TValue[number], ReturnType<typeof Type.Null>>;
  return Type.KeyOf(
    Type.Object(properties, { additionalProperties: false }),
    options,
  );
}

function unknownRecordSchema(options: Record<string, unknown> = {}) {
  return Type.Record(Type.String(), Type.Unknown(), options);
}

function dateTimeStringSchema(options: Record<string, unknown> = {}) {
  return Type.String({
    minLength: 1,
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
    ...options,
  });
}

export const RUNX_SCHEMA_BASE_URL = "https://schemas.runx.dev" as const;

export const RUNX_CONTRACT_IDS = {
  doctor: `${RUNX_SCHEMA_BASE_URL}/runx/doctor/v1.json`,
  dev: `${RUNX_SCHEMA_BASE_URL}/runx/dev/v1.json`,
  list: `${RUNX_SCHEMA_BASE_URL}/runx/list/v1.json`,
  receipt: `${RUNX_SCHEMA_BASE_URL}/runx/receipt/v1.json`,
  fixture: `${RUNX_SCHEMA_BASE_URL}/runx/fixture/v1.json`,
  toolManifest: `${RUNX_SCHEMA_BASE_URL}/runx/tool/manifest/v1.json`,
  packetIndex: `${RUNX_SCHEMA_BASE_URL}/runx/packet/index/v1.json`,
  handoffSignal: `${RUNX_SCHEMA_BASE_URL}/runx/handoff-signal/v1.json`,
  handoffState: `${RUNX_SCHEMA_BASE_URL}/runx/handoff-state/v1.json`,
  suppressionRecord: `${RUNX_SCHEMA_BASE_URL}/runx/suppression-record/v1.json`,
} as const;

export const RUNX_LOGICAL_SCHEMAS = {
  doctor: "runx.doctor.v1",
  dev: "runx.dev.v1",
  list: "runx.list.v1",
  receipt: "runx.receipt.v1",
  fixture: "runx.fixture.v1",
  toolManifest: "runx.tool.manifest.v1",
  packetIndex: "runx.packet.index.v1",
  handoffSignal: "runx.handoff_signal.v1",
  handoffState: "runx.handoff_state.v1",
  suppressionRecord: "runx.suppression_record.v1",
} as const;

export const RUNX_CONTROL_SCHEMA_REFS = {
  output_contract: "https://runx.ai/spec/output-contract.schema.json",
  agent_context_envelope: "https://runx.ai/spec/agent-context-envelope.schema.json",
  agent_work_request: "https://runx.ai/spec/agent-work-request.schema.json",
  question: "https://runx.ai/spec/question.schema.json",
  approval_gate: "https://runx.ai/spec/approval-gate.schema.json",
  resolution_request: "https://runx.ai/spec/resolution-request.schema.json",
  resolution_response: "https://runx.ai/spec/resolution-response.schema.json",
  adapter_invoke_result: "https://runx.ai/spec/adapter-invoke-result.schema.json",
  credential_envelope: "https://runx.ai/spec/credential-envelope.schema.json",
  scope_admission: "https://runx.ai/spec/scope-admission.schema.json",
} as const;

export const RUNX_AUXILIARY_SCHEMA_IDS = {
  registryBinding: "https://runx.ai/schemas/registry-binding.schema.json",
  reviewReceiptOutput: "https://runx.ai/schemas/review-receipt-output.schema.json",
} as const;

const authorityKinds = ["read_only", "constructive", "destructive"] as const;
const scopeAdmissionStatuses = ["allow", "deny"] as const;
const registryBindingStates = [
  "registry_binding_drafted",
  "registry_bound",
  "harness_verified",
  "published",
] as const;
const registryTrustTiers = ["first_party", "verified", "community"] as const;
const harnessStatuses = ["pending", "failed", "harness_verified"] as const;
const reviewReceiptVerdicts = ["pass", "needs_update", "blocked"] as const;
const doctorDiagnosticSeverities = ["error", "warning", "info"] as const;
const doctorRepairKinds = [
  "create_file",
  "replace_file",
  "edit_yaml",
  "edit_json",
  "add_fixture",
  "run_command",
  "manual",
] as const;
const doctorRepairConfidences = ["low", "medium", "high"] as const;
const doctorRepairRisks = ["low", "medium", "high", "sensitive"] as const;
const doctorStatuses = ["success", "failure"] as const;
const devStatuses = ["success", "failure", "skipped", "needs_approval"] as const;
const fixtureAssertionKinds = [
  "subset_miss",
  "exact_mismatch",
  "packet_invalid",
  "status_mismatch",
  "type_mismatch",
] as const;
const fixtureLanes = ["deterministic", "agent", "repo-integration"] as const;
const runxListRequestedKinds = ["all", "tools", "skills", "chains", "packets", "overlays"] as const;
const runxListItemKinds = ["tool", "skill", "chain", "packet", "overlay"] as const;
const runxListSources = ["local", "workspace", "dependencies", "built-in"] as const;
const runxListStatuses = ["ok", "invalid"] as const;
const handoffSignalSources = [
  "pull_request_comment",
  "pull_request_review",
  "pull_request_state",
  "issue_comment",
  "discussion_reply",
  "email_reply",
  "direct_message_reply",
  "manual_note",
  "system_event",
] as const;
const handoffSignalDispositions = [
  "acknowledged",
  "interested",
  "requested_changes",
  "accepted",
  "merged",
  "declined",
  "requested_no_contact",
  "rerouted",
] as const;
const handoffStatuses = [
  "awaiting_response",
  "engaged",
  "needs_revision",
  "accepted",
  "completed",
  "declined",
  "rerouted",
  "suppressed",
] as const;
const suppressionScopes = ["handoff", "target", "repo", "contact"] as const;
const suppressionReasons = [
  "requested_no_contact",
  "remove_request",
  "operator_block",
  "legal_request",
] as const;

export const credentialGrantReferenceSchema = Type.Object(
  {
    grant_id: Type.String({ minLength: 1 }),
    scope_family: Type.String({ minLength: 1 }),
    authority_kind: stringEnum(authorityKinds),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type CredentialGrantReferenceContract = DeepReadonly<Static<typeof credentialGrantReferenceSchema>>;

export const credentialEnvelopeSchema = Type.Object(
  {
    kind: Type.Literal("runx.credential-envelope.v1"),
    grant_id: Type.String({ minLength: 1 }),
    provider: Type.String({ minLength: 1 }),
    connection_id: Type.String({ minLength: 1 }),
    scopes: Type.Array(Type.String({ minLength: 1 })),
    grant_reference: Type.Optional(credentialGrantReferenceSchema),
    material_ref: Type.String({ minLength: 1 }),
  },
  {
    $id: RUNX_CONTROL_SCHEMA_REFS.credential_envelope,
    additionalProperties: false,
  },
);

export type CredentialEnvelopeContract = DeepReadonly<Static<typeof credentialEnvelopeSchema>>;

export const scopeAdmissionSchema = Type.Object(
  {
    status: stringEnum(scopeAdmissionStatuses),
    requested_scopes: Type.Array(Type.String({ minLength: 1 })),
    granted_scopes: Type.Array(Type.String({ minLength: 1 })),
    grant_id: Type.Optional(Type.String({ minLength: 1 })),
    reasons: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    decision_summary: Type.Optional(Type.String()),
  },
  {
    $id: RUNX_CONTROL_SCHEMA_REFS.scope_admission,
    additionalProperties: false,
  },
);

export type ScopeAdmissionContract = DeepReadonly<Static<typeof scopeAdmissionSchema>>;

export function validateCredentialEnvelopeContract(
  value: unknown,
  label = "credential_envelope",
): CredentialEnvelopeContract {
  return validateContractSchema(credentialEnvelopeSchema, value, label);
}

export function validateScopeAdmissionContract(value: unknown, label = "scope_admission"): ScopeAdmissionContract {
  return validateContractSchema(scopeAdmissionSchema, value, label);
}

export const registryBindingSchema = Type.Object(
  {
    schema: Type.Literal("runx.registry_binding.v1"),
    state: stringEnum(registryBindingStates),
    skill: Type.Object(
      {
        id: Type.String(),
        name: Type.String(),
        description: Type.String(),
      },
      { additionalProperties: true },
    ),
    upstream: Type.Object(
      {
        host: Type.String(),
        owner: Type.String(),
        repo: Type.String(),
        path: Type.String(),
        branch: Type.Optional(Type.String()),
        commit: Type.String(),
        blob_sha: Type.String(),
        pr_url: Type.Optional(Type.String()),
        merged_at: Type.Optional(Type.String()),
        html_url: Type.Optional(Type.String()),
        raw_url: Type.Optional(Type.String()),
        source_of_truth: Type.Literal(true),
      },
      { additionalProperties: true },
    ),
    registry: Type.Object(
      {
        owner: Type.String(),
        trust_tier: stringEnum(registryTrustTiers),
        version: Type.String(),
        install_command: Type.Optional(Type.String()),
        run_command: Type.Optional(Type.String()),
        profile_path: Type.String(),
        materialized_package_is_registry_artifact: Type.Literal(true),
      },
      { additionalProperties: true },
    ),
    harness: Type.Object(
      {
        status: stringEnum(harnessStatuses),
        case_count: Type.Number(),
        assertion_count: Type.Optional(Type.Number()),
        case_names: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: true },
    ),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_AUXILIARY_SCHEMA_IDS.registryBinding,
    title: "runx upstream registry binding",
    additionalProperties: true,
  },
);

export type RegistryBindingContract = DeepReadonly<Static<typeof registryBindingSchema>>;

export const reviewReceiptOutputSchema = Type.Object(
  {
    verdict: stringEnum(reviewReceiptVerdicts, {
      description: "Overall diagnosis. `pass` means no change needed; `needs_update` means one or more bounded improvements apply; `blocked` means the evidence is insufficient to decide.",
    }),
    failure_summary: Type.String({
      description: "One to three sentences naming the failing step, the failure class, and the root cause. For `pass`, restates why no change is needed.",
    }),
    improvement_proposals: Type.Array(
      Type.Object(
        {
          target: Type.String({
            description: "What to change (e.g., SKILL.md, execution profile, graph step, input, fixture path).",
          }),
          change: Type.String({
            description: "What specifically to change.",
          }),
          rationale: Type.Optional(Type.String({
            description: "Why this fixes the root cause.",
          })),
          risk: Type.Optional(Type.String({
            description: "What could go wrong with the change.",
          })),
        },
        { additionalProperties: true },
      ),
      {
        description: "Bounded changes that would resolve the diagnosed failure. Empty when verdict is `pass`.",
      },
    ),
    next_harness_checks: Type.Array(Type.String(), {
      description: "Replayable checks that should pass after the improvement lands.",
    }),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_AUXILIARY_SCHEMA_IDS.reviewReceiptOutput,
    title: "runx review-receipt output",
    description: "Output contract for the review-receipt skill. Produced by the agent-step reviewer and consumed by write-harness downstream of improve-skill.",
    additionalProperties: true,
  },
);

export type ReviewReceiptOutputContract = DeepReadonly<Static<typeof reviewReceiptOutputSchema>>;

export function validateRegistryBindingContract(value: unknown, label = "registry_binding"): RegistryBindingContract {
  return validateContractSchema(registryBindingSchema, value, label);
}

export function validateReviewReceiptOutputContract(
  value: unknown,
  label = "review_receipt_output",
): ReviewReceiptOutputContract {
  return validateContractSchema(reviewReceiptOutputSchema, value, label);
}

function validateContractSchema<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
  label: string,
  references: readonly TSchema[] = [],
): Static<TSchemaValue> {
  const normalizedReferences = [...references];
  const matches = normalizedReferences.length > 0
    ? Value.Check(schema, normalizedReferences, value)
    : Value.Check(schema, value);
  if (matches) {
    return value as Static<TSchemaValue>;
  }
  const firstError = normalizedReferences.length > 0
    ? [...Value.Errors(schema, normalizedReferences, value)][0]
    : [...Value.Errors(schema, value)][0];
  const schemaRef = typeof schema.$id === "string" ? schema.$id : "contract schema";
  const path = firstError?.path ? `${label}${firstError.path}` : label;
  throw new Error(`${path} must match ${schemaRef}.`);
}

const doctorTargetSchema = unknownRecordSchema();
const doctorEvidenceSchema = unknownRecordSchema();
const doctorRepairSchema = Type.Object(
  {
    id: Type.String(),
    kind: stringEnum(doctorRepairKinds),
    confidence: stringEnum(doctorRepairConfidences),
    risk: stringEnum(doctorRepairRisks),
    path: Type.Optional(Type.String()),
    json_pointer: Type.Optional(Type.String()),
    contents: Type.Optional(Type.String()),
    patch: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    requires_human_review: Type.Boolean(),
  },
  { additionalProperties: false },
);
const doctorLocationSchema = Type.Object(
  {
    path: Type.String(),
    json_pointer: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const doctorDiagnosticSchema = Type.Object(
  {
    id: Type.String(),
    instance_id: Type.String(),
    severity: stringEnum(doctorDiagnosticSeverities),
    title: Type.String(),
    message: Type.String(),
    target: doctorTargetSchema,
    location: doctorLocationSchema,
    evidence: Type.Optional(doctorEvidenceSchema),
    repairs: Type.Array(doctorRepairSchema),
  },
  { additionalProperties: false },
);
const doctorSummarySchema = Type.Object(
  {
    errors: Type.Integer({ minimum: 0 }),
    warnings: Type.Integer({ minimum: 0 }),
    infos: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type DoctorRepairContract = DeepReadonly<Static<typeof doctorRepairSchema>>;
export type DoctorLocationContract = DeepReadonly<Static<typeof doctorLocationSchema>>;
export type DoctorDiagnosticContract = DeepReadonly<Static<typeof doctorDiagnosticSchema>>;
export type DoctorSummaryContract = DeepReadonly<Static<typeof doctorSummarySchema>>;

export const doctorV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.doctor),
    status: stringEnum(doctorStatuses),
    summary: doctorSummarySchema,
    diagnostics: Type.Array(doctorDiagnosticSchema),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.doctor,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.doctor,
    additionalProperties: false,
  },
);

export type DoctorReportContract = DeepReadonly<Static<typeof doctorV1Schema>>;

export function validateDoctorReportContract(value: unknown, label = "doctor_report"): DoctorReportContract {
  return validateContractSchema(doctorV1Schema, value, label);
}

const devFixtureAssertionSchema = Type.Object(
  {
    path: Type.String(),
    expected: Type.Optional(Type.Unknown()),
    actual: Type.Optional(Type.Unknown()),
    kind: stringEnum(fixtureAssertionKinds),
    message: Type.String(),
  },
  { additionalProperties: false },
);
const devFixtureResultSchema = Type.Object(
  {
    name: Type.String(),
    lane: Type.String(),
    target: unknownRecordSchema(),
    status: stringEnum(["success", "failure", "skipped"] as const),
    duration_ms: Type.Integer({ minimum: 0 }),
    assertions: Type.Array(devFixtureAssertionSchema),
    skip_reason: Type.Optional(Type.String()),
    output: Type.Optional(Type.Unknown()),
    replay_path: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type DevFixtureAssertionContract = DeepReadonly<Static<typeof devFixtureAssertionSchema>>;
export type DevFixtureResultContract = DeepReadonly<Static<typeof devFixtureResultSchema>>;

export const devV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.dev),
    status: stringEnum(devStatuses),
    doctor: Type.Ref(doctorV1Schema),
    fixtures: Type.Array(devFixtureResultSchema),
    receipt_id: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.dev,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.dev,
    additionalProperties: false,
  },
);

const devContractReferences = [doctorV1Schema] as const;

export type DevReportContract = DeepReadonly<Static<typeof devV1Schema>>;

export function validateDevReportContract(value: unknown, label = "dev_report"): DevReportContract {
  return validateContractSchema(devV1Schema, value, label, devContractReferences);
}

const runxListEmitSchema = Type.Object(
  {
    name: Type.String(),
    packet: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const runxListRequestedKindSchema = stringEnum(runxListRequestedKinds);
export const runxListItemKindSchema = stringEnum(runxListItemKinds);
export const runxListSourceSchema = stringEnum(runxListSources);

export type RunxListRequestedKindContract = DeepReadonly<Static<typeof runxListRequestedKindSchema>>;
export type RunxListItemKindContract = DeepReadonly<Static<typeof runxListItemKindSchema>>;
export type RunxListSourceContract = DeepReadonly<Static<typeof runxListSourceSchema>>;
export type RunxListEmitContract = DeepReadonly<Static<typeof runxListEmitSchema>>;

export const runxListItemSchema = Type.Object(
  {
    kind: runxListItemKindSchema,
    name: Type.String(),
    source: runxListSourceSchema,
    path: Type.String(),
    status: stringEnum(runxListStatuses),
    diagnostics: Type.Optional(Type.Array(Type.String())),
    scopes: Type.Optional(Type.Array(Type.String())),
    emits: Type.Optional(Type.Array(runxListEmitSchema)),
    fixtures: Type.Optional(Type.Integer({ minimum: 0 })),
    harness_cases: Type.Optional(Type.Integer({ minimum: 0 })),
    steps: Type.Optional(Type.Integer({ minimum: 0 })),
    wraps: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type RunxListItemContract = DeepReadonly<Static<typeof runxListItemSchema>>;

export const listV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.list),
    root: Type.String(),
    requested_kind: runxListRequestedKindSchema,
    items: Type.Array(runxListItemSchema),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.list,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.list,
    additionalProperties: false,
  },
);

export type RunxListReportContract = DeepReadonly<Static<typeof listV1Schema>>;

export function validateRunxListReportContract(value: unknown, label = "list_report"): RunxListReportContract {
  return validateContractSchema(listV1Schema, value, label);
}

const receiptStepSchema = unknownRecordSchema();

export const receiptV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.receipt),
    run_id: Type.String(),
    command: Type.String(),
    status: stringEnum(devStatuses),
    started_at: Type.String(),
    finished_at: Type.Optional(Type.String()),
    root: Type.String(),
    unit: Type.Optional(unknownRecordSchema()),
    steps: Type.Array(receiptStepSchema),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.receipt,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.receipt,
    additionalProperties: false,
  },
);

export type ReceiptContract = DeepReadonly<Static<typeof receiptV1Schema>>;

const fixtureEnvelopeSchema = unknownRecordSchema();

export const fixtureV1Schema = Type.Object(
  {
    name: Type.String(),
    lane: stringEnum(fixtureLanes),
    target: unknownRecordSchema(),
    inputs: Type.Optional(fixtureEnvelopeSchema),
    env: Type.Optional(fixtureEnvelopeSchema),
    agent: Type.Optional(fixtureEnvelopeSchema),
    repo: Type.Optional(fixtureEnvelopeSchema),
    execution: Type.Optional(fixtureEnvelopeSchema),
    permissions: Type.Optional(fixtureEnvelopeSchema),
    expect: fixtureEnvelopeSchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.fixture,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.fixture,
    additionalProperties: false,
  },
);

export type FixtureContract = DeepReadonly<Static<typeof fixtureV1Schema>>;

export const toolManifestV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.toolManifest),
    name: Type.String(),
    version: Type.String(),
    description: Type.Optional(Type.String()),
    source_hash: Type.String(),
    schema_hash: Type.String(),
    runtime: unknownRecordSchema(),
    inputs: Type.Optional(unknownRecordSchema()),
    output: unknownRecordSchema(),
    scopes: Type.Optional(Type.Array(Type.String())),
    toolkit_version: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.toolManifest,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.toolManifest,
    additionalProperties: false,
  },
);

export type ToolManifestContract = DeepReadonly<Static<typeof toolManifestV1Schema>>;

const packetIndexEntrySchema = Type.Object(
  {
    id: Type.String(),
    package: Type.String(),
    version: Type.String(),
    path: Type.String(),
    sha256: Type.String(),
  },
  { additionalProperties: false },
);

export type PacketIndexEntryContract = DeepReadonly<Static<typeof packetIndexEntrySchema>>;

export const packetIndexV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.packetIndex),
    packets: Type.Array(packetIndexEntrySchema),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.packetIndex,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.packetIndex,
    additionalProperties: false,
  },
);

export type PacketIndexContract = DeepReadonly<Static<typeof packetIndexV1Schema>>;

const handoffActorSchema = Type.Object(
  {
    actor_id: Type.Optional(Type.String({ minLength: 1 })),
    display_name: Type.Optional(Type.String()),
    role: Type.Optional(Type.String({ minLength: 1 })),
    provider_identity: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const handoffEvidenceRefSchema = Type.Object(
  {
    type: Type.String({ minLength: 1 }),
    uri: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String()),
    recorded_at: Type.Optional(dateTimeStringSchema()),
  },
  { additionalProperties: false },
);

export const handoffSignalV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.handoffSignal),
    signal_id: Type.String({ minLength: 1 }),
    handoff_id: Type.String({ minLength: 1 }),
    boundary_kind: Type.Optional(Type.String({ minLength: 1 })),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
    contact_locator: Type.Optional(Type.String({ minLength: 1 })),
    thread_locator: Type.Optional(Type.String({ minLength: 1 })),
    outbox_entry_id: Type.Optional(Type.String({ minLength: 1 })),
    source: stringEnum(handoffSignalSources),
    disposition: stringEnum(handoffSignalDispositions),
    recorded_at: dateTimeStringSchema(),
    actor: Type.Optional(handoffActorSchema),
    notes: Type.Optional(Type.String()),
    labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    source_ref: Type.Optional(handoffEvidenceRefSchema),
    metadata: Type.Optional(unknownRecordSchema()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.handoffSignal,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.handoffSignal,
    additionalProperties: false,
  },
);

export type HandoffSignalContract = DeepReadonly<Static<typeof handoffSignalV1Schema>>;

export const handoffStateV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.handoffState),
    handoff_id: Type.String({ minLength: 1 }),
    boundary_kind: Type.Optional(Type.String({ minLength: 1 })),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
    contact_locator: Type.Optional(Type.String({ minLength: 1 })),
    status: stringEnum(handoffStatuses),
    signal_count: Type.Integer({ minimum: 0 }),
    last_signal_id: Type.Optional(Type.String({ minLength: 1 })),
    last_signal_at: Type.Optional(dateTimeStringSchema()),
    last_signal_disposition: Type.Optional(stringEnum(handoffSignalDispositions)),
    suppression_record_id: Type.Optional(Type.String({ minLength: 1 })),
    suppression_reason: Type.Optional(stringEnum(suppressionReasons)),
    summary: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.handoffState,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.handoffState,
    additionalProperties: false,
  },
);

export type HandoffStateContract = DeepReadonly<Static<typeof handoffStateV1Schema>>;

export const suppressionRecordV1Schema = Type.Object(
  {
    schema: Type.Literal(RUNX_LOGICAL_SCHEMAS.suppressionRecord),
    record_id: Type.String({ minLength: 1 }),
    scope: stringEnum(suppressionScopes),
    key: Type.String({ minLength: 1 }),
    reason: stringEnum(suppressionReasons),
    recorded_at: dateTimeStringSchema(),
    expires_at: Type.Optional(dateTimeStringSchema()),
    source_signal_id: Type.Optional(Type.String({ minLength: 1 })),
    notes: Type.Optional(Type.String()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTRACT_IDS.suppressionRecord,
    "x-runx-schema": RUNX_LOGICAL_SCHEMAS.suppressionRecord,
    additionalProperties: false,
  },
);

export type SuppressionRecordContract = DeepReadonly<Static<typeof suppressionRecordV1Schema>>;

export function validateHandoffSignalContract(value: unknown, label = "handoff_signal"): HandoffSignalContract {
  return validateContractSchema(handoffSignalV1Schema, value, label);
}

export function validateHandoffStateContract(value: unknown, label = "handoff_state"): HandoffStateContract {
  return validateContractSchema(handoffStateV1Schema, value, label);
}

export function validateSuppressionRecordContract(
  value: unknown,
  label = "suppression_record",
): SuppressionRecordContract {
  return validateContractSchema(suppressionRecordV1Schema, value, label);
}

export const runxContractSchemas = {
  doctor: doctorV1Schema,
  dev: devV1Schema,
  list: listV1Schema,
  receipt: receiptV1Schema,
  fixture: fixtureV1Schema,
  toolManifest: toolManifestV1Schema,
  packetIndex: packetIndexV1Schema,
  handoffSignal: handoffSignalV1Schema,
  handoffState: handoffStateV1Schema,
  suppressionRecord: suppressionRecordV1Schema,
} as const;

export const runxAuxiliarySchemas = {
  registryBinding: registryBindingSchema,
  reviewReceiptOutput: reviewReceiptOutputSchema,
} as const;

export const runxGeneratedSchemaArtifacts = {
  "doctor.schema.json": doctorV1Schema,
  "dev.schema.json": devV1Schema,
  "list.schema.json": listV1Schema,
  "receipt.schema.json": receiptV1Schema,
  "fixture.schema.json": fixtureV1Schema,
  "tool-manifest.schema.json": toolManifestV1Schema,
  "packet-index.schema.json": packetIndexV1Schema,
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
