import { describe, expect, it } from "vitest";

import { CONTROL_SCHEMA_REFS, validateGraphReceiptGovernance, validateScopeAdmission } from "@runxhq/core/receipts";

describe("receipt governance schema contracts", () => {
  it("exposes the published scope admission schema ref", () => {
    expect(CONTROL_SCHEMA_REFS.scope_admission).toBe("https://runx.ai/spec/scope-admission.schema.json");
  });

  it("accepts the canonical scope admission shape", () => {
    expect(validateScopeAdmission({
      status: "allow",
      requested_scopes: ["repo:status"],
      granted_scopes: ["repo:*"],
      grant_id: "grant_1",
      reasons: ["bounded prerelease scope"],
      decision_summary: "Allowed by the parent grant.",
    })).toEqual({
      status: "allow",
      requested_scopes: ["repo:status"],
      granted_scopes: ["repo:*"],
      grant_id: "grant_1",
      reasons: ["bounded prerelease scope"],
      decision_summary: "Allowed by the parent grant.",
    });
  });

  it("normalizes governance wrappers around scope admission", () => {
    expect(validateGraphReceiptGovernance({
      scope_admission: {
        status: "deny",
        requested_scopes: ["deployments:write"],
        granted_scopes: [],
        reasons: ["missing grant"],
      },
    })).toEqual({
      scope_admission: {
        status: "deny",
        requested_scopes: ["deployments:write"],
        granted_scopes: [],
        reasons: ["missing grant"],
        grant_id: undefined,
        decision_summary: undefined,
      },
    });
  });

  it("rejects invalid scope admission statuses", () => {
    expect(() => validateScopeAdmission({
      status: "pending",
      requested_scopes: ["repo:status"],
      granted_scopes: ["repo:*"],
    } as never)).toThrow(/scope-admission\.schema\.json/);
  });
});
