import { spawnSync } from "node:child_process";

import { sha256Hex } from "./canonical-json.mjs";

const REDIS_CLI_BIN = process.env.RUNX_REDIS_CLI_BIN || "redis-cli";
const REDIS_RESPONSE_BYTES = 16 * 1024 * 1024;

export function createRedisStore(inputs, identity) {
  const binding = resolvedBinding(inputs);
  const endpoint = redisUrl(binding);
  const prefix = keyPrefix(binding);
  const keys = redisKeys(prefix, identity);
  const command = (args) => redis(endpoint, args);
  const evaluate = (script, scriptKeys, argv) => command([
    "EVAL",
    script,
    String(scriptKeys.length),
    ...scriptKeys,
    ...argv,
  ]).trim();

  return {
    identity: {
      key_prefix: prefix,
      stream_digest: keys.digest,
    },
    append(argv) {
      return evaluate(APPEND_SCRIPT, [
        keys.stream,
        keys.idempotency,
        keys.resourceIndex,
        keys.resourceHeads,
        keys.resourceIndexMembers,
        keys.projection,
      ], argv);
    },
    readEvents(start, stop) {
      return JSON.parse(evaluate(READ_EVENTS_SCRIPT, [keys.stream, keys.projection], [
        String(start),
        String(stop),
      ]));
    },
    projectionSnapshot() {
      return JSON.parse(evaluate(PROJECTION_SNAPSHOT_SCRIPT, [keys.stream, keys.projection], []));
    },
    headMembers(afterMember) {
      return parseLines(command([
        "ZRANGEBYLEX",
        keys.resourceIndex,
        afterMember ? `(${afterMember}` : "-",
        "+",
        "LIMIT",
        "0",
        "100",
      ]));
    },
    headRecords(aggregateIds) {
      return parseBulkValues(command(["HMGET", keys.resourceHeads, ...aggregateIds]));
    },
  };
}

export function headIndexMember(aggregateId, committedAt) {
  const score = Date.parse(committedAt);
  const safeScore = Number.isFinite(score) ? score : 0;
  const dateOffset = 8_640_000_000_000_000n;
  const invertedScore = dateOffset * 2n - (BigInt(safeScore) + dateOffset);
  return `${invertedScore.toString().padStart(17, "0")}|${aggregateId}`;
}

export function aggregateIdFromHeadIndexMember(value) {
  const separator = value.indexOf("|");
  const aggregateId = value.slice(separator + 1);
  if (separator !== 17 || !/^\d{17}$/u.test(value.slice(0, separator)) || !safeAggregateId(aggregateId)) {
    throw new Error("redis stream-head index contains an invalid member");
  }
  return aggregateId;
}

export function encodeHeadCursor(row) {
  return Buffer.from(JSON.stringify({
    committed_at: row.committed_at,
    aggregate_id: row.aggregate_id,
  }), "utf8").toString("base64url");
}

export function decodeHeadCursor(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("cursor must be an opaque list_stream_heads cursor");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
      || typeof decoded.committed_at !== "string" || decoded.committed_at.length > 100
      || Number.isNaN(Date.parse(decoded.committed_at)) || !safeAggregateId(decoded.aggregate_id)) {
      throw new Error("invalid cursor");
    }
    return decoded;
  } catch {
    throw new Error("cursor must be an opaque list_stream_heads cursor");
  }
}

function resolvedBinding(inputs) {
  const binding = inputs.data_source_binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || binding.adapter !== "data.redis") {
    throw new Error("data.redis requires a runtime-resolved data_source_binding");
  }
  return binding;
}

function redisUrl(binding) {
  const raw = nonEmptyText(binding.endpoint) ?? "redis://127.0.0.1:6379/0";
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

function keyPrefix(binding) {
  const raw = nonEmptyText(binding.key_prefix) ?? "runx:data-store";
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._:{}\/-]{0,191}$/;
  const hashTag = raw.match(/\{([A-Za-z0-9][A-Za-z0-9._:-]{0,63})\}/);
  const remainder = hashTag ? raw.replace(hashTag[0], "") : raw;
  if (!pattern.test(raw) || remainder.includes("{") || remainder.includes("}")) {
    throw new Error("data.redis key_prefix must be a safe Redis key prefix");
  }
  return raw;
}

