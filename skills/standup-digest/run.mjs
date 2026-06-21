import fs from "node:fs";
import path from "node:path";

const SCHEMA = "runx.standup_digest.v1";
const inputs = readInputs();
const skillRoot = process.cwd();

const events = normalizeEvents(inputs.work_events);
const digest = buildDigest({
  events,
  team: stringValue(inputs.team) || "unspecified team",
  window: stringValue(inputs.window) || "unspecified window",
});
const report = renderReport(digest);

writeArtifacts(inputs.output_dir, digest, report, skillRoot);
process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function normalizeEvents(rawValue) {
  const parsed = parseMaybeJson(rawValue);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((event) => event && typeof event === "object")
    .map((event, index) => ({
      id: stringValue(event.id) || `event-${index + 1}`,
      kind: stringValue(event.kind) || "event",
      title: stringValue(event.title) || stringValue(event.summary) || "Untitled event",
      status: stringValue(event.status).toLowerCase(),
      timestamp: stringValue(event.timestamp) || stringValue(event.created_at) || stringValue(event.updated_at),
      url: stringValue(event.url) || stringValue(event.link),
      external_ref: stringValue(event.external_ref) || stringValue(event.ref),
      labels: normalizeStringArray(event.labels),
      body: stringValue(event.body) || stringValue(event.note) || stringValue(event.description),
      assignee: stringValue(event.assignee) || stringValue(event.owner),
    }));
}

function buildDigest({ events, team, window }) {
  if (events.length === 0) {
    return {
      schema: SCHEMA,
      decision: "needs_more_evidence",
      team,
      window,
      shipped: [],
      blockers: [],
      risks: [],
      next_actions: [],
      unclassified_events: [],
      source_map: [],
      missing_evidence: [{
        event_id: "",
        field: "work_events",
        reason: "At least one bounded event is required to produce a digest.",
      }],
      dedupe: { input_events: 0, unique_events: 0 },
    };
  }

  const groups = dedupeEvents(events);
  const digest = {
    schema: SCHEMA,
    decision: "ready",
    team,
    window,
    shipped: [],
    blockers: [],
    risks: [],
    next_actions: [],
    unclassified_events: [],
    source_map: [],
    missing_evidence: [],
    dedupe: { input_events: events.length, unique_events: groups.length },
  };

  for (const group of groups) {
    const item = itemFromGroup(group);
    for (const source of group.events) {
      if (!source.timestamp) {
        digest.missing_evidence.push({
          event_id: source.id,
          field: "timestamp",
          reason: "Source event did not include a timestamp.",
        });
      }
      if (!source.url) {
        digest.missing_evidence.push({
          event_id: source.id,
          field: "url",
          reason: "Source event did not include a link.",
        });
      }
    }

    const bucket = classify(group);
    digest.source_map.push({
      item: item.summary,
      event_ids: item.event_ids,
      evidence: `${bucket} from ${group.events.map((event) => event.kind || "event").join(", ")}`,
    });
    if (bucket === "unclassified_events") {
      digest.unclassified_events.push(item);
    } else {
      digest[bucket].push(item);
    }
  }

  return digest;
}

function dedupeEvents(events) {
  const byKey = new Map();
  for (const event of events) {
    const key = event.external_ref
      || event.url
      || event.id
      || `${event.kind}:${event.status}:${event.title.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(event);
  }
  return [...byKey.entries()].map(([key, grouped]) => ({ key, events: grouped }));
}

function classify(group) {
  const text = group.events
    .map((event) => `${event.kind} ${event.status} ${event.title} ${event.body} ${event.labels.join(" ")}`)
    .join(" ")
    .toLowerCase();
  if (/\b(blocked|blocker|failed|failing|red|cannot proceed|stuck)\b/.test(text)) return "blockers";
  if (/\b(risk|risky|regression|flaky|deadline|slipping|watch)\b/.test(text)) return "risks";
  if (/\b(todo|next|follow.?up|needs|pending|review requested|awaiting)\b/.test(text)) return "next_actions";
  if (/\b(merged|closed|done|shipped|released|deployed|passed|green)\b/.test(text)) return "shipped";
  return "unclassified_events";
}

function itemFromGroup(group) {
  const eventIds = group.events.map((event) => event.id);
  const timestamps = unique(group.events.map((event) => event.timestamp).filter(Boolean));
  const links = unique(group.events.map((event) => event.url).filter(Boolean));
  const lead = group.events[0];
  return {
    summary: lead.title,
    event_ids: eventIds,
    timestamps,
    links,
    owner: lead.assignee || "",
  };
}

function renderReport(digest) {
  const lines = [
    "# Standup Digest",
    "",
    `Decision: ${digest.decision}`,
    `Team: ${digest.team}`,
    `Window: ${digest.window}`,
    `Events: ${digest.dedupe.input_events} input, ${digest.dedupe.unique_events} unique`,
    "",
    "## Shipped",
    ...renderItems(digest.shipped),
    "",
    "## Blockers",
    ...renderItems(digest.blockers),
    "",
    "## Risks",
    ...renderItems(digest.risks),
    "",
    "## Next Actions",
    ...renderItems(digest.next_actions),
    "",
    "## Source Map",
    ...digest.source_map.map((entry) => `- ${entry.item}: ${entry.event_ids.join(", ")} (${entry.evidence})`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderItems(items) {
  if (!items.length) return ["- None."];
  return items.map((item) => {
    const refs = item.event_ids.join(", ");
    const links = item.links.length ? ` ${item.links.join(" ")}` : "";
    return `- ${item.summary} [${refs}]${links}`;
  });
}

function writeArtifacts(outputDir, evidence, report, root) {
  if (typeof outputDir !== "string" || outputDir.trim() === "") return;
  const resolved = path.resolve(root, outputDir);
  ensureInside(root, resolved, "output_dir");
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(path.join(resolved, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(resolved, "report.md"), report);
}

function ensureInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the skill directory`);
  }
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stringValue(entry)).filter(Boolean);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((entry) => stringValue(entry)).filter(Boolean);
    } catch {
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function unique(values) {
  return [...new Set(values)];
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
