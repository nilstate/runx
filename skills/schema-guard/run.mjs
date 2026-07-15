import fs from "node:fs";
import { evaluateSchemaChange } from "./core.mjs";

try {
  const inputs = readInputs();
  const fetchResult = objectValue(inputs.fetch_result, "fetch_result");

  if (fetchResult.decision !== "ready") {
    throw new Error("fetch_result.decision must be ready");
  }
  if (!Number.isInteger(fetchResult.status) || fetchResult.status < 200 || fetchResult.status >= 300) {
    throw new Error("fetch_result.status must be an HTTP 2xx status");
  }
  if (typeof fetchResult.final_url !== "string" || fetchResult.final_url.length === 0) {
    throw new Error("fetch_result.final_url is required");
  }
  if (typeof fetchResult.content_digest !== "string" || fetchResult.content_digest.length === 0) {
    throw new Error("fetch_result.content_digest is required");
  }

  const currentSchema = parseExtracted(fetchResult.extracted);
  const proposedSchema = objectValue(inputs.proposed_schema, "proposed_schema");
  const samplePayloads = arrayValue(inputs.sample_payloads, "sample_payloads");
  const compatibilityPolicy = objectValue(inputs.compatibility_policy, "compatibility_policy");
  assertExpectedVersion(inputs.expected_version);
  assertIdempotencyKey(inputs.idempotency_key);

  const result = evaluateSchemaChange({
    currentSchema,
    proposedSchema,
    samplePayloads,
    policy: compatibilityPolicy,
    source: {
      final_url: fetchResult.final_url,
      content_digest: fetchResult.content_digest,
    },
  });

  process.stdout.write(`${JSON.stringify({
    compatibility: result.compatibility,
    validation_results: result.validation_results,
    migration_notes: result.migration_notes,
    registry_event: result.registry_event,
    expected_version: inputs.expected_version,
    idempotency_key: inputs.idempotency_key,
  })}\n`);
} catch {
  process.stderr.write("schema-guard runner failed\n");
  process.exitCode = 64;
}

function readInputs() {
  let raw;
  if (process.env.RUNX_INPUTS_PATH) {
    raw = fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8");
  } else if (process.env.RUNX_INPUTS_JSON) {
    raw = process.env.RUNX_INPUTS_JSON;
  } else {
    throw new Error("inputs are required");
  }
  const parsed = JSON.parse(raw);
  return objectValue(parsed, "inputs");
}

function parseExtracted(extracted) {
  if (typeof extracted === "string") return objectValue(JSON.parse(extracted), "fetch_result.extracted");
  return objectValue(extracted, "fetch_result.extracted");
}

function objectValue(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function assertExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("expected_version must be a non-negative integer");
  }
}

function assertIdempotencyKey(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("idempotency_key must be a non-empty string");
  }
}
