#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";

const inputs = readInputs();
const projectionPacket = requiredObject(inputs, "projection_packet");
const ledgerPacket = requiredObject(inputs, "ledger_packet");
const period = optional(inputs, "period", null);
const baseline = optional(inputs, "health_baseline", {});

const projection = projectionPacket.data_operation_result?.data ?? projectionPacket;
if (projection.operation !== "read_projection" || projection.status !== "read") {
  seal({
    decision: "needs_more_evidence",
    health_verdict: { status: "degraded", findings: [] },
    intervention_findings: [],
    refusals: [{ when: "composition_unreadable", reason: "data-store read_projection did not return a readable projection" }],
  });
  process.exit(0);
}

const rows = projection.rows ?? projection.events ?? [];
const folded = rows
  .map(normalizeEvent)
  .filter(Boolean)
  .filter((event) => inPeriod(event, period))
  .sort((a, b) => a.version - b.version);
const charter = readCharter(projection, folded);

if (folded.length === 0) {
  seal({
    decision: "needs_more_evidence",
    health_verdict: { status: "degraded", findings: [] },
    intervention_findings: [],
    refusals: [{ when: "no_case_events", reason: "no readable agency case events over the period", period }],
  });
  process.exit(0);
}

const ledger = ledgerPacket.ledger_answer_packet?.data ?? ledgerPacket;
const ledgerStubs = Array.isArray(ledger.matched_receipts) ? ledger.matched_receipts : [];
const findings = gradeFindings({ folded, charter, baseline, ledgerStubs });
const intervention_findings = emitInterventions({ findings, charter });
const rank = { healthy: 0, concerning: 1, critical: 2 };
const worst = findings.reduce((value, finding) => Math.max(value, rank[finding.assessment] ?? 0), 0);
const status = worst >= 2 ? "critical" : worst >= 1 ? "degraded" : "healthy";

seal({
  decision: status === "critical" ? "needs_human" : "ready",
  health_verdict: {
    status,
    case_id: charter.case_id,
    projection_version: projection.after_version ?? projection.projection?.version ?? folded.at(-1)?.version,
    folded_turns: folded.length,
    ledger_receipt_stubs: ledgerStubs.map((entry) => entry.receipt_id),
    findings,
  },
  intervention_findings,
  refusals: [],
});

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || fs.readFileSync(0, "utf8") || "{}";
  return JSON.parse(raw);
}

function requiredObject(value, name) {
  const field = value[name];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`${name} is required`);
  }
  return field;
}

function optional(value, name, fallback) {
  return value[name] === undefined || value[name] === null ? fallback : value[name];
}

function normalizeEvent(record) {
  if (!record || typeof record !== "object") return null;
  const event = record.event && typeof record.event === "object" ? record.event : record;
  const payload = event.payload && typeof event.payload === "object" ? event.payload : event;
  const version = Number(record.version ?? payload.version);
  if (!Number.isFinite(version)) return null;
  return {
    ...payload,
    version,
    at: record.committed_at ?? payload.at ?? payload.observed_at,
    status: payload.status ?? payload.decision ?? payload.outcome ?? event.type,
  };
}

function readCharter(projection, folded) {
  const opened = folded.find((event) => event.type === "opened" || event.status === "opened") ?? {};
  const snapshot = projection.projection?.charter ?? projection.charter ?? opened.charter ?? opened;
  const limits = snapshot.limits ?? {};
  const cumulative = snapshot.cumulative ?? folded.reduce((value, event) => ({
    acts: value.acts + Number(event.acts ?? event.act_count ?? 1),
    spend: value.spend + Number(event.spend ?? event.spend_amount ?? 0),
  }), { acts: 0, spend: 0 });
  return {
    case_id: projection.aggregate_id ?? projection.projection?.aggregate_id ?? snapshot.case_id,
    limits: {
      max_acts: Number(limits.max_acts ?? limits.max_turns ?? 0),
      max_spend: Number(limits.max_spend ?? limits.spend ?? 0),
    },
    cumulative,
  };
}

function inPeriod(event, period) {
  if (!period) return true;
  const timestamp = Date.parse(event.at);
  if (Number.isNaN(timestamp)) return false;
  if (period.since && timestamp < Date.parse(period.since)) return false;
  if (period.until && timestamp > Date.parse(period.until)) return false;
  return true;
}

