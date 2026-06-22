import fs from "node:fs";

const inputs = readInputs();
const packet = objectValue(inputs.work_events, "work_events");
const policy = objectValue(inputs.policy ?? {}, "policy");
const events = Array.isArray(packet.events) ? packet.events : fail("work_events.events must be an array");

const blockerLabels = arrayOfStrings(policy.blocker_labels, ["blocked", "blocker", "needs-decision", "waiting"]);
const riskLabels = arrayOfStrings(policy.risk_labels, ["risk", "risky", "watch", "regression-risk"]);
const normalized = [];
const duplicates = [];
const skippedEvents = [];
const seenIds = new Set();
const seenFingerprints = new Set();

for (const rawEvent of events) {
  const event = normalizeEvent(rawEvent);
  if (!event) {
    skippedEvents.push({ reason: "event is not an object" });
    continue;
  }
  if (!event.id) {
    skippedEvents.push({ reason: "missing event id", title: event.title || event.body || null });
    continue;
  }
  if (!event.title && !event.body) {
    skippedEvents.push({ id: event.id, reason: "missing title and body" });
    continue;
  }
  const fingerprint = eventFingerprint(event);
  if (seenIds.has(event.id) || seenFingerprints.has(fingerprint)) {
    duplicates.push(event.id);
    continue;
  }
  seenIds.add(event.id);
  seenFingerprints.add(fingerprint);
  normalized.push(event);
}

const shipped = [];
const blockers = [];
const risks = [];
const nextActions = [];
const sourceMap = {};

for (const event of normalized) {
  if (isShipped(event)) {
    addMapped(shipped, sourceMap, "shipped", {
      summary: summarizeEvent(event),
      source_event_ids: [event.id],
      timestamp: event.timestamp,
      link: event.url,
    });
  }

  const blockerCriteria = blockerCriteriaFor(event, blockerLabels);
  if (blockerCriteria.length > 0) {
    addMapped(blockers, sourceMap, "blocker", {
      summary: summarizeEvent(event),
      source_event_ids: [event.id],
      criteria: blockerCriteria,
      timestamp: event.timestamp,
      link: event.url,
    });
  }

  if (isRisk(event, riskLabels)) {
    addMapped(risks, sourceMap, "risk", {
      summary: summarizeEvent(event),
      source_event_ids: [event.id],
      timestamp: event.timestamp,
      link: event.url,
    });
  }

  const action = nextActionFor(event, blockerCriteria);
  if (action) {
    addMapped(nextActions, sourceMap, "next", {
      summary: action,
      owner: event.owner || event.actor || null,
      source_event_ids: [event.id],
      timestamp: event.timestamp,
      link: event.url,
    });
  }
}

const result = {
  shipped,
  blockers,
  risks,
  next_actions: nextActions,
  source_map: sourceMap,
  digest_meta: {
    team: stringValue(policy.team) ?? stringValue(packet.team) ?? "unspecified team",
    window: stringValue(policy.window) ?? stringValue(packet.window) ?? inferWindow(normalized),
    input_event_count: events.length,
    used_event_count: normalized.length,
    duplicate_count: duplicates.length,
    duplicates,
    skipped_events: skippedEvents,
    blocker_criteria: [
      "blocked label",
      "failed build",
      "explicit blocker text",
      "waiting text",
      "needs-decision label",
    ],
    side_effects: "none",
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    work_events: parseInputValue(process.env.RUNX_INPUT_WORK_EVENTS),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return null;
  return {
    id: stringValue(rawEvent.id),
    type: stringValue(rawEvent.type) ?? "note",
    title: stringValue(rawEvent.title) ?? stringValue(rawEvent.subject),
    body: stringValue(rawEvent.body) ?? stringValue(rawEvent.text) ?? stringValue(rawEvent.summary),
    status: stringValue(rawEvent.status),
    timestamp: stringValue(rawEvent.timestamp) ?? stringValue(rawEvent.created_at) ?? stringValue(rawEvent.updated_at),
    url: stringValue(rawEvent.url) ?? stringValue(rawEvent.html_url),
    actor: stringValue(rawEvent.actor) ?? stringValue(rawEvent.author),
    owner: stringValue(rawEvent.owner) ?? stringValue(rawEvent.assignee),
    labels: arrayOfStrings(rawEvent.labels, []),
  };
}

function eventFingerprint(event) {
  return [
    normalize(event.type),
    normalize(event.title),
    normalize(event.body),
    normalize(event.status),
    normalize(event.url),
  ].join("|");
}

function isShipped(event) {
  const text = eventText(event);
  const shippedStatuses = ["merged", "closed", "done", "shipped", "resolved", "deployed", "passed"];
  return shippedStatuses.includes(normalize(event.status))
    || matches(text, ["merged", "shipped", "deployed", "released", "closed", "resolved", "fixed"]);
}

function blockerCriteriaFor(event, blockerLabels) {
  const text = eventText(event);
  const labels = event.labels.map(normalize);
  const criteria = [];
  if (labels.some((label) => blockerLabels.includes(label))) criteria.push("blocked_label");
  if (normalize(event.status) === "failed" || matches(text, ["failed build", "ci failed", "pipeline failed", "red build"])) {
    criteria.push("failed_build");
  }
  if (matches(text, ["blocked", "blocker", "cannot proceed", "waiting on", "needs decision"])) {
    criteria.push("explicit_blocker_text");
  }
  return [...new Set(criteria)];
}

function isRisk(event, riskLabels) {
  const text = eventText(event);
  const labels = event.labels.map(normalize);
  return labels.some((label) => riskLabels.includes(label))
    || matches(text, ["risk", "risky", "regression", "rollback", "deadline", "slip", "unstable", "flaky"]);
}

function nextActionFor(event, blockerCriteria) {
  const text = eventText(event);
  if (matches(text, ["todo:", "next:", "follow up", "follow-up", "action:"])) {
    return cleanSentence(extractActionText(event));
  }
  if (blockerCriteria.includes("failed_build")) {
    return `Investigate failed build for ${summarizeEvent(event)}`;
  }
  if (blockerCriteria.length > 0) {
    return `Unblock ${summarizeEvent(event)}`;
  }
  if (matches(text, ["needs review", "review requested"])) {
    return `Review ${summarizeEvent(event)}`;
  }
  return null;
}

function extractActionText(event) {
  const text = `${event.title ?? ""} ${event.body ?? ""}`;
  const match = text.match(/(?:todo:|next:|action:|follow[- ]up:?)(.{1,160})/i);
  return match ? match[1] : text;
}

function addMapped(collection, sourceMap, prefix, item) {
  const id = `${prefix}-${collection.length + 1}`;
  const mapped = { id, ...item };
  collection.push(mapped);
  sourceMap[id] = item.source_event_ids;
}

function summarizeEvent(event) {
  return cleanSentence(event.title || event.body || event.id);
}

function cleanSentence(value) {
  const line = String(value ?? "").replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function inferWindow(events) {
  const firstTimestamp = events.find((event) => event.timestamp)?.timestamp;
  return firstTimestamp ? firstTimestamp.slice(0, 10) : "unspecified";
}

function eventText(event) {
  return normalize(`${event.type} ${event.status ?? ""} ${event.title ?? ""} ${event.body ?? ""} ${event.labels.join(" ")}`);
}

function matches(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function arrayOfStrings(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map(stringValue).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
