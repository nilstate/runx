import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA = "runx.data.operation_result.v1";
const PROVIDER = "sqlite-event-store";
const SQLITE_BIN = process.env.RUNX_SQLITE_BIN || "sqlite3";

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
  const database = databasePath(rawInputs);
  ensureSchema(database);

  const envelope = baseEnvelope(rawInputs, "append_event");
  const expectedVersion = numberInput("expected_version");
  const idempotencyKey = stringInput("idempotency_key");
  const event = objectInput("event");
  const eventDigest = sha256Json(event);
  const current = currentVersion(database, envelope);
  const existing = existingEvent(database, envelope, idempotencyKey);

  if (existing) {
    if (existing.event_digest !== eventDigest) {
      return conflictResult(envelope, current, {
        idempotency_key: idempotencyKey,
        event_digest: eventDigest,
        reason: "idempotency key was reused with different event content",
        provider_evidence: providerEvidence(envelope),
      });
    }
    return {
      ...envelope,
      status: "idempotent_replay",
      before_version: current,
      after_version: current,
      idempotency_key: idempotencyKey,
      event_ref: existing.event_ref,
      event_digest: existing.event_digest,
      result_digest: sha256Json(existing),
      projection_digest: projectionDigest(database, envelope),
      events: [],
      rows: [],
      redactions: [],
      stop_conditions: [],
      provider_evidence: providerEvidence(envelope),
    };
  }

  if (current !== expectedVersion) {
    return conflictResult(envelope, current, {
      idempotency_key: idempotencyKey,
      event_digest: eventDigest,
      reason: `expected version ${expectedVersion}, got ${current}`,
      provider_evidence: providerEvidence(envelope),
    });
  }

  const nextVersion = current + 1;
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

  try {
    execSql(database, `
BEGIN IMMEDIATE;
INSERT INTO runx_events (
  data_source_ref,
  resource,
  aggregate_id,
  version,
  idempotency_key,
  event_ref,
  event_type,
  event_digest,
  event_json,
  committed_at
) VALUES (
  ${sqlString(envelope.data_source_ref)},
  ${sqlString(envelope.resource)},
  ${sqlString(envelope.aggregate_id)},
  ${nextVersion},
  ${sqlString(idempotencyKey)},
  ${sqlString(eventRef)},
  ${sqlString(record.event_type)},
  ${sqlString(eventDigest)},
  ${sqlString(JSON.stringify(event))},
  ${sqlString(record.committed_at)}
);
INSERT INTO runx_stream_heads (
  data_source_ref,
  resource,
  aggregate_id,
  version,
  event_ref,
  event_type,
  event_digest,
  idempotency_key,
  event_json,
  committed_at
) VALUES (
  ${sqlString(envelope.data_source_ref)},
  ${sqlString(envelope.resource)},
  ${sqlString(envelope.aggregate_id)},
  ${nextVersion},
  ${sqlString(eventRef)},
  ${sqlString(record.event_type)},
  ${sqlString(eventDigest)},
  ${sqlString(idempotencyKey)},
  ${sqlString(JSON.stringify(event))},
  ${sqlString(record.committed_at)}
)
ON CONFLICT (data_source_ref, resource, aggregate_id) DO UPDATE SET
  version = excluded.version,
  event_ref = excluded.event_ref,
  event_type = excluded.event_type,
  event_digest = excluded.event_digest,
  idempotency_key = excluded.idempotency_key,
  event_json = excluded.event_json,
  committed_at = excluded.committed_at;
COMMIT;
`);
  } catch (error) {
    const latest = currentVersion(database, envelope);
    return conflictResult(envelope, latest, {
      idempotency_key: idempotencyKey,
      event_digest: eventDigest,
      reason: `sqlite append failed after version check: ${error.message}`,
      provider_evidence: providerEvidence(envelope),
    });
  }

  return {
    ...envelope,
    status: "committed",
    before_version: expectedVersion,
    after_version: nextVersion,
    idempotency_key: idempotencyKey,
    event_ref: eventRef,
    event_digest: eventDigest,
    result_digest: sha256Json(record),
    projection_digest: projectionDigest(database, envelope),
    events: [],
    rows: [],
    redactions: [],
    stop_conditions: [],
    provider_evidence: providerEvidence(envelope),
  };
}