function gradeFindings({ folded, charter, baseline, ledgerStubs }) {
  const findings = [];
  const sealed = folded.filter((event) => ["advanced", "resolved", "sealed"].includes(event.status)).length;
  const refused = folded.filter((event) => ["refused", "failed"].includes(event.status)).length;
  const parked = folded.filter((event) => event.status === "awaiting_approval");
  const sealRate = sealed / folded.length;
  const refusalRate = refused / folded.length;
  const ledgerStub = ledgerStubs[0]?.receipt_id ?? null;
  const turn = folded.at(-1)?.version ?? null;

  findings.push(finding("seal_rate", sealRate >= 0.9 ? "healthy" : sealRate >= 0.7 ? "concerning" : "critical", "seal_rate >= 0.9 healthy; >= 0.7 concerning; else critical", Number(sealRate.toFixed(3)), charter.case_id, turn, ledgerStub));

  const maxActs = charter.limits.max_acts;
  const maxSpend = charter.limits.max_spend;
  const actsPct = maxActs > 0 ? (Number(charter.cumulative.acts) / maxActs) * 100 : 0;
  const spendPct = maxSpend > 0 ? (Number(charter.cumulative.spend) / maxSpend) * 100 : 0;
  const capUsage = Math.round(Math.max(actsPct, spendPct));
  const capThreshold = Number(baseline.cap_pressure_pct ?? 80);
  findings.push(finding("cap_usage_pct", capUsage < capThreshold ? "healthy" : capUsage < 95 ? "concerning" : "critical", `cap_usage_pct < ${capThreshold} healthy; < 95 concerning; else critical`, capUsage, charter.case_id, turn, null));

  const stuckThresholdDays = Number(baseline.threshold_days_stuck ?? 2);
  const referenceAt = Date.parse(periodEnd(baseline, folded));
  const stuckCases = parked.filter((event) => {
    const parkedAt = Date.parse(event.at);
    return Number.isFinite(parkedAt) && Number.isFinite(referenceAt)
      && (referenceAt - parkedAt) / 86_400_000 >= stuckThresholdDays;
  }).length;
  findings.push(finding("stuck_case_count", stuckCases === 0 ? "healthy" : stuckCases <= 2 ? "concerning" : "critical", `stuck_case_count = 0 healthy; <= 2 concerning; else critical after ${stuckThresholdDays} days`, stuckCases, charter.case_id, parked[0]?.version ?? turn, null));

  if (parked.length > 0) {
    findings.push(finding("escalation_backlog", parked.length <= 2 ? "healthy" : parked.length <= 5 ? "concerning" : "critical", "escalation_backlog <= 2 healthy; <= 5 concerning; else critical", parked.length, charter.case_id, parked[0].version, null));
  }

  const refusalThreshold = Number(baseline.refusal_spike_rate ?? 0.1);
  findings.push(finding("refusal_spike_rate", refusalRate <= refusalThreshold ? "healthy" : refusalRate <= refusalThreshold * 2 ? "concerning" : "critical", `refusal_spike_rate <= ${refusalThreshold} healthy; <= ${refusalThreshold * 2} concerning; else critical`, Number(refusalRate.toFixed(3)), charter.case_id, turn, ledgerStub));
  return findings;
}

function periodEnd(baseline, folded) {
  if (baseline.reference_at) return baseline.reference_at;
  return folded.at(-1)?.at;
}

function finding(metric, assessment, norm, value, caseId, turn, ledgerIdStub) {
  return { metric, assessment, norm, value, evidence: { case_id: caseId, turn, ledger_id_stub: ledgerIdStub } };
}

function emitInterventions({ findings, charter }) {
  return findings.filter((finding) => finding.assessment !== "healthy").map((finding) => {
    const critical = finding.assessment === "critical";
    const capWidening = finding.metric === "cap_usage_pct" && critical;
    const target = critical ? "human-ops" : finding.metric === "refusal_spike_rate" ? "improve-skill" : "policy-author";
    return {
      target_lane: target,
      reason: `${finding.metric} graded ${finding.assessment} at ${finding.value}`,
      remedy_class: critical ? "escalate" : finding.metric === "refusal_spike_rate" ? "debug" : "tighten",
      cap_widening: capWidening,
      authority_widening: false,
      grounding: { case_id: charter.case_id, turn: finding.evidence.turn, ledger_id_stub: finding.evidence.ledger_id_stub },
    };
  });
}

function seal(body) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  process.stdout.write(`${JSON.stringify({ schema: "runx.agency.health.v1", ...body, receipt_local: { schema: "runx.receipt.local.v1", algorithm: "sha256", digest } })}\n`);
}
