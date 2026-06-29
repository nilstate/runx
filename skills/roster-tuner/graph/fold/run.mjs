import fs from "node:fs";

// Fold per-member metrics from the sealed case event stream.
// Reads events from data-store read_events, tallies each member's turn count,
// refusal count, refusal rate, and average completion time.

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

const inputs = readInputs();
const events = Array.isArray(inputs.events) ? inputs.events : [];
const roster = Array.isArray(inputs.roster) ? inputs.roster : [];
const declaredVersion = String(inputs.agency_event_schema_version ?? "1");
const caseId = inputs.case_id ?? null;

// Track per-member metrics
const memberMetrics = {};
for (const m of roster) {
  memberMetrics[m.member] = {
    member: m.member,
    skill: m.skill,
    turn_count: m.turn_count ?? 0,
    refusal_count: 0,
    completion_times: [],
  };
}

let schemaMismatch = false;

for (const entry of events) {
  const event = entry.event ?? entry ?? {};
  // Check schema version if present on the event
  if (event.schema_version && String(event.schema_version) !== declaredVersion) {
    schemaMismatch = true;
    break;
  }
  const payload = event.payload ?? {};
  if (event.type === "turn" || event.type === "dispatch") {
    const member = payload.member ?? payload.dispatch?.member ?? null;
    if (member && memberMetrics[member]) {
      if (payload.decision === "refuse" || payload.refused === true) {
        memberMetrics[member].refusal_count += 1;
      }
      if (typeof payload.completion_time === "number") {
        memberMetrics[member].completion_times.push(payload.completion_time);
      }
    }
  }
}

if (schemaMismatch) {
  process.stdout.write(JSON.stringify({
    stop: true,
    reason: "schema_version_mismatch",
    declared_version: declaredVersion,
    case_id: caseId,
  }, null, 2) + "\n");
  process.exit(0);
}

// Compute final metrics
const folded = Object.values(memberMetrics).map((m) => {
  const avgCompletion = m.completion_times.length > 0
    ? m.completion_times.reduce((a, b) => a + b, 0) / m.completion_times.length
    : 0;
  const refusalRate = m.turn_count > 0
    ? m.refusal_count / m.turn_count
    : 0;
  return {
    member: m.member,
    skill: m.skill,
    turn_count: m.turn_count,
    refusal_count: m.refusal_count,
    refusal_rate: Math.round(refusalRate * 100) / 100,
    avg_completion_time: Math.round(avgCompletion * 100) / 100,
  };
});

process.stdout.write(JSON.stringify({
  roster_metrics: {
    schema: "runx.roster.metrics.v1",
    case_id: caseId,
    members: folded,
    events_folded: events.length,
    declared_schema_version: declaredVersion,
  },
}, null, 2) + "\n");
