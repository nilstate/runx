import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  localGraphReceiptSchema,
  localReceiptSchema,
  localReceiptSchemaVersion,
  localSkillReceiptSchema,
  type LocalGraphReceiptContract,
  type LocalSkillReceiptContract,
} from "./local-receipt.js";

const validSkillReceipt: LocalSkillReceiptContract = {
  schema_version: localReceiptSchemaVersion,
  id: "rx_abc123",
  kind: "skill_execution",
  issuer: {
    type: "local",
    kid: "local_aaaa",
    public_key_sha256: "deadbeef",
  },
  skill_name: "evolve",
  source_type: "graph",
  status: "success",
  duration_ms: 12,
  input_hash: "sha256:in",
  output_hash: "sha256:out",
  context_from: [],
  execution: {
    exit_code: 0,
    signal: null,
  },
  signature: {
    alg: "Ed25519",
    value: "AAA",
  },
};

const validGraphReceipt: LocalGraphReceiptContract = {
  schema_version: localReceiptSchemaVersion,
  id: "gx_abc123",
  kind: "graph_execution",
  issuer: {
    type: "local",
    kid: "local_aaaa",
    public_key_sha256: "deadbeef",
  },
  graph_name: "fanout",
  status: "success",
  duration_ms: 99,
  input_hash: "sha256:in",
  output_hash: "sha256:out",
  steps: [],
  signature: {
    alg: "Ed25519",
    value: "AAA",
  },
};

describe("local-receipt schemas", () => {
  it("accepts a minimal valid skill receipt", () => {
    expect(Value.Check(localSkillReceiptSchema, validSkillReceipt)).toBe(true);
    expect(Value.Check(localReceiptSchema, validSkillReceipt)).toBe(true);
  });

  it("accepts a minimal valid graph receipt", () => {
    expect(Value.Check(localGraphReceiptSchema, validGraphReceipt)).toBe(true);
    expect(Value.Check(localReceiptSchema, validGraphReceipt)).toBe(true);
  });

  it("rejects a receipt with the wrong schema_version", () => {
    expect(Value.Check(localSkillReceiptSchema, { ...validSkillReceipt, schema_version: "runx.receipt.v0" })).toBe(false);
  });

  it("rejects a skill receipt missing required signature", () => {
    const { signature: _drop, ...withoutSignature } = validSkillReceipt;
    expect(Value.Check(localSkillReceiptSchema, withoutSignature)).toBe(false);
  });

  it("rejects a skill receipt with the wrong kind", () => {
    expect(Value.Check(localSkillReceiptSchema, { ...validSkillReceipt, kind: "graph_execution" })).toBe(false);
  });

  it("rejects null", () => {
    expect(Value.Check(localReceiptSchema, null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(Value.Check(localReceiptSchema, [validSkillReceipt])).toBe(false);
  });

  it("rejects unknown top-level fields under additionalProperties: false", () => {
    expect(
      Value.Check(localSkillReceiptSchema, { ...validSkillReceipt, unexpected_field: "x" }),
    ).toBe(false);
  });
});
