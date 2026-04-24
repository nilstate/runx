import { describe, expect, it } from "vitest";

import {
  RUNX_CONTRACT_IDS,
  RUNX_AUXILIARY_SCHEMA_IDS,
  RUNX_CONTROL_SCHEMA_REFS,
  RUNX_LOGICAL_SCHEMAS,
  buildHostedOpenApiSchemas,
  credentialEnvelopeSchema,
  registryBindingSchema,
  reviewReceiptOutputSchema,
  runxContractSchemas,
  runxAuxiliarySchemas,
  runxGeneratedSchemaArtifacts,
  validateCredentialEnvelopeContract,
  validateDevReportContract,
  validateDoctorReportContract,
  validateHandoffSignalContract,
  validateHandoffStateContract,
  validateRegistryBindingContract,
  validateRunxListReportContract,
  validateReviewReceiptOutputContract,
  validateScopeAdmissionContract,
  validateSuppressionRecordContract,
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
    expect(runxGeneratedSchemaArtifacts["handoff-signal.schema.json"]).toBe(runxContractSchemas.handoffSignal);
    expect(runxGeneratedSchemaArtifacts["handoff-state.schema.json"]).toBe(runxContractSchemas.handoffState);
    expect(runxGeneratedSchemaArtifacts["suppression-record.schema.json"]).toBe(runxContractSchemas.suppressionRecord);
    expect(runxGeneratedSchemaArtifacts["review-receipt-output.schema.json"]).toBe(reviewReceiptOutputSchema);
  });

  it("owns hosted OpenAPI components for cloud consumers", () => {
    const schemas = buildHostedOpenApiSchemas();

    expect(schemas).toHaveProperty("CreateRunRequest", {
      $ref: "../../spec/hosted/create-run.request.schema.json",
    });
    expect(schemas).toHaveProperty("RerunRunRequest", {
      $ref: "../../spec/hosted/run-rerun.request.schema.json",
    });
    expect(schemas).toHaveProperty("RerunRunResponse", {
      $ref: "../../spec/hosted/run-rerun.response.schema.json",
    });
    expect(schemas).toHaveProperty("RunDiffEnvelope", {
      $ref: "../../spec/hosted/run-diff.response.schema.json",
    });
    expect(schemas).toHaveProperty("PublicSkillDetailEnvelope");
    expect(schemas).toHaveProperty("KnowledgeEntryEnvelope");
    expect(schemas).toHaveProperty("ApprovalRouteSnapshot");
    expect(schemas.PolicyApprovalRouteSummary).not.toMatchObject({
      properties: expect.objectContaining({
        missing: expect.anything(),
      }),
    });
    expect(schemas.ApprovalRouteSnapshot).toMatchObject({
      properties: expect.objectContaining({
        missing: { type: "boolean" },
      }),
      required: ["route_id", "recipients"],
    });
    expect(schemas.ApprovalInboxItem).toMatchObject({
      properties: expect.objectContaining({
        route: {
          $ref: "#/components/schemas/ApprovalRouteSnapshot",
        },
      }),
    });
    expect(schemas.ApprovalInboxEnvelope).toMatchObject({
      properties: expect.objectContaining({
        next_cursor: { type: "string" },
      }),
    });
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
        trust_tier: "first_party",
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

  it("owns generic post-handoff contracts for reusable outreach state", () => {
    expect(RUNX_CONTRACT_IDS.handoffSignal).toBe("https://schemas.runx.dev/runx/handoff-signal/v1.json");
    expect(runxContractSchemas.handoffSignal.$id).toBe(RUNX_CONTRACT_IDS.handoffSignal);
    expect(validateHandoffSignalContract({
      schema: "runx.handoff_signal.v1",
      signal_id: "sig_1",
      handoff_id: "docs-pr:example/repo:001",
      boundary_kind: "external_maintainer",
      target_repo: "example/repo",
      target_locator: "github://example/repo/pulls/42",
      thread_locator: "github://example/repo/pulls/42",
      outbox_entry_id: "pull_request:docs-refresh-example-repo",
      source: "pull_request_comment",
      disposition: "requested_changes",
      recorded_at: "2026-04-24T02:30:00Z",
      actor: {
        actor_id: "maintainer",
        role: "maintainer",
      },
      source_ref: {
        type: "provider_comment",
        uri: "https://github.com/example/repo/pull/42#issuecomment-1",
      },
    })).toMatchObject({
      handoff_id: "docs-pr:example/repo:001",
      disposition: "requested_changes",
    });

    expect(validateHandoffStateContract({
      schema: "runx.handoff_state.v1",
      handoff_id: "docs-pr:example/repo:001",
      target_repo: "example/repo",
      status: "needs_revision",
      signal_count: 2,
      last_signal_id: "sig_1",
      last_signal_at: "2026-04-24T02:30:00Z",
      last_signal_disposition: "requested_changes",
    })).toMatchObject({
      status: "needs_revision",
      signal_count: 2,
    });

    expect(validateSuppressionRecordContract({
      schema: "runx.suppression_record.v1",
      record_id: "sup_1",
      scope: "contact",
      key: "mailto:maintainer@example.org",
      reason: "requested_no_contact",
      recorded_at: "2026-04-24T02:31:00Z",
      source_signal_id: "sig_2",
    })).toMatchObject({
      scope: "contact",
      reason: "requested_no_contact",
    });
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
