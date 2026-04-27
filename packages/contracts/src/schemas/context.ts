import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTROL_SCHEMA_REFS,
  type DeepReadonly,
  asUnknownRecord,
  unknownRecordSchema,
  validateContractSchema,
} from "../internal.js";
import { artifactEnvelopeSchema } from "./artifact.js";
import { outputContractSchema } from "./output.js";

export const agentContextProvenanceSchema = Type.Object(
  {
    input: Type.String({ minLength: 1 }),
    output: Type.String({ minLength: 1 }),
    from_step: Type.Optional(Type.String()),
    artifact_id: Type.Optional(Type.String()),
    receipt_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type AgentContextProvenanceContract = DeepReadonly<Static<typeof agentContextProvenanceSchema>>;

export const contextDocumentSchema = Type.Object(
  {
    root_path: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    sha256: Type.String({ minLength: 1 }),
    content: Type.String(),
  },
  { additionalProperties: false },
);

export type ContextDocumentContract = DeepReadonly<Static<typeof contextDocumentSchema>>;

export const contextSchema = Type.Object(
  {
    memory: Type.Optional(contextDocumentSchema),
    conventions: Type.Optional(contextDocumentSchema),
  },
  { additionalProperties: false },
);

export type ContextContract = DeepReadonly<Static<typeof contextSchema>>;

export const qualityProfileContextSchema = Type.Object(
  {
    source: Type.Literal("SKILL.md#quality-profile"),
    sha256: Type.String({ minLength: 1 }),
    content: Type.String(),
  },
  { additionalProperties: false },
);

export type QualityProfileContextContract = DeepReadonly<Static<typeof qualityProfileContextSchema>>;

export const executionLocationSchema = Type.Object(
  {
    skill_directory: Type.String({ minLength: 1 }),
    tool_roots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export type ExecutionLocationContract = DeepReadonly<Static<typeof executionLocationSchema>>;

export const agentContextEnvelopeSchema = Type.Object(
  {
    run_id: Type.String({ minLength: 1 }),
    step_id: Type.Optional(Type.String({ minLength: 1 })),
    skill: Type.String({ minLength: 1 }),
    instructions: Type.String({ minLength: 1 }),
    inputs: unknownRecordSchema(),
    allowed_tools: Type.Array(Type.String({ minLength: 1 })),
    current_context: Type.Array(artifactEnvelopeSchema),
    historical_context: Type.Array(artifactEnvelopeSchema),
    provenance: Type.Array(agentContextProvenanceSchema),
    context: Type.Optional(contextSchema),
    voice_profile: Type.Optional(contextDocumentSchema),
    quality_profile: Type.Optional(qualityProfileContextSchema),
    execution_location: Type.Optional(executionLocationSchema),
    expected_outputs: Type.Optional(outputContractSchema),
    trust_boundary: Type.String({ minLength: 1 }),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_CONTROL_SCHEMA_REFS.agent_context_envelope,
    additionalProperties: false,
  },
);

export type AgentContextEnvelopeContract = DeepReadonly<Static<typeof agentContextEnvelopeSchema>>;

function rejectLegacyVoiceGrammar(value: unknown, label: string): void {
  const envelope = asUnknownRecord(value);
  const context = asUnknownRecord(envelope?.context);
  if (context?.voice_grammar !== undefined) {
    throw new Error(`${label}.context.voice_grammar is no longer supported; use voice_profile (${RUNX_CONTROL_SCHEMA_REFS.agent_context_envelope}).`);
  }
}

export function validateAgentContextEnvelopeContract(
  value: unknown,
  label = "agent_context_envelope",
): AgentContextEnvelopeContract {
  rejectLegacyVoiceGrammar(value, label);
  return validateContractSchema(agentContextEnvelopeSchema, value, label);
}
