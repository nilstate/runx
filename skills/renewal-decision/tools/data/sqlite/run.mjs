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
    committed_at: typeof rawInputs.observed_at === "string" ? rawInputs.observed_at : "1970-01-01T00:00:00.000Z",
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
  const current = currentVersion(database, envelope);
  const rows = queryJson(database, `
SELECT event_ref, version, event_type, event_digest, idempotency_key, committed_at, event_json
FROM runx_events
WHERE data_source_ref = ${sqlString(envelope.data_source_ref)}
  AND resource = ${sqlString(envelope.resource)}
  AND aggregate_id = ${sqlString(envelope.aggregate_id)}
ORDER BY version DESC
LIMIT ${limit};
`);
  const events = rows
    .reverse()
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
    aggregate_id: safeName(stringInput("aggregate_id"), "aggregate_id"),
  };
}

function ensureSchema(database) {
  fs.mkdirSync(path.dirname(database), { recursive: true });
  execSql(database, `
PRAGMA journal_mode = WAL;
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
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_version_v1
  ON runx_events (data_source_ref, resource, aggregate_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS runx_events_stream_idempotency_v1
  ON runx_events (data_source_ref, resource, aggregate_id, idempotency_key);
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
  const result = spawnSync(SQLITE_BIN, [database], {
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
  const result = spawnSync(SQLITE_BIN, ["-json", database], {
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
