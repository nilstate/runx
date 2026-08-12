import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA = "runx.data.operation_result.v1";
const PROVIDER = "local-json-event-store";

const inputs = readInputs();
const operation = stringInput("operation");

let result;
if (operation === "append_event") {
  result = appendEvent(inputs);
} else if (operation === "read_events") {
  result = readEvents(inputs);
} else if (operation === "read_projection") {
  result = readProjection(inputs);
} else {
  throw new Error("operation must be append_event, read_events, or read_projection");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function appendEvent(rawInputs) {
  const envelope = baseEnvelope(rawInputs, "append_event");
  const expectedVersion = numberInput("expected_version");
  const idempotencyKey = stringInput("idempotency_key");
  const event = objectInput("event");
  const store = readStore(rawInputs);
  const stream = streamFor(store, envelope.resource, envelope.aggregate_id);
  const eventDigest = sha256Json(event);
  const existing = stream.events.find((entry) => entry.idempotency_key === idempotencyKey);

  if (existing) {
    if (existing.event_digest !== eventDigest) {
      return conflictResult(envelope, stream, {
        idempotency_key: idempotencyKey,
        event_digest: eventDigest,
        reason: "idempotency key was reused with different event content",
        provider_evidence: providerEvidence(store, envelope),
      });
    }
    return {
      ...envelope,
      status: "idempotent_replay",
      before_version: stream.version,
      after_version: stream.version,
      idempotency_key: idempotencyKey,
      event_ref: existing.event_ref,
      event_digest: existing.event_digest,
      result_digest: sha256Json(existing),
      projection_digest: projectionDigest(stream),
      events: [],
      rows: [],
      redactions: [],
      stop_conditions: [],
      provider_evidence: providerEvidence(store, envelope),
    };
  }

  if (stream.version !== expectedVersion) {
    return conflictResult(envelope, stream, {
      idempotency_key: idempotencyKey,
      event_digest: eventDigest,
      reason: `expected version ${expectedVersion}, got ${stream.version}`,
      provider_evidence: providerEvidence(store, envelope),
    });
  }

  const nextVersion = stream.version + 1;
  const eventRef = `${envelope.resource}:${envelope.aggregate_id}:${nextVersion}`;
  const record = {
    event_ref: eventRef,
    version: nextVersion,
    event_type: eventType(event),
    event,
    event_digest: eventDigest,
    idempotency_key: idempotencyKey,
    committed_at: typeof rawInputs.observed_at === "string" ? rawInputs.observed_at : "1970-01-01T00:00:00.000Z",
  };
  stream.events.push(record);
  stream.version = nextVersion;
  writeStore(rawInputs, store);

  return {
    ...envelope,
    status: "committed",
    before_version: expectedVersion,
    after_version: nextVersion,
    idempotency_key: idempotencyKey,
    event_ref: eventRef,
    event_digest: eventDigest,
    result_digest: sha256Json(record),
    projection_digest: projectionDigest(stream),
    events: [],
    rows: [],
    redactions: [],
    stop_conditions: [],
    provider_evidence: providerEvidence(store, envelope),
  };
}

function conflictResult(envelope, stream, { idempotency_key, event_digest, reason, provider_evidence }) {
  const stop = {
    code: "conflict",
    message: reason,
  };
  return {
    ...envelope,
    status: "conflict",
    before_version: stream.version,
    after_version: stream.version,
    idempotency_key,
    event_ref: null,
    event_digest,
    result_digest: sha256Json(stop),
    projection_digest: projectionDigest(stream),
    events: [],
    rows: [],
    redactions: [],
    stop_conditions: [stop],
    provider_evidence,
  };
}

function readEvents(rawInputs) {
  const envelope = baseEnvelope(rawInputs, "read_events");
  const limit = boundedLimit(rawInputs.limit);
  const store = readStore(rawInputs);
  const stream = streamFor(store, envelope.resource, envelope.aggregate_id);
  const events = stream.events.slice(Math.max(0, stream.events.length - limit));
  return {
    ...envelope,
    status: "read",
    before_version: stream.version,
    after_version: stream.version,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json(events),
    projection_digest: projectionDigest(stream),
    events,
    rows: events,
    redactions: [],
    stop_conditions: [],
    provider_evidence: providerEvidence(store, envelope),
  };
}

function readProjection(rawInputs) {
  const envelope = baseEnvelope(rawInputs, "read_projection");
  const store = readStore(rawInputs);
  const stream = streamFor(store, envelope.resource, envelope.aggregate_id);
  const projection = {
    aggregate_id: envelope.aggregate_id,
    resource: envelope.resource,
    version: stream.version,
    event_count: stream.events.length,
    last_event_ref: stream.events.at(-1)?.event_ref ?? null,
    last_event_type: stream.events.at(-1)?.event_type ?? null,
    event_digests: stream.events.map((entry) => entry.event_digest),
  };
  return {
    ...envelope,
    status: "read",
    before_version: stream.version,
    after_version: stream.version,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json(projection),
    projection_digest: sha256Json(projection),
    projection,
    events: [],
    rows: [],
    redactions: [],
    stop_conditions: [],
    provider_evidence: providerEvidence(store, envelope),
  };
}

function baseEnvelope(rawInputs, operation) {
  return {
    schema: SCHEMA,
    data_source_ref: stringInput("data_source_ref"),
    provider: PROVIDER,
    operation,
    resource: safeName(stringInput("resource"), "resource"),
    aggregate_id: safeName(stringInput("aggregate_id"), "aggregate_id"),
  };
}

function streamFor(store, resource, aggregateId) {
  store.resources[resource] ??= { streams: {} };
  store.resources[resource].streams[aggregateId] ??= { version: 0, events: [] };
  return store.resources[resource].streams[aggregateId];
}

function readStore(rawInputs) {
  const file = storePath(rawInputs);
  if (!fs.existsSync(file)) {
    return {
      schema: "runx.local_data_store.v1",
      store_id: localStoreId(rawInputs),
      resources: {},
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || parsed.schema !== "runx.local_data_store.v1") {
    throw new Error("local data store file has an invalid schema");
  }
  parsed.resources ??= {};
  return parsed;
}

function writeStore(rawInputs, store) {
  const file = storePath(rawInputs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function storePath(rawInputs) {
  const storeId = localStoreId(rawInputs);
  return path.join(os.tmpdir(), "runx-data-store", `${storeId}.json`);
}

function localStoreId(rawInputs) {
  if (typeof rawInputs.store_id === "string" && rawInputs.store_id.trim().length > 0) {
    return safeName(rawInputs.store_id, "store_id");
  }
  const ref = typeof rawInputs.data_source_ref === "string" && rawInputs.data_source_ref.length > 0
    ? rawInputs.data_source_ref
    : "default";
  return `source-${crypto.createHash("sha256").update(ref).digest("hex").slice(0, 24)}`;
}

function providerEvidence(store, envelope) {
  return {
    provider: PROVIDER,
    store_id: store.store_id,
    resource: envelope.resource,
    aggregate_id: envelope.aggregate_id,
    storage_class: "local-fixture",
  };
}

function projectionDigest(stream) {
  return sha256Json({
    version: stream.version,
    event_digests: stream.events.map((entry) => entry.event_digest),
  });
}

function readValue(name) {
  return inputs[name];
}

function stringInput(name) {
  const value = readValue(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function numberInput(name) {
  const value = readValue(name);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function objectInput(name) {
  const value = readValue(name);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function eventType(event) {
  const explicit = safeEventToken(event.type) ?? safeEventToken(event.event_type);
  if (explicit) return explicit;
  const family = safeEventToken(event.effect_family);
  const operation = safeEventToken(event.operation);
  if (family && operation) return `${family}.${operation}`;
  if (operation) return operation;
  return "data.event";
}

function safeEventToken(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) ? text : undefined;
}

function boundedLimit(value) {
  if (value === undefined || value === null) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  return value;
}

function safeName(value, field) {
  const text = String(value || "").trim();
  const pattern = field === "aggregate_id"
    ? /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/
    : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (!pattern.test(text)) {
    throw new Error(`${field} must be a safe identifier`);
  }
  return text;
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
