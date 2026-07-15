import fs from "node:fs";
import { sha256Json } from "./core.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

try {
  const input = readInputs();
  exactKeys(input, [
    "source_url", "source_allowlist", "proposed_schema", "sample_payloads", "compatibility_policy",
    "registry_ref", "registry_store_id", "schema_id", "expected_version", "idempotency_key",
    "compatibility", "validation_results", "migration_notes", "registry_event",
    "append_result", "readback_result",
  ], "inputs");

  stringValue(input.source_url);
  stringArray(input.source_allowlist);
  objectValue(input.proposed_schema);
  if (!Array.isArray(input.sample_payloads)) fail();
  const policy = objectValue(input.compatibility_policy);
  exactKeys(policy, ["breaking_allowed", "required_fields", "versioning_rule"], "compatibility_policy");
  if (typeof policy.breaking_allowed !== "boolean") fail();
  stringArray(policy.required_fields);
  stringValue(policy.versioning_rule);
  for (const key of ["registry_ref", "registry_store_id", "schema_id", "idempotency_key"]) stringValue(input[key]);
  nonNegativeInteger(input.expected_version);

  const compatibility = compatibilityValue(input.compatibility);
  const validationResults = validationResultsValue(input.validation_results);
  const migrationNotes = stringArray(input.migration_notes, "migration_notes");
  const registryEvent = registryEventValue(input.registry_event);
  const append = operationResult(input.append_result, "append_result");
  const readback = operationResult(input.readback_result, "readback_result");

  if (!compatibility.compatible) fail();
  if (registryEvent.compatibility_digest !== compatibility.verdict_digest) fail();
  const { event_digest: eventDigest, ...eventContent } = registryEvent;
  if (sha256Json(eventContent) !== eventDigest) fail();
  if (append.operation !== "append_event" || !["committed", "idempotent_replay"].includes(append.status)) fail();
  if (append.event_digest !== sha256Json(registryEvent)) fail();
  if (readback.operation !== "read_projection" || readback.status !== "read") fail();
  if (append.data_source_ref !== readback.data_source_ref || append.resource !== readback.resource || append.aggregate_id !== readback.aggregate_id) fail();
  if (input.source_url !== registryEvent.source.final_url || input.registry_ref !== append.data_source_ref || input.schema_id !== append.aggregate_id || input.idempotency_key !== append.idempotency_key) fail();
  if (append.after_version !== readback.after_version || readback.before_version !== readback.after_version) fail();

  const projection = projectionValue(readback.projection);
  if (projection.aggregate_id !== append.aggregate_id || projection.resource !== append.resource) fail();
  if (projection.version !== append.after_version || projection.last_event_ref !== append.event_ref) fail();
  if (projection.event_digests.at(-1) !== append.event_digest) fail();

  process.stdout.write(`${JSON.stringify({
    compatibility,
    validation_results: validationResults,
    migration_notes: migrationNotes,
    publish_result: {
      status: "published",
      event_digest: registryEvent.event_digest,
      stored_event_digest: append.event_digest,
      verdict_digest: compatibility.verdict_digest,
      source_digest: registryEvent.source.content_digest,
      append: safeAppend(append),
      readback: safeReadback(readback, projection),
    },
  })}\n`);
} catch {
  process.stderr.write("schema-guard result projection failed\n");
  process.exitCode = 64;
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON;
  if (!raw) fail();
  return objectValue(JSON.parse(raw));
}

function compatibilityValue(value) {
  const result = objectValue(value);
  exactKeys(result, ["compatible", "breaking_changes", "sample_coverage_supplied", "sample_coverage", "verdict_digest"], "compatibility");
  if (typeof result.compatible !== "boolean" || typeof result.sample_coverage_supplied !== "boolean") fail();
  if (!["supplied", "not_supplied"].includes(result.sample_coverage)) fail();
  digestValue(result.verdict_digest);
  if (!Array.isArray(result.breaking_changes)) fail();
  for (const change of result.breaking_changes) {
    exactKeys(objectValue(change), ["path", "old_contract", "new_contract", "policy_rule"], "breaking_change");
    stringValue(change.path); stringValue(change.policy_rule);
  }
  return result;
}

function validationResultsValue(value) {
  if (!Array.isArray(value)) fail();
  for (const result of value) {
    exactKeys(objectValue(result), ["index", "valid", "errors"], "validation_result");
    nonNegativeInteger(result.index);
    if (typeof result.valid !== "boolean" || !Array.isArray(result.errors)) fail();
    for (const error of result.errors) {
      exactKeys(objectValue(error), ["path", "keyword", "expected", "actual"], "validation_error");
      stringValue(error.path); stringValue(error.keyword);
    }
  }
  return value;
}

function registryEventValue(value) {
  const event = objectValue(value);
  exactKeys(event, ["type", "schema_id", "source", "proposed_schema_digest", "compatibility_digest", "validation_summary", "event_digest"], "registry_event");
  if (event.type !== "schema.version.recorded") fail();
  if (event.schema_id !== null) stringValue(event.schema_id);
  exactKeys(objectValue(event.source), ["content_digest", "final_url"], "registry_event.source");
  digestValue(event.source.content_digest); stringValue(event.source.final_url);
  digestValue(event.proposed_schema_digest); digestValue(event.compatibility_digest); digestValue(event.event_digest);
  exactKeys(objectValue(event.validation_summary), ["invalid_count", "sample_count", "sample_coverage_supplied", "valid_count"], "validation_summary");
  nonNegativeInteger(event.validation_summary.invalid_count);
  nonNegativeInteger(event.validation_summary.sample_count);
  nonNegativeInteger(event.validation_summary.valid_count);
  if (typeof event.validation_summary.sample_coverage_supplied !== "boolean") fail();
  return event;
}

function operationResult(value, label) {
  const result = objectValue(value);
  exactKeys(result, [
    "schema", "data_source_ref", "provider", "operation", "resource", "aggregate_id", "status",
    "before_version", "after_version", "idempotency_key", "event_ref", "event_digest", "result_digest",
    "projection_digest", "projection", "events", "rows", "redactions", "stop_conditions", "provider_evidence",
  ], label, true);
  if (result.schema !== "runx.data.operation_result.v1") fail();
  for (const key of ["data_source_ref", "provider", "operation", "resource", "aggregate_id", "status"]) stringValue(result[key]);
  nonNegativeInteger(result.before_version); nonNegativeInteger(result.after_version);
  for (const key of ["idempotency_key", "event_ref", "event_digest"]) {
    if (result[key] !== null) stringValue(result[key]);
  }
  if (result.event_digest !== null) digestValue(result.event_digest);
  digestValue(result.result_digest); digestValue(result.projection_digest);
  for (const key of ["events", "rows", "redactions", "stop_conditions"]) if (!Array.isArray(result[key])) fail();
  if (result.provider_evidence !== undefined) objectValue(result.provider_evidence);
  return result;
}

function projectionValue(value) {
  const projection = objectValue(value);
  exactKeys(projection, ["aggregate_id", "resource", "version", "event_count", "last_event_ref", "last_event_type", "event_digests"], "readback projection");
  stringValue(projection.aggregate_id); stringValue(projection.resource);
  nonNegativeInteger(projection.version); nonNegativeInteger(projection.event_count);
  if (projection.last_event_ref !== null) stringValue(projection.last_event_ref);
  if (projection.last_event_type !== null) stringValue(projection.last_event_type);
  if (!Array.isArray(projection.event_digests)) fail();
  projection.event_digests.forEach(digestValue);
  return projection;
}

function safeAppend(value) {
  return pick(value, ["schema", "data_source_ref", "provider", "operation", "resource", "aggregate_id", "status", "before_version", "after_version", "idempotency_key", "event_ref", "event_digest", "result_digest", "projection_digest"]);
}

function safeReadback(value, projection) {
  return { ...pick(value, ["schema", "data_source_ref", "provider", "operation", "resource", "aggregate_id", "status", "before_version", "after_version", "result_digest", "projection_digest"]), projection };
}

function pick(value, keys) { return Object.fromEntries(keys.map((key) => [key, value[key]])); }
function objectValue(value) { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(); return value; }
function stringValue(value) { if (typeof value !== "string" || value.length === 0) fail(); return value; }
function digestValue(value) { if (typeof value !== "string" || !DIGEST.test(value)) fail(); return value; }
function nonNegativeInteger(value) { if (!Number.isInteger(value) || value < 0) fail(); return value; }
function stringArray(value, label) { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(); return value; }
function exactKeys(value, expected, label, optional = false) {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail();
  if (!optional && expected.some((key) => !Object.hasOwn(value, key))) fail();
  const required = optional ? expected.filter((key) => !["projection", "provider_evidence"].includes(key)) : [];
  if (required.some((key) => !Object.hasOwn(value, key))) fail();
}
function fail() { throw new Error("invalid governed result evidence"); }
