export const contractsPackage = "@runxhq/contracts";

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly $ref?: string;
  readonly [key: string]: unknown;
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
} as const;

export const RUNX_LOGICAL_SCHEMAS = {
  doctor: "runx.doctor.v1",
  dev: "runx.dev.v1",
  list: "runx.list.v1",
  receipt: "runx.receipt.v1",
  fixture: "runx.fixture.v1",
  toolManifest: "runx.tool.manifest.v1",
  packetIndex: "runx.packet.index.v1",
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

export const credentialGrantReferenceSchema = Type.Object(
  {
    grant_id: Type.String({ minLength: 1 }),
    scope_family: Type.String({ minLength: 1 }),
    authority_kind: Type.Union([
      Type.Literal("read_only"),
      Type.Literal("constructive"),
      Type.Literal("destructive"),
    ]),
    target_repo: Type.Optional(Type.String({ minLength: 1 })),
    target_locator: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

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

export interface CredentialGrantReferenceContract {
  readonly grant_id: string;
  readonly scope_family: string;
  readonly authority_kind: "read_only" | "constructive" | "destructive";
  readonly target_repo?: string;
  readonly target_locator?: string;
}

export interface CredentialEnvelopeContract {
  readonly kind: "runx.credential-envelope.v1";
  readonly grant_id: string;
  readonly provider: string;
  readonly connection_id: string;
  readonly scopes: readonly string[];
  readonly grant_reference?: CredentialGrantReferenceContract;
  readonly material_ref: string;
}

export const scopeAdmissionSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
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

export interface ScopeAdmissionContract {
  readonly status: "allow" | "deny";
  readonly requested_scopes: readonly string[];
  readonly granted_scopes: readonly string[];
  readonly grant_id?: string;
  readonly reasons?: readonly string[];
  readonly decision_summary?: string;
}

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
    state: Type.Union([
      Type.Literal("registry_binding_drafted"),
      Type.Literal("registry_bound"),
      Type.Literal("harness_verified"),
      Type.Literal("published"),
    ]),
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
        trust_tier: Type.Union([
          Type.Literal("upstream-owned"),
          Type.Literal("community"),
          Type.Literal("unverified"),
        ]),
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
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("failed"),
          Type.Literal("harness_verified"),
        ]),
        case_count: Type.Number(),
        assertion_count: Type.Optional(Type.Number()),
        case_names: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: true },
    ),
  },
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: RUNX_AUXILIARY_SCHEMA_IDS.registryBinding,
    title: "runx upstream registry binding",
    additionalProperties: true,
  },
);

