import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;

export const RUNX_SCHEMA_BASE_URL = "https://schemas.runx.dev" as const;

export const RUNX_CONTRACT_IDS = {
  doctor: `${RUNX_SCHEMA_BASE_URL}/runx/doctor/v1.json`,
  dev: `${RUNX_SCHEMA_BASE_URL}/runx/dev/v1.json`,
  list: `${RUNX_SCHEMA_BASE_URL}/runx/list/v1.json`,
  receipt: `${RUNX_SCHEMA_BASE_URL}/runx/receipt/v1.json`,
  fixture: `${RUNX_SCHEMA_BASE_URL}/runx/fixture/v1.json`,
  toolManifest: `${RUNX_SCHEMA_BASE_URL}/runx/tool/manifest/v1.json`,
  packetIndex: `${RUNX_SCHEMA_BASE_URL}/runx/packet/index/v1.json`,
  capabilityExecution: `${RUNX_SCHEMA_BASE_URL}/runx/capability-execution/v1.json`,
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
  capabilityExecution: "runx.capability_execution.v1",
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

export type UnknownRecord = Readonly<Record<string, unknown>>;
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer TValue)[] ? readonly DeepReadonly<TValue>[]
      : T extends (infer TValue)[] ? readonly DeepReadonly<TValue>[]
        : T extends object ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
          : T;

export function stringEnum<const TValue extends readonly string[]>(
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

export function unknownRecordSchema(options: Record<string, unknown> = {}) {
  return Type.Record(Type.String(), Type.Unknown(), options);
}

export function dateTimeStringSchema(options: Record<string, unknown> = {}) {
  return Type.String({
    minLength: 1,
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
    ...options,
  });
}

export function validateContractSchema<TSchemaValue extends TSchema>(
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
  const path = firstError?.path ? `${label}${formatSchemaErrorPath(firstError.path)}` : label;
  throw new Error(`${path} must match ${schemaRef}.`);
}

export function formatSchemaErrorPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.map((segment) => {
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return /^\d+$/u.test(decoded) ? `[${decoded}]` : `.${decoded}`;
  }).join("");
}

export function asUnknownRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}
