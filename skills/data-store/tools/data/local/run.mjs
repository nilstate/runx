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
} else if (operation === "list_stream_heads") {
  result = listStreamHeads(inputs);
} else {
  throw new Error("operation must be append_event, read_events, read_projection, or list_stream_heads");
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
    committed_at: committedAt(rawInputs.observed_at),
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
  const afterVersion = optionalVersion(rawInputs.after_version, "after_version");
  const store = readStore(rawInputs);
  const stream = streamFor(store, envelope.resource, envelope.aggregate_id);
  const events = afterVersion === undefined
    ? stream.events.slice(Math.max(0, stream.events.length - limit))
    : stream.events.filter((entry) => entry.version > afterVersion).slice(0, limit);
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

function listStreamHeads(rawInputs) {
  const envelope = baseEnvelope(rawInputs, "list_stream_heads");
  const store = readStore(rawInputs);
  const limit = boundedHeadLimit(rawInputs.limit);
  const cursor = decodeHeadCursor(rawInputs.cursor);
  const eventTypes = new Set(optionalEventTypes(rawInputs.event_types));
  const streams = store.resources[envelope.resource]?.streams ?? {};
  const records = Object.entries(streams)
    .map(([aggregateId, stream]) => {
      const latest = stream.events.at(-1);
      return latest ? { aggregate_id: aggregateId, ...latest } : undefined;
    })
    .filter(Boolean)
    .filter((entry) => eventTypes.size === 0 || eventTypes.has(entry.event_type))
    .sort(compareStreamHeads)
    .filter((entry) => !cursor || compareStreamHeads(entry, cursor) > 0);
  const hasMore = records.length > limit;
  const rows = records.slice(0, limit);
  const nextCursor = hasMore && rows.length > 0 ? encodeHeadCursor(rows.at(-1)) : null;
  const page = {
    limit,
    count: rows.length,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
  return {
    ...envelope,
    status: "read",
    before_version: 0,
    after_version: 0,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json({ rows, page }),
    projection_digest: sha256Json(rows.map((row) => [row.aggregate_id, row.version, row.event_digest])),
    projection: page,
    events: [],
    rows,
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
    aggregate_id: operation === "list_stream_heads"
      ? "stream-heads"
      : safeName(stringInput("aggregate_id"), "aggregate_id"),
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

function boundedHeadLimit(value) {
  if (value === undefined || value === null) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("list_stream_heads limit must be an integer from 1 to 100");
  }
  return value;
}

function optionalEventTypes(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("event_types must be an array of at most 20 exact event types");
  }
  return Array.from(new Set(value.map((entry) => {
    const token = safeEventToken(entry);
    if (!token) throw new Error("event_types contains an invalid event type");
    return token;
  })));
}

function compareStreamHeads(left, right) {
  const time = right.committed_at.localeCompare(left.committed_at);
  return time === 0 ? left.aggregate_id.localeCompare(right.aggregate_id) : time;
}

function encodeHeadCursor(row) {
  return Buffer.from(JSON.stringify({
    committed_at: row.committed_at,
    aggregate_id: row.aggregate_id,
  }), "utf8").toString("base64url");
}

function decodeHeadCursor(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("cursor must be an opaque list_stream_heads cursor");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid cursor");
    if (typeof decoded.committed_at !== "string" || decoded.committed_at.length > 100 || Number.isNaN(Date.parse(decoded.committed_at))) {
      throw new Error("invalid committed_at");
    }
    return {
      committed_at: decoded.committed_at,
      aggregate_id: safeName(decoded.aggregate_id, "aggregate_id"),
    };
  } catch {
    throw new Error("cursor must be an opaque list_stream_heads cursor");
  }
}

function optionalVersion(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function committedAt(value) {
  if (value === undefined || value === null) return "1970-01-01T00:00:00.000Z";
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("observed_at must be ISO-8601");
  }
  return new Date(value).toISOString();
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
