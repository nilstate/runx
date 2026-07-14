import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const inputs = readInputs();
const operation = requiredString("operation");
const envelope = {
  schema: "runx.data.operation_result.v1",
  data_source_ref: requiredString("data_source_ref"),
  provider: "local-json-budget-event-store",
  operation,
  resource: safeName(requiredString("resource"), "resource"),
  aggregate_id: safeName(requiredString("aggregate_id"), "aggregate_id"),
};

const store = readStore();
const stream = streamFor(store, envelope.resource, envelope.aggregate_id);
const result = operation === "append_event" ? appendEvent() : operation === "read_projection" ? readProjection() : null;
if (!result) throw new Error("operation must be append_event or read_projection");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function appendEvent() {
  const expectedVersion = nonNegativeInteger("expected_version");
  const idempotencyKey = requiredString("idempotency_key");
  const event = requiredObject("event");
  const eventDigest = sha256(event);
  const existing = stream.events.find((entry) => entry.idempotency_key === idempotencyKey);
  if (existing) {
    if (existing.event_digest !== eventDigest) return conflict(`idempotency key ${idempotencyKey} was reused with different content`, eventDigest, idempotencyKey);
    return packet({status: "idempotent_replay", before_version: stream.version, after_version: stream.version, idempotency_key: idempotencyKey, event_ref: existing.event_ref, event_digest: existing.event_digest});
  }
  if (stream.version !== expectedVersion) return conflict(`expected version ${expectedVersion}, got ${stream.version}`, eventDigest, idempotencyKey);
  const afterVersion = stream.version + 1;
  const record = {
    event_ref: `${envelope.resource}:${envelope.aggregate_id}:${afterVersion}`,
    version: afterVersion,
    event_type: requiredEventType(event),
    event,
    event_digest: eventDigest,
    idempotency_key: idempotencyKey,
    committed_at: "1970-01-01T00:00:00.000Z",
  };
  stream.events.push(record);
  stream.version = afterVersion;
  writeStore(store);
  return packet({status: "committed", before_version: expectedVersion, after_version: afterVersion, idempotency_key: idempotencyKey, event_ref: record.event_ref, event_digest: eventDigest});
}

function readProjection() {
  const budgetPeriod = requiredString("budget_period");
  let opened = 0;
  let committed = 0;
  let currency = null;
  let periodEventCount = 0;
  for (const entry of stream.events) {
    const payload = entry.event?.payload;
    if (!payload || payload.budget_period !== budgetPeriod) continue;
    periodEventCount += 1;
    if (typeof payload.currency === "string") currency ??= payload.currency;
    if (entry.event_type === "budget.opened") opened += amount(payload.amount);
    if (entry.event_type === "purchase.committed") committed += amount(payload.amount);
  }
  const projection = {
    aggregate_id: envelope.aggregate_id,
    resource: envelope.resource,
    budget_period: budgetPeriod,
    currency,
    version: stream.version,
    event_count: stream.events.length,
    period_event_count: periodEventCount,
    opened_budget: opened,
    committed_spend: committed,
    current_budget_balance: opened - committed,
    last_event_ref: stream.events.at(-1)?.event_ref ?? null,
    last_event_type: stream.events.at(-1)?.event_type ?? null,
    event_digests: stream.events.map((entry) => entry.event_digest),
  };
  return packet({status: "read", before_version: stream.version, after_version: stream.version, projection});
}

function packet(fields) {
  const base = {
    ...envelope,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    events: [],
    rows: [],
    redactions: [],
    stop_conditions: [],
    provider_evidence: {provider: envelope.provider, store_id: store.store_id, resource: envelope.resource, aggregate_id: envelope.aggregate_id, storage_class: "local-fixture"},
    ...fields,
  };
  const digestTarget = fields.projection ?? {status: base.status, before_version: base.before_version, after_version: base.after_version, event_ref: base.event_ref, event_digest: base.event_digest};
  return {...base, result_digest: sha256(digestTarget), projection_digest: sha256(projectionDigestTarget())};
}

function conflict(reason, eventDigest, idempotencyKey) {
  const stop = {code: "conflict", message: reason};
  return packet({status: "conflict", before_version: stream.version, after_version: stream.version, idempotency_key: idempotencyKey, event_digest: eventDigest, stop_conditions: [stop]});
}

function projectionDigestTarget() {
  return {version: stream.version, event_digests: stream.events.map((entry) => entry.event_digest)};
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8") : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function readStore() {
  const file = storePath();
  if (!fs.existsSync(file)) return {schema: "runx.local_budget_store.v1", store_id: storeId(), resources: {}};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.schema !== "runx.local_budget_store.v1") throw new Error("local budget store has an invalid schema");
  parsed.resources ??= {};
  return parsed;
}

function writeStore(value) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function streamFor(value, resource, aggregateId) {
  value.resources[resource] ??= {streams: {}};
  value.resources[resource].streams[aggregateId] ??= {version: 0, events: []};
  return value.resources[resource].streams[aggregateId];
}

function storeId() {
  if (typeof inputs.store_id === "string" && inputs.store_id.trim()) return safeName(inputs.store_id, "store_id");
  return `source-${crypto.createHash("sha256").update(envelope.data_source_ref).digest("hex").slice(0, 24)}`;
}

function storePath() { return path.join(os.tmpdir(), "runx-purchase-approval", `${storeId()}.json`); }
function requiredString(name) { const value = inputs[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value.trim(); }
function nonNegativeInteger(name) { const value = inputs[name]; if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`); return value; }
function requiredObject(name) { const value = inputs[name]; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value; }
function requiredEventType(event) { const value = event.type ?? event.event_type; if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("event type is required"); return value; }
function amount(value) { if (!Number.isInteger(value) || value < 0) throw new Error("event payload amount must be a non-negative integer"); return value; }
function safeName(value, field) { const pattern = field === "aggregate_id" ? /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/; if (!pattern.test(value)) throw new Error(`${field} must be a safe identifier`); return value; }
function sha256(value) { return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`; }
function canonical(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }
