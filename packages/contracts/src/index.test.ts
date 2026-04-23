import { describe, expect, it } from "vitest";

import {
  RUNX_CONTRACT_IDS,
  RUNX_AUXILIARY_SCHEMA_IDS,
  RUNX_CONTROL_SCHEMA_REFS,
  RUNX_LOGICAL_SCHEMAS,
  credentialEnvelopeSchema,
  registryBindingSchema,
  reviewReceiptOutputSchema,
  runxContractSchemas,
  runxAuxiliarySchemas,
  runxGeneratedSchemaArtifacts,
  validateCredentialEnvelopeContract,
  validateDevReportContract,
  validateDoctorReportContract,
  validateRegistryBindingContract,
  validateRunxListReportContract,
  validateReviewReceiptOutputContract,
  validateScopeAdmissionContract,
} from "./index.js";

describe("@runxhq/contracts", () => {
  it("exports stable runx logical schema identifiers", () => {
    expect(RUNX_LOGICAL_SCHEMAS.doctor).toBe("runx.doctor.v1");
    expect(RUNX_LOGICAL_SCHEMAS.receipt).toBe("runx.receipt.v1");
  });

  it("uses durable schema URI ids", () => {
    expect(RUNX_CONTRACT_IDS.toolManifest).toBe("https://schemas.runx.dev/runx/tool/manifest/v1.json");
    expect(runxContractSchemas.toolManifest.$id).toBe(RUNX_CONTRACT_IDS.toolManifest);
    expect((runxContractSchemas.dev.properties?.doctor as { readonly $ref?: string } | undefined)?.$ref)
      .toBe(RUNX_CONTRACT_IDS.doctor);
  });

  it("keeps fixture lanes aligned with authoring plan", () => {
    const lane = runxContractSchemas.fixture.properties?.lane;
    expect((lane?.anyOf as readonly { readonly const?: string }[] | undefined)?.map((entry) => entry.const)).toEqual([
      "deterministic",
      "agent",
      "repo-integration",
    ]);
  });

  it("owns credential envelope schema and runtime validation", () => {
    expect(credentialEnvelopeSchema.$id).toBe(RUNX_CONTROL_SCHEMA_REFS.credential_envelope);
    expect(validateCredentialEnvelopeContract({
      kind: "runx.credential-envelope.v1",
      grant_id: "grant_1",
      provider: "github",
      connection_id: "conn_1",
      scopes: ["repo:read"],
      material_ref: "nango:github:conn_1",
    })).toMatchObject({
      provider: "github",
      scopes: ["repo:read"],
    });
  });

  it("owns scope admission schema and runtime validation", () => {
    expect(RUNX_CONTROL_SCHEMA_REFS.scope_admission).toBe("https://runx.ai/spec/scope-admission.schema.json");
    expect(validateScopeAdmissionContract({
      status: "allow",
      requested_scopes: ["repo:status"],
      granted_scopes: ["repo:*"],
      decision_summary: "",
    })).toEqual({
      status: "allow",
      requested_scopes: ["repo:status"],
      granted_scopes: ["repo:*"],
      decision_summary: "",
    });
    expect(() => validateScopeAdmissionContract({
      status: "pending",
      requested_scopes: ["repo:status"],
      granted_scopes: ["repo:*"],
    })).toThrow(/scope-admission\.schema\.json/);
  });

  it("owns generated auxiliary schemas", () => {
    expect(registryBindingSchema.$id).toBe(RUNX_AUXILIARY_SCHEMA_IDS.registryBinding);
    expect(reviewReceiptOutputSchema.$id).toBe(RUNX_AUXILIARY_SCHEMA_IDS.reviewReceiptOutput);
    expect(runxAuxiliarySchemas.reviewReceiptOutput).toBe(reviewReceiptOutputSchema);
    expect(runxGeneratedSchemaArtifacts["doctor.schema.json"]).toBe(runxContractSchemas.doctor);
    expect(runxGeneratedSchemaArtifacts["review-receipt-output.schema.json"]).toBe(reviewReceiptOutputSchema);
  });

  it("validates auxiliary schema payloads", () => {
    expect(validateReviewReceiptOutputContract({
      verdict: "pass",
      failure_summary: "No harness failure.",
      improvement_proposals: [],
      next_harness_checks: ["runx harness"],
    })).toMatchObject({ verdict: "pass" });

    expect(validateRegistryBindingContract({
      schema: "runx.registry_binding.v1",
      state: "registry_bound",
      skill: {
        id: "runx/sourcey",
        name: "sourcey",
        description: "Docs skill.",
      },
      upstream: {
        host: "github.com",
        owner: "runxhq",
        repo: "runx",
        path: "skills/sourcey",
        commit: "abc123",
        blob_sha: "def456",
        source_of_truth: true,
      },
      registry: {
        owner: "runx",
        trust_tier: "upstream-owned",
        version: "1.0.0",
        profile_path: "X.yaml",
        materialized_package_is_registry_artifact: true,
      },
      harness: {
        status: "harness_verified",
        case_count: 1,
      },
    })).toMatchObject({ schema: "runx.registry_binding.v1" });
  });

  it("validates machine report payloads from TypeBox-owned contracts", () => {
    expect(validateDoctorReportContract({
      schema: RUNX_LOGICAL_SCHEMAS.doctor,
      status: "success",
      summary: {
        errors: 0,
        warnings: 1,
        infos: 0,
      },
      diagnostics: [{
        id: "runx.tool.fixture.missing",
        instance_id: "sha256:fixture",
        severity: "warning",
        title: "Missing fixture",
        message: "Tool has no deterministic fixture.",
        target: {
          kind: "tool",
          ref: "demo.echo",
        },
        location: {
          path: "tools/demo/echo/manifest.json",
        },
        repairs: [],
      }],
    })).toMatchObject({
      status: "success",
      diagnostics: [expect.objectContaining({ id: "runx.tool.fixture.missing" })],
    });

    expect(validateRunxListReportContract({
      schema: RUNX_LOGICAL_SCHEMAS.list,
      root: "/tmp/runx",
      requested_kind: "all",
      items: [{
        kind: "tool",
        name: "demo.echo",
        source: "local",
        path: "tools/demo/echo/manifest.json",
        status: "ok",
        scopes: ["repo:status"],
        emits: [{ name: "result", packet: "demo.result" }],
        fixtures: 1,
      }],
    })).toMatchObject({
      requested_kind: "all",
      items: [expect.objectContaining({ kind: "tool", fixtures: 1 })],
    });

    expect(validateDevReportContract({
      schema: RUNX_LOGICAL_SCHEMAS.dev,
      status: "success",
      doctor: {
        schema: RUNX_LOGICAL_SCHEMAS.doctor,
        status: "success",
        summary: {
          errors: 0,
          warnings: 0,
          infos: 0,
        },
        diagnostics: [],
      },
      fixtures: [{
        name: "demo-fixture",
        lane: "deterministic",
        target: {
          kind: "tool",
        },
        status: "success",
        duration_ms: 12,
        assertions: [],
      }],
      receipt_id: "rx_123",
    })).toMatchObject({
      status: "success",
      receipt_id: "rx_123",
    });
  });
});
