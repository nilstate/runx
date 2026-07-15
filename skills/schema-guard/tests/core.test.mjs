import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSchemaChange, canonicalJson, sha256Json } from "../core.mjs";

const current = {
  $id: "invoice-v1",
  type: "object",
  required: ["id", "status"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["draft", "paid"] },
  },
};

const policy = {
  breaking_allowed: false,
  required_fields: ["id", "status"],
  versioning_rule: "semver_minor_for_additive",
};

function evaluate(proposedSchema, samplePayloads = [{ id: "inv-1", status: "paid" }], overrides = {}) {
  return evaluateSchemaChange({
    currentSchema: current,
    proposedSchema,
    samplePayloads,
    policy: { ...policy, ...overrides },
    source: { final_url: "https://example.test/invoice.json", content_digest: "sha256:source" },
  });
}

test("accepts an additive optional property and emits a registry event", () => {
  const proposed = structuredClone(current);
  proposed.properties.memo = { type: "string" };
  const result = evaluate(proposed);
  assert.equal(result.compatibility.compatible, true);
  assert.equal(result.compatibility.breaking_changes.length, 0);
  assert.equal(result.registry_event.type, "schema.version.recorded");
  assert.equal(result.registry_event.compatibility_digest, result.compatibility.verdict_digest);
});

test("reports field path old contract new contract and rule for a type change", () => {
  const proposed = structuredClone(current);
  proposed.properties.status = { type: "number" };
  const result = evaluate(proposed, []);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.breaking_changes[0], {
    path: "/properties/status/type",
    old_contract: "string",
    new_contract: "number",
    policy_rule: "property_type_must_not_change",
  });
  assert.equal(result.registry_event, null);
});

test("refuses deletion of a property and identifies the removed contract", () => {
  const proposed = structuredClone(current);
  delete proposed.properties.status;
  proposed.required = ["id"];
  const result = evaluate(proposed, []);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.breaking_changes, [{
    path: "/properties/status",
    old_contract: { type: "string", enum: ["draft", "paid"] },
    new_contract: null,
    policy_rule: "property_must_not_be_removed",
  }]);
  assert.equal(result.registry_event, null);
});

test("refuses changing an optional property to required", () => {
  const currentWithMemo = structuredClone(current);
  currentWithMemo.properties.memo = { type: "string" };
  const proposed = structuredClone(current);
  proposed.properties.memo = { type: "string" };
  proposed.required = ["id", "status", "memo"];
  const result = evaluateSchemaChange({
    currentSchema: currentWithMemo,
    proposedSchema: proposed,
    samplePayloads: [{ id: "inv-1", status: "paid", memo: "note" }],
    policy,
    source: { final_url: "https://example.test/invoice.json", content_digest: "sha256:source" },
  });
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.breaking_changes[0], {
    path: "/required/memo",
    old_contract: "optional",
    new_contract: "required",
    policy_rule: "optional_property_must_not_become_required",
  });
  assert.equal(result.registry_event, null);
});

test("refuses adding a required property even when supplied samples contain it unless policy allows breaking changes", () => {
  const proposed = structuredClone(current);
  proposed.properties.memo = { type: "string" };
  proposed.required = ["id", "status", "memo"];
  const result = evaluate(proposed, [{ id: "inv-1", status: "paid", memo: "note" }]);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.breaking_changes[0], {
    path: "/required/memo",
    old_contract: null,
    new_contract: "required",
    policy_rule: "new_required_property_needs_explicit_transition",
  });
  assert.equal(result.registry_event, null);
});

test("refuses narrowing an enum", () => {
  const proposed = structuredClone(current);
  proposed.properties.status.enum = ["paid"];
  const result = evaluate(proposed, []);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.breaking_changes[0], {
    path: "/properties/status/enum",
    old_contract: ["draft", "paid"],
    new_contract: ["paid"],
    policy_rule: "enum_must_not_narrow",
  });
});

test("accepts widening an enum", () => {
  const proposed = structuredClone(current);
  proposed.properties.status.enum = ["draft", "paid", "void"];
  const result = evaluate(proposed);
  assert.equal(result.compatibility.compatible, true);
  assert.equal(result.compatibility.breaking_changes.length, 0);
  assert.ok(result.registry_event);
});

