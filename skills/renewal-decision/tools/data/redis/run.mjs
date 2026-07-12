import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SCHEMA = "runx.data.operation_result.v1";
const PROVIDER = "redis-event-store";
const REDIS_CLI_BIN = process.env.RUNX_REDIS_CLI_BIN || "redis-cli";

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
  const eventDigest = sha256Json(event);
  const keys = redisKeys(rawInputs, envelope);
  const nextVersion = expectedVersion + 1;
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
  const recordDigest = sha256Json(record);
  const response = redisEval(rawInputs, appendScript(), [keys.stream, keys.idempotency], [
    String(expectedVersion),
    idempotencyKey,
    eventDigest,
    eventRef,
    String(nextVersion),
    JSON.stringify(record),
    recordDigest,
  ]);
  const [status, ...fields] = response.split("|");

  if (status === "committed") {
    const [before, after, ref, digest, resultDigest] = fields;
    return {
      ...envelope,
      status: "committed",
      before_version: Number(before),
      after_version: Number(after),
      idempotency_key: idempotencyKey,
      event_ref: ref,
      event_digest: digest,
      result_digest: resultDigest,
      projection_digest: projectionDigest(rawInputs, envelope),
      events: [],
      rows: [],
      redactions: [],
      stop_conditions: [],
      provider_evidence: providerEvidence(rawInputs, envelope),
    };
  }

  if (status === "idempotent_replay") {
    const [current, digest, ref, version, resultDigest] = fields;
    return {
      ...envelope,
      status: "idempotent_replay",
      before_version: Number(current),
      after_version: Number(current),
      idempotency_key: idempotencyKey,
      event_ref: ref,
      event_digest: digest,
      result_digest: resultDigest,
      projection_digest: projectionDigest(rawInputs, envelope),
      events: [],
      rows: [],
      redactions: [],
      stop_conditions: [],
      provider_evidence: {
        ...providerEvidence(rawInputs, envelope),
        committed_version: Number(version),
      },
    };
  }

  if (status === "idempotency_conflict") {
    return conflictResult(envelope, Number(fields[0]), {
      idempotency_key: idempotencyKey,
      event_digest: eventDigest,
      reason: "idempotency key was reused with different event content",
      projection_digest: projectionDigest(rawInputs, envelope),
      provider_evidence: providerEvidence(rawInputs, envelope),
    });
  }

  if (status === "version_conflict") {
    const current = Number(fields[0]);
    return conflictResult(envelope, current, {
      idempotency_key: idempotencyKey,
      event_digest: eventDigest,
      reason: `expected version ${expectedVersion}, got ${current}`,
      projection_digest: projectionDigest(rawInputs, envelope),
      provider_evidence: providerEvidence(rawInputs, envelope),
    });
  }

  throw new Error(`unexpected redis append response: ${response}`);
}

function readEvents(rawInputs) {
  const envelope = baseEnvelope(rawInputs, "read_events");
  const limit = boundedLimit(rawInputs.limit);
  const keys = redisKeys(rawInputs, envelope);
  const rows = redis(rawInputs, ["LRANGE", keys.stream, String(-limit), "-1"]);
  const events = parseJsonLines(rows);
  const current = redisInteger(rawInputs, ["LLEN", keys.stream]);
  return {
    ...envelope,
    status: "read",
    before_version: current,
    after_version: current,
    idempotency_key: null,
    event_ref: null,
    event_digest: null,
    result_digest: sha256Json(events),
    projection_digest: projectionDigest(rawInputs, envelope),
    events,
    rows: events,
    redactions: [],
    stop_conditions: [],
    provider_evidence: providerEvidence(rawInputs, envelope),
  };
}

function readProjection(rawInputs) {
  const envelope = baseEnvelope(rawInputs, "read_projection");
  const projection = buildProjection(rawInputs, envelope);
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
    provider_evidence: providerEvidence(rawInputs, envelope),
  };
}