function readEvents(rawInputs) {
  const database = databasePath(rawInputs);
  ensureSchema(database);

  const envelope = baseEnvelope(rawInputs, "read_events");
  const limit = boundedLimit(rawInputs.limit);
  const afterVersion = optionalVersion(rawInputs.after_version, "after_version");
  const current = currentVersion(database, envelope);
  const rows = afterVersion === undefined ? queryJson(database, `
SELECT event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json
FROM runx_events
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  AND aggregate_id = ${sqlString(envelope.aggregate_id)}
ORDER BY version DESC
LIMIT ${limit};
`).reverse() : queryJson(database, `
SELECT event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json
FROM runx_events
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  AND aggregate_id = ${sqlString(envelope.aggregate_id)}
  AND version > ${afterVersion}
ORDER BY version ASC
LIMIT ${limit};
`);
  const events = rows
    .map((row) => ({
      event_ref: row.event_ref,
      version: Number(row.version),
      event_type: row.event_type,
      event: JSON.parse(row.event_json),
      event_digest: row.event_digest,
      idempotency_key: row.idempotency_key,
      committed_at: row.committed_at,
    }));

  return {
    ...envelope,
    status: "read",
    before_version: current,
    after_version: current,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json(events),
    projection_digest: projectionDigest(database, envelope),
    events,
    rows: events,
    redactions: [],
    stop_conditions: [],
    provider_evidence: providerEvidence(envelope),
  };
}

function readProjection(rawInputs) {
  const database = databasePath(rawInputs);
  ensureSchema(database);

  const envelope = baseEnvelope(rawInputs, "read_projection");
  const eventRows = queryJson(database, `
SELECT event_ref, event_type, event_digest
FROM runx_events
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  AND aggregate_id = ${sqlString(envelope.aggregate_id)}
ORDER BY version ASC;
`);
  const projection = {
    aggregate_id: envelope.aggregate_id,
    resource: envelope.resource,
    version: eventRows.length,
    event_count: eventRows.length,
    last_event_ref: eventRows.at(-1)?.event_ref ?? null,
    last_event_type: eventRows.at(-1)?.event_type ?? null,
    event_digests: eventRows.map((entry) => entry.event_digest),
  };
  return {
    ...envelope,
    status: "read",
    before_version: projection.version,
    after_version: projection.version,
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
    provider_evidence: providerEvidence(envelope),
  };
}

function listStreamHeads(rawInputs) {
  const database = databasePath(rawInputs);
  ensureSchema(database);

  const envelope = baseEnvelope(rawInputs, "list_stream_heads");
  const limit = boundedHeadLimit(rawInputs.limit);
  const cursor = decodeHeadCursor(rawInputs.cursor);
  const eventTypes = optionalEventTypes(rawInputs.event_types);
  const cursorClause = cursor
    ? `AND (committed_at < ${sqlString(cursor.committed_at)} OR (committed_at = ${sqlString(cursor.committed_at)} AND aggregate_id > ${sqlString(cursor.aggregate_id)}))`
    : "";
  const eventTypeClause = eventTypes.length > 0
    ? `AND event_type IN (${eventTypes.map(sqlString).join(", ")})`
    : "";
  const records = queryJson(database, `
SELECT aggregate_id, version, event_ref, event_type, event_digest, idempotency_key, committed_at, event_json
FROM runx_stream_heads
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  ${eventTypeClause}
  ${cursorClause}
ORDER BY committed_at DESC, aggregate_id ASC
LIMIT ${limit + 1};
`).map(streamHeadRecord);
  const hasMore = records.length > limit;
  const rows = records.slice(0, limit);
  const nextCursor = hasMore && rows.length > 0
    ? encodeHeadCursor(rows.at(-1))
    : null;
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
    provider_evidence: providerEvidence(envelope),
  };
}

