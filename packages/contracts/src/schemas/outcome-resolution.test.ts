import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  outcomeResolutionSchema,
  outcomeResolutionSchemaVersion,
  type OutcomeResolutionContract,
} from "./outcome-resolution.js";

const valid: OutcomeResolutionContract = {
  schema_version: outcomeResolutionSchemaVersion,
  id: "or_abc",
  receipt_id: "rx_def",
  outcome_state: "complete",
  created_at: "2026-04-28T07:00:00Z",
  issuer: {
    type: "local",
    kid: "local_aaaa",
    public_key_sha256: "deadbeef",
  },
  signature: {
    alg: "Ed25519",
    value: "AAA",
  },
};

describe("outcome-resolution schema", () => {
  it("accepts a minimal valid resolution", () => {
    expect(Value.Check(outcomeResolutionSchema, valid)).toBe(true);
  });

  it("rejects a resolution with the wrong schema_version", () => {
    expect(Value.Check(outcomeResolutionSchema, { ...valid, schema_version: "runx.receipt.outcome-resolution.v0" })).toBe(false);
  });

  it("rejects a resolution missing required signature", () => {
    const { signature: _drop, ...withoutSignature } = valid;
    expect(Value.Check(outcomeResolutionSchema, withoutSignature)).toBe(false);
  });

  it("rejects an unknown outcome_state", () => {
    expect(Value.Check(outcomeResolutionSchema, { ...valid, outcome_state: "weird" })).toBe(false);
  });

  it("rejects null", () => {
    expect(Value.Check(outcomeResolutionSchema, null)).toBe(false);
  });
});