function appendScript() {
  return `
local current = redis.call('LLEN', KEYS[1])
local existing = redis.call('HGET', KEYS[2], ARGV[2])
if existing then
  local digest, ref, version, result_digest = string.match(existing, '^([^|]+)|([^|]+)|([^|]+)|([^|]+)$')
  if digest ~= ARGV[3] then
    return 'idempotency_conflict|' .. current
  end
  return 'idempotent_replay|' .. current .. '|' .. digest .. '|' .. ref .. '|' .. version .. '|' .. result_digest
end
local expected = tonumber(ARGV[1])
if current ~= expected then
  return 'version_conflict|' .. current
end
redis.call('RPUSH', KEYS[1], ARGV[6])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5] .. '|' .. ARGV[7])
return 'committed|' .. current .. '|' .. (current + 1) .. '|' .. ARGV[4] .. '|' .. ARGV[3] .. '|' .. ARGV[7]
`;
}

function conflictResult(envelope, currentVersionValue, { idempotency_key, event_digest, reason, projection_digest, provider_evidence }) {
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
    projection_digest,
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

function buildProjection(rawInputs, envelope) {
  const keys = redisKeys(rawInputs, envelope);
  const events = parseJsonLines(redis(rawInputs, ["LRANGE", keys.stream, "0", "-1"]));
  return {
    aggregate_id: envelope.aggregate_id,
    resource: envelope.resource,
    version: events.length,
    event_count: events.length,
    last_event_ref: events.at(-1)?.event_ref ?? null,
    last_event_type: events.at(-1)?.event_type ?? null,
    event_digests: events.map((entry) => entry.event_digest),
  };
}

function projectionDigest(rawInputs, envelope) {
  return sha256Json(buildProjection(rawInputs, envelope));
}

function providerEvidence(rawInputs, envelope) {
  const keys = redisKeys(rawInputs, envelope);
  return {
    provider: PROVIDER,
    adapter: "data.redis",
    data_source_ref_digest: sha256Json(envelope.data_source_ref),
    resource: envelope.resource,
    aggregate_id: envelope.aggregate_id,
    storage_class: "redis",
    key_prefix_digest: sha256Json(keyPrefix(rawInputs)),
    stream_digest: keys.digest,
  };
}

function redisKeys(rawInputs, envelope) {
  const digest = sha256Hex({
    data_source_ref: envelope.data_source_ref,
    resource: envelope.resource,
    aggregate_id: envelope.aggregate_id,
  });
  const prefix = keyPrefix(rawInputs);
  return {
    digest,
    stream: `${prefix}:stream:${digest}`,
    idempotency: `${prefix}:idempotency:${digest}`,
  };
}

function redisEval(rawInputs, script, keys, argv) {
  return redis(rawInputs, ["EVAL", script, String(keys.length), ...keys, ...argv]).trim();
}

function redisInteger(rawInputs, args) {
  const text = redis(rawInputs, args).trim();
  const value = Number(text || "0");
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`redis returned invalid integer for ${args[0]}`);
  }
  return value;
}

function redis(rawInputs, args) {
  const result = spawnSync(REDIS_CLI_BIN, ["-u", redisUrl(rawInputs), "--raw", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `redis-cli exited ${result.status}`).trim());
  }
  return result.stdout;
}

function redisUrl(rawInputs) {
  const sourceBinding = dataSourceBinding(rawInputs);
  const raw = textValue(sourceBinding.endpoint) ?? textValue(sourceBinding.redis_url) ?? textValue(rawInputs.redis_url) ?? "redis://127.0.0.1:6379/0";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("data.redis endpoint must be a valid redis:// or rediss:// URL");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("data.redis endpoint must use redis:// or rediss://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("data.redis endpoint must not embed credentials; use a runx credential profile or hosted grant");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("data.redis endpoint must not include query or fragment parameters");
  }
  return parsed.toString();
}

function keyPrefix(rawInputs) {
  const bindingObject = dataSourceBinding(rawInputs);
  const raw = textValue(bindingObject.key_prefix) ?? textValue(rawInputs.key_prefix) ?? "runx:data-store";
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
  if (!pattern.test(raw)) {
    throw new Error("data.redis key_prefix must be a safe Redis key prefix");
  }
  return raw;
}

function dataSourceBinding(rawInputs) {
  return rawInputs.data_source_binding && typeof rawInputs.data_source_binding === "object" && !Array.isArray(rawInputs.data_source_binding)
    ? rawInputs.data_source_binding
    : {};
}

function parseJsonLines(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => JSON.parse(line));
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

function textValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sha256Json(value) {
  return `sha256:${sha256Hex(value)}`;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
