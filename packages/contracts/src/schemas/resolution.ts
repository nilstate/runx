import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTROL_SCHEMA_REFS,
  type DeepReadonly,
  asUnknownRecord,
  stringEnum,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";
import { agentWorkRequestSchema, approvalGateSchema, questionSchema } from "./agent-work.js";

const resolutionResponseActors = ["human", "agent"] as const;
const adapterInvokeTerminalStatuses = ["success", "failure"] as const;
const nodeSignalNames = [
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGBREAK",
  "SIGLOST",
  "SIGINFO",
] as const;

export const inputResolutionRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Literal("input"),
    questions: Type.Array(questionSchema),
  },
  { additionalProperties: false },
);

export type InputResolutionRequestContract = DeepReadonly<Static<typeof inputResolutionRequestSchema>>;

export const approvalResolutionRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Literal("approval"),
    gate: approvalGateSchema,
  },
  { additionalProperties: false },
);

export type ApprovalResolutionRequestContract = DeepReadonly<Static<typeof approvalResolutionRequestSchema>>;

export const cognitiveResolutionRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: Type.Literal("cognitive_work"),
    work: agentWorkRequestSchema,
  },
  { additionalProperties: false },
);

export type CognitiveResolutionRequestContract = DeepReadonly<Static<typeof cognitiveResolutionRequestSchema>>;

export const resolutionRequestSchema = Type.Union(
  [
    inputResolutionRequestSchema,
    approvalResolutionRequestSchema,
    cognitiveResolutionRequestSchema,
  ],
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.resolution_request,
  },
);

export type ResolutionRequestContract = DeepReadonly<Static<typeof resolutionRequestSchema>>;

export const resolutionResponseSchema = Type.Object(
  {
    actor: stringEnum(resolutionResponseActors),
    payload: Type.Unknown(),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.resolution_response,
    additionalProperties: false,
  },
);

export type ResolutionResponseContract = DeepReadonly<Static<typeof resolutionResponseSchema>>;

export const adapterInvokeTerminalResultSchema = Type.Object(
  {
    status: stringEnum(adapterInvokeTerminalStatuses),
    stdout: Type.String(),
    stderr: Type.String(),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([stringEnum(nodeSignalNames), Type.Null()]),
    durationMs: Type.Integer({ minimum: 0 }),
    errorMessage: Type.Optional(Type.String()),
    metadata: Type.Optional(unknownRecordSchema()),
  },
  { additionalProperties: false },
);

export const adapterInvokeNeedsResolutionResultSchema = Type.Object(
  {
    status: Type.Literal("needs_resolution"),
    stdout: Type.String(),
    stderr: Type.String(),
    exitCode: Type.Null(),
    signal: Type.Null(),
    durationMs: Type.Integer({ minimum: 0 }),
    request: resolutionRequestSchema,
    errorMessage: Type.Optional(Type.String()),
    metadata: Type.Optional(unknownRecordSchema()),
  },
  { additionalProperties: false },
);

const adapterInvokeNeedsResolutionResultEnvelopeSchema = Type.Object(
  {
    status: Type.Literal("needs_resolution"),
    stdout: Type.String(),
    stderr: Type.String(),
    exitCode: Type.Null(),
    signal: Type.Null(),
    durationMs: Type.Integer({ minimum: 0 }),
    request: Type.Unknown(),
    errorMessage: Type.Optional(Type.String()),
    metadata: Type.Optional(unknownRecordSchema()),
  },
  { additionalProperties: false },
);

export const adapterInvokeResultSchema = Type.Union(
  [
    adapterInvokeTerminalResultSchema,
    adapterInvokeNeedsResolutionResultSchema,
  ],
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.adapter_invoke_result,
  },
);

export type AdapterInvokeResultContract = DeepReadonly<Static<typeof adapterInvokeResultSchema>>;

export function validateResolutionRequestContract(
  value: unknown,
  label = "resolution_request",
): ResolutionRequestContract {
  const record = asUnknownRecord(value);
  if (record?.kind === "input") {
    return validateContractSchema(inputResolutionRequestSchema, value, label) as ResolutionRequestContract;
  }
  if (record?.kind === "approval") {
    return validateContractSchema(approvalResolutionRequestSchema, value, label) as ResolutionRequestContract;
  }
  if (record?.kind === "cognitive_work") {
    return validateContractSchema(cognitiveResolutionRequestSchema, value, label) as ResolutionRequestContract;
  }
  return validateContractSchema(resolutionRequestSchema, value, label);
}

export function validateResolutionResponseContract(
  value: unknown,
  label = "resolution_response",
): ResolutionResponseContract {
  return validateContractSchema(resolutionResponseSchema, value, label);
}

export function validateAdapterInvokeResultContract(
  value: unknown,
  label = "adapter_invoke_result",
): AdapterInvokeResultContract {
  const record = asUnknownRecord(value);
  if (record?.status === "success" || record?.status === "failure") {
    return validateContractSchema(adapterInvokeTerminalResultSchema, value, label) as AdapterInvokeResultContract;
  }
  if (record?.status === "needs_resolution") {
    const result = validateContractSchema(adapterInvokeNeedsResolutionResultEnvelopeSchema, value, label);
    return {
      ...result,
      request: validateResolutionRequestContract(result.request, `${label}.request`),
    } as AdapterInvokeResultContract;
  }
  return validateContractSchema(adapterInvokeResultSchema, value, label);
}
