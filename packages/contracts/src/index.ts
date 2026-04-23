export const contractsPackage = "@runxhq/contracts";

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