export interface RegistryBindingContract {
  readonly schema: "runx.registry_binding.v1";
  readonly state: "registry_binding_drafted" | "registry_bound" | "harness_verified" | "published";
  readonly skill: Readonly<Record<string, unknown>> & {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
  readonly upstream: Readonly<Record<string, unknown>> & {
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly branch?: string;
    readonly commit: string;
    readonly blob_sha: string;
    readonly pr_url?: string;
    readonly merged_at?: string;
    readonly html_url?: string;
    readonly raw_url?: string;
    readonly source_of_truth: true;
  };
  readonly registry: Readonly<Record<string, unknown>> & {
    readonly owner: string;
    readonly trust_tier: "upstream-owned" | "community" | "unverified";
    readonly version: string;
    readonly install_command?: string;
    readonly run_command?: string;
    readonly profile_path: string;
    readonly materialized_package_is_registry_artifact: true;
  };
  readonly harness: Readonly<Record<string, unknown>> & {
    readonly status: "pending" | "failed" | "harness_verified";
    readonly case_count: number;
    readonly assertion_count?: number;
    readonly case_names?: readonly string[];
  };
}

export const reviewReceiptOutputSchema = Type.Object(
  {
    verdict: Type.Union([
      Type.Literal("pass"),
      Type.Literal("needs_update"),
      Type.Literal("blocked"),
    ], {
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
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: RUNX_AUXILIARY_SCHEMA_IDS.reviewReceiptOutput,
    title: "runx review-receipt output",
    description: "Output contract for the review-receipt skill. Produced by the agent-step reviewer and consumed by write-harness downstream of improve-skill.",
    additionalProperties: true,
  },
);

export interface ReviewReceiptOutputContract {
  readonly verdict: "pass" | "needs_update" | "blocked";
  readonly failure_summary: string;
  readonly improvement_proposals: readonly (Readonly<Record<string, unknown>> & {
    readonly target: string;
    readonly change: string;
    readonly rationale?: string;
    readonly risk?: string;
  })[];
  readonly next_harness_checks: readonly string[];
}

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
): Static<TSchemaValue> {
  if (Value.Check(schema, value)) {
    return value as Static<TSchemaValue>;
  }
  const firstError = [...Value.Errors(schema, value)][0];
  const schemaRef = typeof schema.$id === "string" ? schema.$id : "contract schema";
  const path = firstError?.path ? `${label}${firstError.path}` : label;
  throw new Error(`${path} must match ${schemaRef}.`);
}

const stringSchema = { type: "string" } as const;
const booleanSchema = { type: "boolean" } as const;
const objectSchema = { type: "object", additionalProperties: true } as const;

export const doctorDiagnosticSchema: JsonSchema = {
  type: "object",
  required: ["id", "instance_id", "severity", "title", "message", "target", "location", "repairs"],
  properties: {
    id: stringSchema,
    instance_id: stringSchema,
    severity: { enum: ["error", "warning", "info"] },
    title: stringSchema,
    message: stringSchema,
    target: objectSchema,
    location: objectSchema,
    evidence: objectSchema,
    repairs: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "kind", "confidence", "risk", "requires_human_review"],
        properties: {
          id: stringSchema,
          kind: {
            enum: ["create_file", "replace_file", "edit_yaml", "edit_json", "add_fixture", "run_command", "manual"],
          },
          confidence: { enum: ["low", "medium", "high"] },
          risk: { enum: ["low", "medium", "high", "sensitive"] },
          path: stringSchema,
          json_pointer: stringSchema,
          contents: stringSchema,
          patch: stringSchema,
          command: stringSchema,
          requires_human_review: booleanSchema,
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const doctorV1Schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUNX_CONTRACT_IDS.doctor,
  "x-runx-schema": RUNX_LOGICAL_SCHEMAS.doctor,
  type: "object",
  required: ["schema", "status", "summary", "diagnostics"],
  properties: {
    schema: { const: RUNX_LOGICAL_SCHEMAS.doctor },
    status: { enum: ["success", "failure"] },
    summary: {
      type: "object",
      required: ["errors", "warnings", "infos"],
      properties: {
        errors: { type: "integer", minimum: 0 },
        warnings: { type: "integer", minimum: 0 },
        infos: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    diagnostics: { type: "array", items: doctorDiagnosticSchema },
  },
  additionalProperties: false,
};

export const devV1Schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUNX_CONTRACT_IDS.dev,
  "x-runx-schema": RUNX_LOGICAL_SCHEMAS.dev,
  type: "object",
  required: ["schema", "status", "doctor", "fixtures"],
  properties: {
    schema: { const: RUNX_LOGICAL_SCHEMAS.dev },
    status: { enum: ["success", "failure", "skipped", "needs_approval"] },
    doctor: { $ref: RUNX_CONTRACT_IDS.doctor },
    fixtures: { type: "array", items: objectSchema },
    receipt_id: stringSchema,
  },
  additionalProperties: false,
};

export const listV1Schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUNX_CONTRACT_IDS.list,
  "x-runx-schema": RUNX_LOGICAL_SCHEMAS.list,
  type: "object",
  required: ["schema", "root", "requested_kind", "items"],
  properties: {
    schema: { const: RUNX_LOGICAL_SCHEMAS.list },
    root: stringSchema,
    requested_kind: { enum: ["all", "tools", "skills", "chains", "packets", "overlays"] },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "name", "source", "path", "status"],
        properties: {
          kind: { enum: ["tool", "skill", "chain", "packet", "overlay"] },
          name: stringSchema,
          source: { enum: ["local", "workspace", "dependencies", "built-in"] },
          path: stringSchema,
          status: { enum: ["ok", "invalid"] },
          diagnostics: { type: "array", items: stringSchema },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: false,
};

export const receiptV1Schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUNX_CONTRACT_IDS.receipt,
  "x-runx-schema": RUNX_LOGICAL_SCHEMAS.receipt,
  type: "object",
  required: ["schema", "run_id", "command", "status", "started_at", "root", "steps"],
  properties: {
    schema: { const: RUNX_LOGICAL_SCHEMAS.receipt },
    run_id: stringSchema,
    command: stringSchema,
    status: { enum: ["success", "failure", "skipped", "needs_approval"] },
    started_at: stringSchema,
    finished_at: stringSchema,
    root: stringSchema,
    unit: objectSchema,
    steps: { type: "array", items: objectSchema },
  },
  additionalProperties: false,
};

export const fixtureV1Schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUNX_CONTRACT_IDS.fixture,
  "x-runx-schema": RUNX_LOGICAL_SCHEMAS.fixture,
  type: "object",
  required: ["name", "lane", "target", "expect"],
  properties: {
    name: stringSchema,
    lane: { enum: ["deterministic", "agent", "repo-integration"] },
    target: objectSchema,
    inputs: objectSchema,
    env: objectSchema,
    agent: objectSchema,
    repo: objectSchema,
    execution: objectSchema,
    permissions: objectSchema,
    expect: objectSchema,
  },
  additionalProperties: false,
};

export const toolManifestV1Schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUNX_CONTRACT_IDS.toolManifest,
  "x-runx-schema": RUNX_LOGICAL_SCHEMAS.toolManifest,
  type: "object",
  required: ["schema", "name", "version", "source_hash", "schema_hash", "runtime", "output"],
  properties: {
    schema: { const: RUNX_LOGICAL_SCHEMAS.toolManifest },
    name: stringSchema,
    version: stringSchema,
    description: stringSchema,
    source_hash: stringSchema,
    schema_hash: stringSchema,
    runtime: objectSchema,
    inputs: objectSchema,
    output: objectSchema,
    scopes: { type: "array", items: stringSchema },
    toolkit_version: stringSchema,
  },
  additionalProperties: false,
};

export const packetIndexV1Schema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RUNX_CONTRACT_IDS.packetIndex,
  "x-runx-schema": RUNX_LOGICAL_SCHEMAS.packetIndex,
  type: "object",
  required: ["schema", "packets"],
  properties: {
    schema: { const: RUNX_LOGICAL_SCHEMAS.packetIndex },
    packets: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "package", "version", "path", "sha256"],
        properties: {
          id: stringSchema,
          package: stringSchema,
          version: stringSchema,
          path: stringSchema,
          sha256: stringSchema,
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const runxContractSchemas = {
  doctor: doctorV1Schema,
  dev: devV1Schema,
  list: listV1Schema,
  receipt: receiptV1Schema,
  fixture: fixtureV1Schema,
  toolManifest: toolManifestV1Schema,
  packetIndex: packetIndexV1Schema,
} as const;

export const runxAuxiliarySchemas = {
  registryBinding: registryBindingSchema,
  reviewReceiptOutput: reviewReceiptOutputSchema,
} as const;