function redisKeys(prefix, identity) {
  const digest = sha256Hex({
    data_source_ref: identity.data_source_ref,
    resource: identity.resource,
    aggregate_id: identity.aggregate_id,
  });
  const resourceDigest = sha256Hex({
    data_source_ref: identity.data_source_ref,
    resource: identity.resource,
  });
  return {
    digest,
    stream: `${prefix}:stream:${digest}`,
    idempotency: `${prefix}:idempotency:${digest}`,
    resourceIndex: `${prefix}:resource:${resourceDigest}:heads-index-v2`,
    resourceHeads: `${prefix}:resource:${resourceDigest}:heads-v2`,
    resourceIndexMembers: `${prefix}:resource:${resourceDigest}:head-index-members-v2`,
    projection: `${prefix}:projection:${digest}:v1`,
  };
}

function redis(endpoint, args) {
  const result = spawnSync(REDIS_CLI_BIN, ["-u", endpoint, "--raw", ...args], {
    encoding: "utf8",
    maxBuffer: REDIS_RESPONSE_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `redis-cli exited ${result.status}`).trim());
  }
  return result.stdout;
}

function parseLines(stdout) {
  const text = stdout.trim();
  return text ? text.split(/\r?\n/) : [];
}

function parseBulkValues(stdout) {
  const text = stdout.replace(/\r?\n$/, "");
  return text ? text.split(/\r?\n/) : [];
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeAggregateId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/u.test(value);
}

const APPEND_SCRIPT = `
local current = redis.call('LLEN', KEYS[1])
local projection_digest = ARGV[12]
local projection = redis.call('GET', KEYS[6])
if projection then
  projection_digest = cjson.decode(projection)['projection_digest']
end
local existing = redis.call('HGET', KEYS[2], ARGV[2])
if existing then
  local digest, ref, version, result_digest = string.match(existing, '^([^|]+)|([^|]+)|([^|]+)|([^|]+)$')
  if digest ~= ARGV[3] then
    return 'idempotency_conflict|' .. current .. '|' .. projection_digest
  end
  return 'idempotent_replay|' .. current .. '|' .. digest .. '|' .. ref .. '|' .. version .. '|' .. result_digest .. '|' .. projection_digest
end
local expected = tonumber(ARGV[1])
if current ~= expected then
  return 'version_conflict|' .. current .. '|' .. projection_digest
end
redis.call('RPUSH', KEYS[1], ARGV[6])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5] .. '|' .. ARGV[7])
local previous_index_member = redis.call('HGET', KEYS[5], ARGV[8])
if previous_index_member then
  redis.call('ZREM', KEYS[3], previous_index_member)
end
redis.call('ZADD', KEYS[3], 0, ARGV[9])
redis.call('HSET', KEYS[4], ARGV[8], ARGV[6])
redis.call('HSET', KEYS[5], ARGV[8], ARGV[9])
redis.call('SET', KEYS[6], ARGV[10])
return 'committed|' .. current .. '|' .. (current + 1) .. '|' .. ARGV[4] .. '|' .. ARGV[3] .. '|' .. ARGV[7] .. '|' .. ARGV[11]
`;

const READ_EVENTS_SCRIPT = `
local events = redis.call('LRANGE', KEYS[1], ARGV[1], ARGV[2])
local current = redis.call('LLEN', KEYS[1])
local projection = redis.call('GET', KEYS[2])
if not projection then projection = cjson.null end
return cjson.encode({ current = current, events = events, projection = projection })
`;

const PROJECTION_SNAPSHOT_SCRIPT = `
local projection = redis.call('GET', KEYS[2])
if not projection then projection = cjson.null end
return cjson.encode({ current = redis.call('LLEN', KEYS[1]), projection = projection })
`;
