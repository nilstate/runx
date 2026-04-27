import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_CONTRACT_IDS,
  RUNX_LOGICAL_SCHEMAS,
  type DeepReadonly,
  stringEnum,
  unknownRecordSchema,
} from "../internal.js";

const fixtureLanes = ["deterministic", "agent", "repo-integration"] as const;

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