function conflictResult(envelope, currentVersionValue, { idempotency_key, event_digest, reason, provider_evidence }) {
  const stop = {
    code: "conflict",
    message: reason,
  };
  return {
    ...envelope,
    status: "conflict",
    before_version: currentVersionValue,
    after_version: currentVersionValue,
    idempotency_key,
    event_ref: null,
    event_digest,
    result_digest: sha256Json(stop),
    projection_digest: `sha256:${"0".repeat(64)}`,
    events: [],
    rows: [],
    redactions: [],
    stop_conditions: [stop],
    provider_evidence,
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

function ensureSchema(database) {
  fs.mkdirSync(path.dirname(database), { recursive: true });
  execSql(database, `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS runx_events (
  data_source_ref TEXT NOT NULL DEFAULT '',
  resource TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (data_source_ref, resource, aggregate_id, version),
  UNIQUE (data_source_ref, resource, aggregate_id, idempotency_key)
);
`);
  migrateLegacySchema(database);
  execSql(database, `
CREATE TABLE IF NOT EXISTS runx_stream_heads (
  data_source_ref TEXT NOT NULL,
  resource TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  event_ref TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (data_source_ref, resource, aggregate_id)
);
CREATE TABLE IF NOT EXISTS runx_data_store_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
INSERT INTO runx_stream_heads (
  data_source_ref,
  resource,
  aggregate_id,
  version,
  event_ref,
  event_type,
  event_digest,
  idempotency_key,
  event_json,
  committed_at
)
SELECT
  events.data_source_ref,
  events.resource,
  events.aggregate_id,
  events.version,
  events.event_ref,
  events.event_type,
  events.event_digest,
  events.idempotency_key,
  events.event_json,
  events.committed_at
FROM runx_events AS events
WHERE NOT EXISTS (
  SELECT 1 FROM runx_data_store_migrations WHERE version = 'stream-heads-v1'
)
AND events.version = (
  SELECT MAX(candidate.version)
  FROM runx_events AS candidate
  WHERE candidate.data_source_ref = events.data_source_ref
    AND candidate.resource = events.resource
    AND candidate.aggregate_id = events.aggregate_id
)
ON CONFLICT (data_source_ref, resource, aggregate_id) DO UPDATE SET
  version = excluded.version,
  event_ref = excluded.event_ref,
  event_type = excluded.event_type,
  event_digest = excluded.event_digest,
  idempotency_key = excluded.idempotency_key,
  event_json = excluded.event_json,
  committed_at = excluded.committed_at
WHERE excluded.version > runx_stream_heads.version;
INSERT OR IGNORE INTO runx_data_store_migrations (version, applied_at)
VALUES ('stream-heads-v1', '1970-01-01T00:00:00.000Z');
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_version_v1
  ON runx_events (data_source_ref, resource, aggregate_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_idempotency_v1
  ON runx_events (data_source_ref, resource, aggregate_id, idempotency_key);
CREATE INDEX IF NOT EXISTS runx_stream_heads_recent_v1
  ON runx_stream_heads (data_source_ref, resource, committed_at DESC, aggregate_id ASC);
CREATE INDEX IF NOT EXISTS runx_stream_heads_type_recent_v1
  ON runx_stream_heads (data_source_ref, resource, event_type, committed_at DESC, aggregate_id ASC);
`);
}

function migrateLegacySchema(database) {
  const columns = queryJson(database, "PRAGMA table_info(runx_events);").map((column) => column.name);
  if (columns.includes("data_source_ref")) return;

  execSql(database, `
BEGIN IMMEDIATE;
ALTER TABLE runx_events RENAME TO runx_events_legacy_unscoped;
CREATE TABLE runx_events (
  data_source_ref TEXT NOT NULL,
  resource TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (data_source_ref, resource, aggregate_id, version),
  UNIQUE (data_source_ref, resource, aggregate_id, idempotency_key)
);
INSERT INTO runx_events (
  data_source_ref,
  resource,
  aggregate_id,
  version,
  idempotency_key,
  event_ref,
  event_type,
  event_digest,
  event_json,
  committed_at
)
SELECT
  '',
  resource,
  aggregate_id,
  version,
  idempotency_key,
  event_ref,
  event_type,
  event_digest,
  event_json,
  committed_at
FROM runx_events_legacy_unscoped;
DROP TABLE runx_events_legacy_unscoped;
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_version_v1
  ON runx_events (data_source_ref, resource, aggregate_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_idempotency_v1
  ON runx_events (data_source_ref, resource, aggregate_id, idempotency_key);
COMMIT;
`);
}

function currentVersion(database, envelope) {
  const rows = queryJson(database, `
SELECT COALESCE(MAX(version), 0) AS version
FROM runx_events
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  AND aggregate_id = ${sqlString(envelope.aggregate_id)};
`);
  return Number(rows[0]?.version ?? 0);
}

function existingEvent(database, envelope, idempotencyKey) {
  const rows = queryJson(database, `
SELECT event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json
FROM runx_events
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  AND aggregate_id = ${sqlString(envelope.aggregate_id)}
  AND idempotency_key = ${sqlString(idempotencyKey)}
LIMIT 1;
`);
  const row = rows[0];
  if (!row) return null;
  return {
    event_ref: row.event_ref,
    version: Number(row.version),
    event_type: row.event_type,
    event: JSON.parse(row.event_json),
    event_digest: row.event_digest,
    idempotency_key: row.idempotency_key,
    committed_at: row.committed_at,
  };
}

function projectionDigest(database, envelope) {
  const rows = queryJson(database, `
SELECT version, event_digest
FROM runx_events
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  AND aggregate_id = ${sqlString(envelope.aggregate_id)}
ORDER BY version ASC;
`);
  return sha256Json({
    version: rows.length,
    event_digests: rows.map((entry) => entry.event_digest),
  });
}

function providerEvidence(envelope) {
  return {
    provider: PROVIDER,
    adapter: "data.sqlite",
    data_source_ref_digest: sha256Json(envelope.data_source_ref),
    resource: envelope.resource,
    aggregate_id: envelope.aggregate_id,
    storage_class: "sqlite",
  };
}

function databasePath(rawInputs) {
  const binding = rawInputs.data_source_binding && typeof rawInputs.data_source_binding === "object" && !Array.isArray(rawInputs.data_source_binding)
    ? rawInputs.data_source_binding
    : {};
  const rawPath = typeof binding.database_path === "string" && binding.database_path.trim().length > 0
    ? binding.database_path.trim()
    : typeof rawInputs.database_path === "string" && rawInputs.database_path.trim().length > 0
      ? rawInputs.database_path.trim()
      : null;
  if (!rawPath) {
    throw new Error("data.sqlite requires data_source_binding.database_path or database_path");
  }
  const root = path.resolve(process.env.RUNX_CWD || process.env.INIT_CWD || process.cwd());
  const allowAbsolute = binding.allow_absolute_path === true || rawInputs.allow_absolute_path === true;
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(root, rawPath);
  if (path.isAbsolute(rawPath) && !allowAbsolute) {
    throw new Error("data.sqlite absolute database_path requires allow_absolute_path=true in the operator-owned binding");
  }
  if (!allowAbsolute && !isInside(root, resolved)) {
    throw new Error("data.sqlite database_path must stay inside RUNX_CWD unless allow_absolute_path=true");
  }
  return resolved;
}

function execSql(database, sql) {
  const result = spawnSync(SQLITE_BIN, ["-cmd", ".timeout 5000", database], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sqlite3 exited ${result.status}`).trim());
  }
}

function queryJson(database, sql) {
  const result = spawnSync(SQLITE_BIN, ["-cmd", ".timeout 5000", "-json", database], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sqlite3 exited ${result.status}`).trim());
  }
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : [];
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

function streamHeadRecord(row) {
  return {
    aggregate_id: row.aggregate_id,
    version: Number(row.version),
    event_ref: row.event_ref,
    event_type: row.event_type,
    event: JSON.parse(row.event_json),
    event_digest: row.event_digest,
    idempotency_key: row.idempotency_key,
    committed_at: row.committed_at,
  };
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
    const committedAt = decoded.committed_at;
    const aggregateId = decoded.aggregate_id;
    if (typeof committedAt !== "string" || committedAt.length > 100 || Number.isNaN(Date.parse(committedAt))) {
      throw new Error("invalid committed_at");
    }
    return {
      committed_at: committedAt,
      aggregate_id: safeName(aggregateId, "aggregate_id"),
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

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
