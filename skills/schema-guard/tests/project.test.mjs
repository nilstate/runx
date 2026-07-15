import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256Json } from "../core.mjs";

const runner = fileURLToPath(new URL("../project.mjs", import.meta.url));
const digest = (character) => `sha256:${character.repeat(64)}`;

function inputs(overrides = {}) {
  const compatibility = {
    compatible: true,
    breaking_changes: [],
    sample_coverage_supplied: true,
    sample_coverage: "supplied",
    verdict_digest: digest("a"),
  };
  const registryEventContent = {
    type: "schema.version.recorded",
    schema_id: "invoice-v1",
    source: {
      final_url: "https://schemas.example.test/invoice.json",
      content_digest: digest("b"),
    },
    proposed_schema_digest: digest("c"),
    compatibility_digest: compatibility.verdict_digest,
    validation_summary: {
      sample_count: 1,
      valid_count: 1,
      invalid_count: 0,
      sample_coverage_supplied: true,
    },
  };
  const registry_event = {
    ...registryEventContent,
    event_digest: sha256Json(registryEventContent),
  };
  const storedEventDigest = sha256Json(registry_event);
  const append_result = {
    schema: "runx.data.operation_result.v1",
    data_source_ref: "local://schema-guard/test",
    provider: "local-json-event-store",
    operation: "append_event",
    resource: "schema_registry_versions",
    aggregate_id: "invoice",
    status: "committed",
    before_version: 0,
    after_version: 1,
    idempotency_key: "invoice:test:v1",
    event_ref: "schema_registry_versions:invoice:1",
    event_digest: storedEventDigest,
    result_digest: digest("d"),
    projection_digest: digest("e"),
    events: [], rows: [], redactions: [], stop_conditions: [],
    provider_evidence: { secret: "provider-secret" },
  };
  const readback_result = {
    schema: "runx.data.operation_result.v1",
    data_source_ref: append_result.data_source_ref,
    provider: append_result.provider,
    operation: "read_projection",
    resource: append_result.resource,
    aggregate_id: append_result.aggregate_id,
    status: "read",
    before_version: 1,
    after_version: 1,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: digest("f"),
    projection_digest: digest("0"),
    projection: {
      aggregate_id: "invoice",
      resource: "schema_registry_versions",
      version: 1,
      event_count: 1,
      last_event_ref: append_result.event_ref,
      last_event_type: registry_event.type,
      event_digests: [storedEventDigest],
    },
    events: [], rows: [], redactions: [], stop_conditions: [],
    provider_evidence: { token: "readback-secret" },
  };
  return {
    source_url: registry_event.source.final_url,
    source_allowlist: ["schemas.example.test"],
    proposed_schema: { type: "object", properties: {}, required: [] },
    sample_payloads: [{ id: "inv-1" }],
    compatibility_policy: {
      breaking_allowed: false,
      required_fields: [],
      versioning_rule: "semver_minor_for_additive",
    },
    registry_ref: append_result.data_source_ref,
    registry_store_id: "schema-guard-test-v1",
    schema_id: append_result.aggregate_id,
    expected_version: 0,
    idempotency_key: append_result.idempotency_key,
    compatibility,
    validation_results: [{ index: 0, valid: true, errors: [] }],
    migration_notes: ["Optional property added at /properties/memo."],
    registry_event,
    append_result,
    readback_result,
    ...overrides,
  };
}

function run(input) {
  return spawnSync(process.execPath, [runner], {
    env: {
      ...process.env,
      RUNX_INPUTS_JSON: JSON.stringify(input),
      RUNX_PRIVATE_TOKEN: "environment-secret",
    },
    encoding: "utf8",
  });
}

test("projects exactly the governed terminal outputs and binds append to readback", () => {
  const result = run(inputs());
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), [
    "compatibility", "validation_results", "migration_notes", "publish_result",
  ]);
  assert.equal(output.publish_result.event_digest, inputs().registry_event.event_digest);
  assert.equal(output.publish_result.stored_event_digest, inputs().append_result.event_digest);
  assert.equal(output.publish_result.verdict_digest, inputs().compatibility.verdict_digest);
  assert.equal(output.publish_result.source_digest, inputs().registry_event.source.content_digest);
  assert.equal(output.publish_result.append.status, "committed");
  assert.equal(output.publish_result.readback.projection.version, 1);
  assert.doesNotMatch(result.stdout, /provider-secret|readback-secret|environment-secret/);
});

test("fails closed on extra inputs and inconsistent append/readback evidence", () => {
  for (const invalid of [
    inputs({ token: "input-secret" }),
    inputs({ compatibility: { ...inputs().compatibility, compatible: false } }),
    inputs({ readback_result: { ...inputs().readback_result, after_version: 2 } }),
  ]) {
    const result = run(invalid);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /input-secret|provider-secret|readback-secret|environment-secret/);
  }
});
