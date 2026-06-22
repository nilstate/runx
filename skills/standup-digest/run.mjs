import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const workEvents = requireObject(inputs.work_events, "work_events");
const rawEvents = Array.isArray(workEvents.events) ? workEvents.events : [];
const policy = normalizePolicy(inputs.policy);

const ignored = [];
const accepted = [];

for (let index = 0; index < rawEvents.length; index += 1) {
  const normalized = normalizeEvent(rawEvents[index], index);
  if (normalized.ignored) {
    ignored.push(normalized.ignored);
  } else {
    accepted.push(normalized);
  }
}

const { events, duplicateGroups } = deduplicate(accepted);
const buckets = {
  shipped: [],
  blockers: [],
  risks: [],
  next_actions: [],
};
const sourceMap = {};

for (const event of events) {
  const categories = classify(event, policy);
  for (const category of categories) {
    const item = digestItem(event, category);
    buckets[category].push(item);
    sourceMap[item.digest_id] = {
      category,
      source_event_ids: item.source_event_ids,
      timestamps: item.timestamps,
      links: item.links,
    };
  }
}

for (const values of Object.values(buckets)) {
  values.sort(compareDigestItems);
}

const result = {
  shipped: buckets.shipped,
  blockers: buckets.blockers,
  risks: buckets.risks,
  next_actions: buckets.next_actions,
  source_map: sourceMap,
  digest_meta: {
    schema: "runx.standup_digest.v1",
    team: stringValue(workEvents.team) || "unknown",
    window: normalizeWindow(workEvents.window),
    event_counts: {
      input: rawEvents.length,
      accepted: accepted.length,
      unique: events.length,
      duplicates_collapsed: accepted.length - events.length,
      ignored: ignored.length,
    },
    duplicate_groups: duplicateGroups,
    ignored_events: ignored,
    blocker_criteria: {
      statuses: policy.blocker_statuses,
      labels: policy.blocker_labels,
    },
    side_effects: [],
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function normalizePolicy(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    shipped_statuses: stringList(input.shipped_statuses, ["merged", "closed", "done", "shipped", "released"]),
    blocker_statuses: stringList(input.blocker_statuses, ["blocked", "failed", "failing"]),
    blocker_labels: stringList(input.blocker_labels, ["blocker", "blocked"]),
    risk_labels: stringList(input.risk_labels, ["risk", "at-risk"]),
    next_action_labels: stringList(input.next_action_labels, ["next-action", "action-needed"]),
  };
}

function normalizeEvent(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ignored: { index, reason: "event_not_object" } };
  }

  const id = stringValue(value.id);
  if (!id) return { ignored: { index, reason: "missing_id" } };

  const title = stringValue(value.title) || stringValue(value.body);
  if (!title) return { ignored: { index, id, reason: "missing_content" } };

  return {
    id,
    type: stringValue(value.type) || "event",
    title,
    status: lower(value.status) || "unknown",
    timestamp: normalizeTimestamp(value.timestamp),
    url: stringValue(value.url),
    owner: stringValue(value.owner),
    labels: stringList(value.labels, []).map(lower),
    source_ids: [id],
    timestamps: normalizeTimestamp(value.timestamp) ? [normalizeTimestamp(value.timestamp)] : [],
    links: stringValue(value.url) ? [stringValue(value.url)] : [],
  };
}

function deduplicate(values) {
  const byKey = new Map();
  for (const event of values) {
    const normalizedTitle = event.title.toLowerCase().replace(/\s+/g, " ").trim();
    const key = event.url ? `url:${event.url}|title:${normalizedTitle}` : `id:${event.id}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...event });
      continue;
    }
    current.source_ids = unique([...current.source_ids, ...event.source_ids]);
    current.timestamps = unique([...current.timestamps, ...event.timestamps]).sort();
    current.links = unique([...current.links, ...event.links]).sort();
    current.labels = unique([...current.labels, ...event.labels]).sort();
    if (current.status === "unknown" && event.status !== "unknown") current.status = event.status;
  }
  const events = [...byKey.values()];
  events.sort(compareEvents);
  const duplicateGroups = events
    .filter((event) => event.source_ids.length > 1)
    .map((event) => ({
      retained_event_id: event.id,
      source_event_ids: event.source_ids,
      links: event.links,
    }));
  return { events, duplicateGroups };
}

function classify(event, policy) {
  const categories = [];
  const has = (values) => values.some((value) => event.labels.includes(value));
  if (policy.shipped_statuses.includes(event.status)) categories.push("shipped");
  if (policy.blocker_statuses.includes(event.status) || has(policy.blocker_labels)) categories.push("blockers");
  if (has(policy.risk_labels)) categories.push("risks");
  if (has(policy.next_action_labels) || ["open", "pending", "in_progress"].includes(event.status)) {
    categories.push("next_actions");
  }
  return categories;
}

function digestItem(event, category) {
  return {
    digest_id: `${category}:${stableId(event.source_ids)}`,
    summary: event.title,
    event_type: event.type,
    status: event.status,
    owner: event.owner,
    source_event_ids: event.source_ids,
    timestamps: event.timestamps,
    links: event.links,
  };
}

function stableId(values) {
  return crypto.createHash("sha256").update([...values].sort().join("\n")).digest("hex").slice(0, 12);
}

function normalizeWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { start: null, end: null };
  return {
    start: normalizeTimestamp(value.start),
    end: normalizeTimestamp(value.end),
  };
}

function normalizeTimestamp(value) {
  const text = stringValue(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function compareEvents(left, right) {
  return (left.timestamp || "").localeCompare(right.timestamp || "") || left.id.localeCompare(right.id);
}

function compareDigestItems(left, right) {
  return (left.timestamps[0] || "").localeCompare(right.timestamps[0] || "")
    || left.digest_id.localeCompare(right.digest_id);
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return unique(value.map(stringValue).filter(Boolean));
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function lower(value) {
  const text = stringValue(value);
  return text ? text.toLowerCase() : null;
}

function unique(values) {
  return [...new Set(values)];
}
