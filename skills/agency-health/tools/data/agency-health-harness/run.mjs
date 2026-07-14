import crypto from "node:crypto";
import fs from "node:fs";

const inputs = readInputs();
const operation = requiredString(inputs.operation, "operation");
const dataSourceRef = requiredString(inputs.data_source_ref, "data_source_ref");
const resource = requiredString(inputs.resource, "resource");
const aggregateId = requiredString(inputs.aggregate_id, "aggregate_id");
const binding = objectValue(inputs.data_source_binding);

if (dataSourceRef !== "local://agency-health/harness") {
  throw new Error("data.agency-health-harness is restricted to local://agency-health/harness");
}
if (binding.profile !== "agency-health-harness-v1") {
  throw new Error("agency-health harness binding profile is required");
}
if (resource !== "agency_cases") {
  throw new Error("agency-health harness adapter reads only agency_cases");
}
if (operation !== "read_projection" && operation !== "read_events") {
  throw new Error("agency-health harness adapter is read-only; operation must be read_projection or read_events");
}

const cases = objectValue(binding.cases);
const sourceRows = Array.isArray(cases[aggregateId]) ? cases[aggregateId] : [];
const entries = sourceRows.map((row, index) => normalizeEntry(row, index + 1));
const selected = operation === "read_events"
  ? readPage(entries, inputs.after_version, inputs.limit)
  : [];
const projection = {
  aggregate_id: aggregateId,
  resource,
  version: entries.length,
  event_count: entries.length,
  last_event_ref: entries.at(-1)?.event_ref ?? null,
  last_event_type: entries.at(-1)?.event?.type ?? null,
  event_digests: entries.map((entry) => entry.event_digest),
};
const body = operation === "read_projection" ? projection : selected;

const result = {
  schema: "runx.data.operation_result.v1",
  data_source_ref: dataSourceRef,
  provider: "agency-health-harness-replay",
  operation,
  resource,
  aggregate_id: aggregateId,
  status: "read",
  before_version: entries.length,
  after_version: entries.length,
  idempotency_key: null,
  event_ref: null,
  event_digest: null,
  result_digest: sha256Json(body),
  projection_digest: sha256Json(projection),
  projection: operation === "read_projection" ? projection : null,
  events: selected,
  rows: selected,
  redactions: [],
  stop_conditions: [],
  provider_evidence: {
    provider: "agency-health-harness-replay",
    profile: binding.profile,
    resource,
    aggregate_id: aggregateId,
    storage_class: "inline-read-only-replay",
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function normalizeEntry(value, version) {
  const row = objectValue(value);
  const event = objectValue(row.event);
  if (!requiredString(event.type, `cases event ${version} type`)) {
    throw new Error(`cases event ${version} type is required`);
  }
  const committedAt = normalizeIso(row.committed_at, `cases event ${version} committed_at`);
  return {
    event_ref: `agency_cases:${aggregateId}:${version}`,
    version,
    event_type: event.type,
    event,
    event_digest: sha256Json(event),
    idempotency_key: `agency-health-harness:${aggregateId}:${version}`,
    committed_at: committedAt,
  };
}

function readPage(entries, afterValue, limitValue) {
  const after = afterValue === undefined || afterValue === null ? null : nonNegativeInteger(afterValue, "after_version");
  const limit = limitValue === undefined || limitValue === null ? 500 : boundedInteger(limitValue, "limit", 1, 500);
  return (after === null ? entries : entries.filter((entry) => entry.version > after)).slice(0, limit);
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeIso(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be ISO-8601`);
  return new Date(value).toISOString();
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function boundedInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be from ${min} to ${max}`);
  return value;
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