test("refuses adding a format constraint to an existing property", () => {
  const proposed = structuredClone(current);
  proposed.properties.id.format = "uuid";
  const result = evaluate(proposed, []);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.compatibility.breaking_changes[0], {
    path: "/properties/id/format",
    old_contract: null,
    new_contract: "uuid",
    policy_rule: "format_must_not_become_stricter",
  });
  assert.equal(result.registry_event, null);
});

test("rejects malformed schemas before producing a registry event", () => {
  assert.throws(
    () => evaluate({ type: "array", items: { type: "string" } }),
    /proposed_schema.*object schema/i,
  );
  assert.throws(
    () => evaluate({ type: "object", properties: { status: { type: "made-up" } } }),
    /unsupported.*type/i,
  );
  assert.throws(
    () => evaluate({ type: "object", properties: { status: { type: "string", format: "made-up" } } }),
    /unsupported.*format/i,
  );
});

test("reports sample payload type, required, enum, and format errors", () => {
  const proposed = structuredClone(current);
  proposed.properties.email = { type: "string", format: "email" };
  const result = evaluate(
    proposed,
    [{ id: "inv-1", status: "unknown", email: "not-an-email" }, { id: 42, status: "paid" }],
  );
  assert.equal(result.compatibility.compatible, false);
  assert.equal(result.validation_results.length, 2);
  assert.equal(result.validation_results[0].valid, false);
  assert.deepEqual(result.validation_results[0].errors.map(({ path, keyword }) => ({ path, keyword })), [
    { path: "/status", keyword: "enum" },
    { path: "/email", keyword: "format" },
  ]);
  assert.deepEqual(result.validation_results[1].errors.map(({ path, keyword }) => ({ path, keyword })), [
    { path: "/id", keyword: "type" },
  ]);
  assert.equal(result.registry_event, null);
});

test("reports a missing declared required field in sample validation", () => {
  const result = evaluate(structuredClone(current), [{ id: "inv-1" }]);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.validation_results[0].errors, [{
    path: "/status",
    keyword: "required",
    expected: "present",
    actual: "missing",
  }]);
  assert.equal(result.registry_event, null);
});

test("rejects calendar-invalid values for date format validation", () => {
  const proposed = structuredClone(current);
  proposed.properties.due_date = { type: "string", format: "date" };
  const result = evaluate(proposed, [{ id: "inv-1", status: "paid", due_date: "2024-02-31" }]);
  assert.equal(result.compatibility.compatible, false);
  assert.deepEqual(result.validation_results[0].errors.map(({ path, keyword }) => ({ path, keyword })), [
    { path: "/due_date", keyword: "format" },
  ]);
});

test("marks empty samples as not supplied instead of inventing coverage", () => {
  const proposed = structuredClone(current);
  proposed.properties.memo = { type: "string" };
  const result = evaluate(proposed, []);
  assert.equal(result.compatibility.sample_coverage_supplied, false);
  assert.equal(result.compatibility.sample_coverage, "not_supplied");
  assert.deepEqual(result.validation_results, []);
  assert.equal(result.compatibility.compatible, true);
});

test("allows a configured breaking change but still records the exact violation", () => {
  const proposed = structuredClone(current);
  proposed.properties.status = { type: "number" };
  const result = evaluate(proposed, [], { breaking_allowed: true });
  assert.equal(result.compatibility.compatible, true);
  assert.equal(result.compatibility.breaking_changes.length, 1);
  assert.ok(result.registry_event);
});

test("produces stable canonical JSON and verdict digests independent of object key order", () => {
  const left = { z: 1, nested: { b: true, a: ["x", 2] }, a: "first" };
  const right = { a: "first", nested: { a: ["x", 2], b: true }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256Json(left), sha256Json(right));

  const proposed = structuredClone(current);
  proposed.properties.memo = { type: "string" };
  const first = evaluate(proposed);
  const reordered = {
    properties: { memo: { type: "string" }, status: { type: "string", enum: ["draft", "paid"] }, id: { type: "string" } },
    required: ["id", "status"],
    type: "object",
    $id: "invoice-v1",
  };
  const second = evaluate(reordered);
  assert.equal(first.compatibility.verdict_digest, second.compatibility.verdict_digest);
  assert.equal(first.registry_event.event_digest, second.registry_event.event_digest);
});
