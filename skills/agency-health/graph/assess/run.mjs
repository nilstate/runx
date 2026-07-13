import fs from "node:fs";

const inputs = JSON.parse(process.env.RUNX_INPUTS_PATH
  ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
  : process.env.RUNX_INPUTS_JSON || "{}");
const projection = inputs.fixture_projection ?? inputs.projection ?? {};
const events = Array.isArray(projection.events) ? projection.events : [];

if (events.length === 0) {
  emit({
    decision: "needs_more_evidence",
    health_verdict: { status: "unknown", findings: [] },
    intervention_findings: [],
  });
}

const baseline = object(inputs.health_baseline);
const stats = { turns: 0, maxTurns: null, stuckDays: 0, refusals: 0, escalations: 0 };
for (const entry of events) {
  const event = object(entry.event ?? entry);
  const payload = object(event.payload);
  if (event.type === "opened" && Number.isFinite(payload.limits?.max_turns)) stats.maxTurns = payload.limits.max_turns;
  if (event.type === "turn") {
    stats.turns = Math.max(stats.turns, numeric(payload.turn, 0));
    stats.stuckDays = Math.max(stats.stuckDays, numeric(payload.age_days, 0));
  }
  if (event.type === "refusal") stats.refusals += 1;
  if (event.type === "escalate" || event.type === "escalation") stats.escalations += 1;
}

const findings = [];
const interventions = [];
const capPct = stats.maxTurns && stats.maxTurns > 0 ? Math.round((stats.turns / stats.maxTurns) * 100) : null;
if (capPct !== null && Number.isFinite(baseline.cap_pressure_pct) && capPct >= baseline.cap_pressure_pct) {
  findings.push(finding("cap_usage_pct", capPct, "warning", "Case turn usage is at or above the explicit cap-pressure threshold."));
  interventions.push(intervention("human-ops", "Cap or authority widening requires a human operator.", "human_required"));
}
if (Number.isFinite(baseline.threshold_days_stuck) && stats.stuckDays >= baseline.threshold_days_stuck) {
  findings.push(finding("stuck_case_count", 1, "warning", "The case age exceeds the explicit stuck threshold."));
  interventions.push(intervention("improve-skill", "Inspect the blocked execution path and add a bounded recovery or harness case.", "route"));
}
if (stats.refusals > 0 && Number.isFinite(baseline.refusal_spike_rate)) {
  findings.push(finding("refusal_spike", stats.refusals, "warning", "Refusals were observed; rate cannot be inferred without a bounded denominator."));
  interventions.push(intervention("policy-author", "Review the policy boundary behind the observed refusal.", "route"));
}
if (capPct !== null) findings.push(finding("seal_rate", "unavailable", "info", "Seal rate is not inferred from a single case projection."));
if (stats.escalations > 0) findings.push(finding("escalation_backlog", stats.escalations, "warning", "Observed unresolved escalation events in this case projection."));

const status = findings.some((item) => item.grade === "warning") ? "degraded" : "healthy";
emit({ decision: "ready", health_verdict: { status, findings }, intervention_findings: interventions });

function numeric(value, fallback) { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function finding(metric, value, grade, rationale) { return { metric, value, grade, rationale }; }
function intervention(lane, action, disposition) { return { lane, action, disposition }; }
function emit(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exit(0); }