import fs from "node:fs";

const input = readInputs();
const policy = obj(input.digest_policy);
const events = normalize(input.work_events ?? input.events);

if (events.length === 0) {
  emit({ status: "needs_input", period: null, shipped: [], blockers: [], risks: [], next_actions: [], source_map: {}, evidence: { stop_reason: "work_events is required" } });
}

const unique = dedupe(events);
const shipped = unique.filter((event) => has(event, ["merged", "closed", "shipped", "deployed", "completed", "passed"])).map((event) => item(event, "shipped"));
const blockers = unique.filter((event) => has(event, ["blocked", "failed", "failing", "waiting", "needs approval", "incident"])).map((event) => item(event, "blocker"));
const risks = unique.filter((event) => has(event, ["risk", "regression", "flaky", "timeout", "unknown", "review needed"])).map((event) => item(event, "risk"));
const nextActions = unique.filter((event) => has(event, ["todo", "next", "follow up", "needs approval", "review", "assign"])).map((event) => item(event, "next_action"));
const sourceMap = {};
for (const entry of [...shipped, ...blockers, ...risks, ...nextActions]) sourceMap[entry.id] = entry.sources;

emit({
  status: "ready",
  period: text(policy.period) || inferPeriod(unique),
  shipped,
  blockers,
  risks,
  next_actions: nextActions,
  source_map: sourceMap,
  evidence: {
    input_events: events.length,
    unique_events: unique.length,
    duplicates_removed: events.length - unique.length,
    source_mapping: "every digest item cites input event ids",
  },
});

function normalize(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : [];
  return list.map((event, index) => ({
    id: text(event.id) || `event_${index + 1}`,
    title: text(event.title) || text(event.summary) || "Untitled event",
    summary: text(event.summary) || text(event.body) || text(event.title) || "",
    status: text(event.status) || "",
    type: text(event.type) || "note",
    timestamp: text(event.timestamp) || text(event.created_at) || null,
    link: text(event.link) || text(event.url) || null,
  }));
}
function dedupe(events) { const seen = new Set(); return events.filter((event) => { if (seen.has(event.id)) return false; seen.add(event.id); return true; }); }
function combined(event) { return `${event.type} ${event.title} ${event.summary} ${event.status}`.toLowerCase(); }
function has(event, words) { const body = combined(event); return words.some((word) => body.includes(word)); }
function item(event, kind) { return { id: `${kind}:${event.id}`, event_id: event.id, title: event.title, summary: event.summary || event.title, timestamp: event.timestamp, sources: [{ event_id: event.id, link: event.link, timestamp: event.timestamp }] }; }
function inferPeriod(events) { return events.map((event) => event.timestamp).filter(Boolean).sort()[0] || "bounded_input"; }
function readInputs() { if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")); if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON); return {}; }
function obj(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }

