import { describe, expect, it } from "vitest";

import { CONTROL_SCHEMA_REFS, validateCredentialEnvelope } from "../packages/executor/src/index.js";

describe("executor control schema contracts", () => {
  it("exposes the published credential envelope schema ref", () => {
    expect(CONTROL_SCHEMA_REFS.credential_envelope).toBe("https://runx.ai/spec/credential-envelope.schema.json");
  });

  it("accepts the canonical credential envelope shape", () => {
    expect(validateCredentialEnvelope({
      kind: "runx.credential-envelope.v1",
      grant_id: "grant_1",
      provider: "github",
      connection_id: "conn_1",
      scopes: ["repo:read"],
      material_ref: "nango:github:conn_1",
    })).toEqual({
      kind: "runx.credential-envelope.v1",
      grant_id: "grant_1",
      provider: "github",
      connection_id: "conn_1",
      scopes: ["repo:read"],
      material_ref: "nango:github:conn_1",
    });
  });

  it("rejects envelopes with a non-canonical kind", () => {
    expect(() => validateCredentialEnvelope({
      kind: "github",
      grant_id: "grant_1",
      provider: "github",
      connection_id: "conn_1",
      scopes: ["repo:read"],
      material_ref: "nango:github:conn_1",
    })).toThrow(/credential-envelope\.schema\.json/);
  });
});
