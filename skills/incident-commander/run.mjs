import fs from "node:fs";

const inputs = readInputs();
const signals = arrayValue(inputs.signals, "signals");
const timeline = Array.isArray(inputs.timeline) ? inputs.timeline : [];
const services = Array.isArray(inputs.services) ? inputs.services : [];
const severityHint = stringValue(inputs.severity_hint) ?? "";

if (signals.length === 0) {
  fail("signals[] is required and must be non-empty");
}

const normalizedSignals = normalizeSignals(signals);
if (normalizedSignals.length === 0) {
  fail("signals[] has no entries with usable source + summary");
}

const SEV_RANK = { sev1: 4, sev2: 3, sev3: 2, sev4: 1 };

const severityAssessment = assessSeverity(normalizedSignals, severityHint);
const commandPosture = postureFor(severityAssessment);
const roles = defaultRoles();
const commsPlan = buildCommsPlan(severityAssessment);
const decisionCheckpoints = buildDecisionCheckpoints(severityAssessment);
const stopConditions = buildStopConditions(services, severityAssessment);
const handoff = {
  next_skill: "governed-outbound",
  requires_human_approval: true,
};

const result = {
  severity_assessment: severityAssessment,
  command_posture: commandPosture,
  roles,
  comms_plan: commsPlan,
  decision_checkpoints: decisionCheckpoints,
  stop_conditions: stopConditions,
  handoff,
  meta: {
    signal_count: normalizedSignals.length,
    service_count: services.length,
    timeline_event_count: timeline.length,
    severity_hint_used: severityHint || null,
    sources: Array.from(new Set(normalizedSignals.map((s) => s.source))),
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
    signals: parseInputValue(process.env.RUNX_INPUT_SIGNALS),
    timeline: parseInputValue(process.env.RUNX_INPUT_TIMELINE),
    services: parseInputValue(process.env.RUNX_INPUT_SERVICES),
    severity_hint: parseInputValue(process.env.RUNX_INPUT_SEVERITY_HINT),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be a JSON array`);
  return value;
}

function stringValue(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  return String(v);
}

function fail(reason) {
  process.stdout.write(`${JSON.stringify({ error: "incident_commander_invalid_input", detail: reason }, null, 2)}\n`);
  process.exit(64);
}

function normalizeSignals(raw) {
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const source = stringValue(s.source);
    const summary = stringValue(s.summary);
    const observedAt = stringValue(s.observed_at) ?? "";
    if (!source || !summary) continue;
    const fp = `${source}::${summary}`;
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({ source, summary: summary.slice(0, 280), observed_at: observedAt });
  }
  return out;
}

const SEV_RANK_LOCAL = { sev1: 4, sev2: 3, sev3: 2, sev4: 1 };

function assessSeverity(signals, hint) {
  let maxRank = 0;
  let picked = "sev4";
  for (const sig of signals) {
    const lower = sig.summary.toLowerCase();
    const guess = lower.includes("data exposure") || lower.includes("5xx spike") ? "sev1"
      : lower.includes("5xx") || lower.includes("error spike") ? "sev2"
      : lower.includes("latency") || lower.includes("slow") ? "sev3"
      : "sev4";
    const r = SEV_RANK[guess] || 1;
    if (r > maxRank) { maxRank = r; picked = guess; }
  }
  if (hint && SEV_RANK[hint]) {
    // never escalate above the hint
    if (SEV_RANK[hint] < maxRank) return hint;
  }
  return picked;
}

function postureFor(sev) {
  switch (sev) {
    case "sev1": return "mitigate";
    case "sev2": return "investigate";
    case "sev3":
    case "sev4":
    default:
      return "ack_only";
  }
}

function defaultRoles() {
  return [
    { role: "incident_commander", owner: "unassigned", ready: false },
    { role: "comms_lead", owner: "unassigned", ready: false },
    { role: "scribe", owner: "unassigned", ready: false },
    { role: "mitigation_lead", owner: "unassigned", ready: false },
  ];
}

function buildCommsPlan(sev) {
  if (sev === "sev1") {
    return [
      { checkpoint: "initial_ack", within_minutes: 5, channel: "status_page_draft" },
      { checkpoint: "first_update", within_minutes: 15, channel: "internal_war_room" },
      { checkpoint: "hourly_status", within_minutes: 60, channel: "status_page_draft" },
    ];
  }
  if (sev === "sev2") {
    return [
      { checkpoint: "initial_ack", within_minutes: 15, channel: "internal_war_room" },
      { checkpoint: "first_update", within_minutes: 30, channel: "internal_war_room" },
    ];
  }
  return [
    { checkpoint: "initial_ack", within_minutes: 30, channel: "internal_war_room" },
  ];
}

function buildDecisionCheckpoints(sev) {
  if (sev === "sev1") {
    return [
      { at_minutes: 15, decision: "reassess_mitigation_or_escalate" },
      { at_minutes: 30, decision: "reassess_or_open_p1_p2_handoff" },
      { at_minutes: 60, decision: "declare_resolved_or_open_p2" },
    ];
  }
  if (sev === "sev2") {
    return [
      { at_minutes: 30, decision: "reassess_or_escalate" },
      { at_minutes: 60, decision: "declare_resolved_or_open_p2" },
    ];
  }
  return [
    { at_minutes: 60, decision: "declare_resolved_or_close" },
  ];
}

function buildStopConditions(services, sev) {
  const conditions = [];
  if (sev === "sev1" || sev === "sev2") {
    conditions.push("service_impact_unresolved_at_60m");
  }
  if (services.length > 0) {
    conditions.push("customer_facing_data_exposure_detected");
  }
  if (sev === "sev1") {
    conditions.push("mitigation_failed_or_regressed");
  }
  return conditions;
}