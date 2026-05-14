import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTROL_SCHEMA_REFS,
  type DeepReadonly,
  stringEnum,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";
import { agentContextEnvelopeSchema } from "./context.js";

const agentWorkSourceTypes = ["agent", "agent-step"] as const;

export const agentWorkRequestSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    source_type: stringEnum(agentWorkSourceTypes),
    agent: Type.Optional(Type.String({ minLength: 1 })),
    task: Type.Optional(Type.String({ minLength: 1 })),
    envelope: agentContextEnvelopeSchema,
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.agent_work_request,
    additionalProperties: false,
  },
);

export type AgentWorkRequestContract = DeepReadonly<Static<typeof agentWorkRequestSchema>>;

export const questionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    required: Type.Boolean(),
    type: Type.String({ minLength: 1 }),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.question,
    additionalProperties: false,
  },
);

export type QuestionContract = DeepReadonly<Static<typeof questionSchema>>;

export const approvalGateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
    type: Type.Optional(Type.String()),
    summary: Type.Optional(unknownRecordSchema()),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.approval_gate,
    additionalProperties: false,
  },
);

export type ApprovalGateContract = DeepReadonly<Static<typeof approvalGateSchema>>;

export function validateAgentWorkRequestContract(
  value: unknown,
  label = "agent_work_request",
): AgentWorkRequestContract {
  return validateContractSchema(agentWorkRequestSchema, value, label);
}

export function validateQuestionContract(value: unknown, label = "question"): QuestionContract {
  return validateContractSchema(questionSchema, value, label);
}

export function validateApprovalGateContract(value: unknown, label = "approval_gate"): ApprovalGateContract {
  return validateContractSchema(approvalGateSchema, value, label);
}
