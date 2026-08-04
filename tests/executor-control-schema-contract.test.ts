import { describe, expect, it } from "vitest";

import {
  RUNX_CONTROL_SCHEMA_REFS,
  validateCredentialEnvelopeContract,
} from "@runxhq/contracts";

describe("executor control schema contracts", () => {
  it("exposes the published credential envelope schema ref", () => {
    expect(RUNX_CONTROL_SCHEMA_REFS.credential_envelope).toBe("https://runx.ai/spec/credential-envelope.schema.json");
  });

  it("accepts the canonical credential envelope shape", () => {
    expect(validateCredentialEnvelopeContract({
      kind: "runx.credential-envelope.v1",
      grant_id: "grant_1",
      provider: "github",
      auth_mode: "api_key",
      material_kind: "api_key",
      provider_reference: "local_per_run",
      scopes: ["repo:read"],
      grant_reference: {
        grant_id: "grant_1",
        scope_family: "github_repo",
        authority_kind: "read_only",
        target_repo: "runxhq/runx",
      },
      material_ref: "local:github:grant_1",
    })).toEqual({
      kind: "runx.credential-envelope.v1",
      grant_id: "grant_1",
      provider: "github",
      auth_mode: "api_key",
      material_kind: "api_key",
      provider_reference: "local_per_run",
      scopes: ["repo:read"],
      grant_reference: {
        grant_id: "grant_1",
        scope_family: "github_repo",
        authority_kind: "read_only",
        target_repo: "runxhq/runx",
        target_locator: undefined,
      },
      material_ref: "local:github:grant_1",
    });
  });

  it("rejects envelopes with a non-canonical kind", () => {
    expect(() => validateCredentialEnvelopeContract({
      kind: "github",
      grant_id: "grant_1",
      provider: "github",
      provider_reference: "local_per_run",
      scopes: ["repo:read"],
      material_ref: "local:github:grant_1",
    })).toThrow(/credential-envelope\.schema\.json/);
  });
});
