import fs from "node:fs";

import { sha256Json } from "./canonical-json.mjs";
import {
  aggregateIdFromHeadIndexMember,
  createRedisStore,
  decodeHeadCursor,
  encodeHeadCursor,
  headIndexMember,
} from "./redis.mjs";

const SCHEMA = "runx.data.operation_result.v1";
const PROVIDER = "redis-event-store";

const inputs = readInputs();
const operations = {
  append_event: appendEvent,
  read_events: readEvents,
  read_projection: readProjection,
  list_stream_heads: listStreamHeads,
};
const operation = operations[inputs.operation];
if (!operation) {
  throw new Error("operation must be append_event, read_events, read_projection, or list_stream_heads");
}
process.stdout.write(`${JSON.stringify(operation(inputs), null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function appendEvent(request) {
  const envelope = baseEnvelope(request, "append_event");
  const store = createRedisStore(request, envelope);
  const record = {
    event_ref: `${envelope.resource}:${envelope.aggregate_id}:${request.expected_version + 1}`,
    version: request.expected_version + 1,
    event_type: request.event_type,
    event: request.event,
    event_digest: request.event_digest,
    idempotency_key: request.idempotency_key,
    committed_at: request.observed_at,
  };
  const currentProjection = readProjectionState(store, envelope);
  const nextProjection = advanceProjection(currentProjection, record);
  const response = store.append([
    String(request.expected_version),
    request.idempotency_key,
    record.event_digest,
    record.event_ref,
    String(record.version),
    JSON.stringify(record),
    sha256Json(record),
    envelope.aggregate_id,
    headIndexMember(envelope.aggregate_id, record.committed_at),
    JSON.stringify(nextProjection),
    nextProjection.projection_digest,
    emptyProjection(envelope).projection_digest,
  ]);
  return appendResult(response, request, envelope, store);
}

function appendResult(response, request, envelope, store) {
  const [status, ...fields] = response.split("|");
  const provider_evidence = providerEvidence(store, envelope);
  if (status === "committed") {
    const [before, after, event_ref, event_digest, result_digest, projection_digest] = fields;
    return resultEnvelope(envelope, {
      status,
      before_version: Number(before),
      after_version: Number(after),
      idempotency_key: request.idempotency_key,
      event_ref,
      event_digest,
      result_digest,
      projection_digest,
      provider_evidence,
    });
  }
  if (status === "idempotent_replay") {
    const [current, event_digest, event_ref, committedVersion, result_digest, projection_digest] = fields;
    return resultEnvelope(envelope, {
      status,
      before_version: Number(current),
      after_version: Number(current),
      idempotency_key: request.idempotency_key,
      event_ref,
      event_digest,
      result_digest,
      projection_digest,
      provider_evidence: {
        ...provider_evidence,
        committed_version: Number(committedVersion),
      },
    });
  }
  if (status === "idempotency_conflict") {
    return conflictResult(request, envelope, Number(fields[0]), fields[1], provider_evidence,
      "idempotency key was reused with different event content");
  }
  if (status === "version_conflict") {
    const current = Number(fields[0]);
    return conflictResult(request, envelope, current, fields[1], provider_evidence,
      `expected version ${request.expected_version}, got ${current}`);
  }
  throw new Error(`unexpected redis append response: ${response}`);
}

function conflictResult(request, envelope, current, projectionDigest, providerEvidenceValue, reason) {
  const stop = { code: "conflict", message: reason };
  return resultEnvelope(envelope, {
    status: "conflict",
    before_version: current,
    after_version: current,
    idempotency_key: request.idempotency_key,
    event_ref: null,
    event_digest: request.event_digest,
    result_digest: sha256Json(stop),
    projection_digest: projectionDigest,
    stop_conditions: [stop],
    provider_evidence: providerEvidenceValue,
  });
}

function readEvents(request) {
  const envelope = baseEnvelope(request, "read_events");
  const store = createRedisStore(request, envelope);
  const forward = request.after_version !== undefined;
  const start = forward ? request.after_version : -request.limit;
  const stop = forward ? request.after_version + request.limit : -1;
  const snapshot = store.readEvents(start, stop);
  const current = providerVersion(snapshot.current);
  const fetched = providerArray(snapshot.events, "redis event page").map((record) => JSON.parse(record));
  const hasMore = forward && fetched.length > request.limit;
  const events = fetched.slice(0, request.limit);
  const nextAfterVersion = events.at(-1)?.version ?? (forward ? request.after_version : current);
  const page = {
    events,
    limit: request.limit,
    next_after_version: nextAfterVersion,
    has_more: hasMore,
  };
  const projection = storedProjection(envelope, current, snapshot.projection);
  return resultEnvelope(envelope, {
    status: "read",
    before_version: current,
    after_version: current,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json(page),
    projection_digest: projection.projection_digest,
    limit: page.limit,
    next_after_version: page.next_after_version,
    has_more: page.has_more,
    events,
    rows: events,
    provider_evidence: providerEvidence(store, envelope),
  });
}

function readProjection(request) {
  const envelope = baseEnvelope(request, "read_projection");
  const store = createRedisStore(request, envelope);
  const stored = readProjectionState(store, envelope);
  const { projection_digest, ...projection } = stored;
  return resultEnvelope(envelope, {
    status: "read",
    before_version: projection.version,
    after_version: projection.version,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json(projection),
    projection_digest,
    projection,
    provider_evidence: providerEvidence(store, envelope),
  });
}

function listStreamHeads(request) {
  const envelope = baseEnvelope(request, "list_stream_heads");
  const store = createRedisStore(request, envelope);
  const eventTypes = new Set(request.event_types);
  const cursor = decodeHeadCursor(request.cursor);
  const matches = [];
  let afterMember = cursor ? headIndexMember(cursor.aggregate_id, cursor.committed_at) : undefined;

  while (matches.length <= request.limit) {
    const members = store.headMembers(afterMember);
    if (members.length === 0) break;
    const aggregateIds = members.map(aggregateIdFromHeadIndexMember);
    const records = store.headRecords(aggregateIds);
    for (let index = 0; index < members.length && matches.length <= request.limit; index += 1) {
      if (!records[index]) continue;
      const record = JSON.parse(records[index]);
      if (headIndexMember(aggregateIds[index], record.committed_at) !== members[index]) continue;
      if (eventTypes.size === 0 || eventTypes.has(record.event_type)) {
        matches.push({ aggregate_id: aggregateIds[index], ...record });
      }
    }
    afterMember = members.at(-1);
  }

  const hasMore = matches.length > request.limit;
  const rows = matches.slice(0, request.limit);
  const page = {
    limit: request.limit,
    count: rows.length,
    has_more: hasMore,
    next_cursor: hasMore ? encodeHeadCursor(rows.at(-1)) : null,
  };
  return resultEnvelope(envelope, {
    status: "read",
    before_version: 0,
    after_version: 0,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json({ rows, page }),
    projection_digest: sha256Json(rows.map((row) => [row.aggregate_id, row.version, row.event_digest])),
    projection: page,
    rows,
    provider_evidence: providerEvidence(store, envelope),
  });
}

function baseEnvelope(request, operation) {
  return {
    schema: SCHEMA,
    data_source_ref: request.data_source_ref,
    provider: PROVIDER,
    operation,
    resource: request.resource,
    aggregate_id: operation === "list_stream_heads" ? "stream-heads" : request.aggregate_id,
  };
}

function resultEnvelope(envelope, fields) {
  return {
    ...envelope,
    ...fields,
    events: fields.events ?? [],
    rows: fields.rows ?? [],
    redactions: [],
    stop_conditions: fields.stop_conditions ?? [],
  };
}

function readProjectionState(store, envelope) {
  const snapshot = store.projectionSnapshot();
  return storedProjection(envelope, providerVersion(snapshot.current), snapshot.projection);
}

function storedProjection(envelope, current, raw) {
  if (!raw) {
    if (current !== 0) {
      throw new Error("data.redis uses an unsupported legacy projection; migrate it out of band before running");
    }
    return emptyProjection(envelope);
  }
  const projection = JSON.parse(raw);
  if (projection.version !== current
    || projection.aggregate_id !== envelope.aggregate_id
    || projection.resource !== envelope.resource
    || !/^sha256:[a-f0-9]{64}$/u.test(projection.projection_digest || "")) {
    throw new Error("data.redis projection is inconsistent with the event stream");
  }
  return projection;
}

function emptyProjection(envelope) {
  return {
    aggregate_id: envelope.aggregate_id,
    resource: envelope.resource,
    version: 0,
    event_count: 0,
    last_event_ref: null,
    last_event_type: null,
    last_event_digest: null,
    projection_digest: sha256Json({ version: 0, event_digest: null }),
  };
}

function advanceProjection(current, record) {
  return {
    aggregate_id: current.aggregate_id,
    resource: current.resource,
    version: record.version,
    event_count: record.version,
    last_event_ref: record.event_ref,
    last_event_type: record.event_type,
    last_event_digest: record.event_digest,
    projection_digest: sha256Json({
      version: record.version,
      previous_projection_digest: current.projection_digest,
      event_digest: record.event_digest,
    }),
  };
}

function providerEvidence(store, envelope) {
  return {
    provider: PROVIDER,
    adapter: "data.redis",
    data_source_ref_digest: sha256Json(envelope.data_source_ref),
    resource: envelope.resource,
    aggregate_id: envelope.aggregate_id,
    storage_class: "redis",
    key_prefix_digest: sha256Json(store.identity.key_prefix),
    stream_digest: store.identity.stream_digest,
  };
}

function providerVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("redis stream version is invalid");
  }
  return value;
}

function providerArray(value, label) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Object.keys(value).length === 0) return [];
  throw new Error(`${label} is invalid`);
}
