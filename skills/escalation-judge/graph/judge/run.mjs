import fs from "node:fs";
import crypto from "node:crypto";

const input = readInputs();
const triage = object(input.triage_packet);
const policy = object(input.policy_rules);
const threadBody = text(input.thread_body);
const aggregateId = text(input.aggregate_id);
const lanes = object(policy.escalation_lanes);
const thresholds = object(policy.severity_thresholds);
const churnSignals = array(policy.churn_risk_signals).map((value) => text(value).toLowerCase());
const prior = object(input.prior_case_projection);

const evidence = {
  severity: text(triage.severity).toLowerCase() || null,
  confidence: number(triage.confidence),
  matched_policy_threshold: null,
  matched_churn_signals: [],
  prior_case_projection: prior,
  named_target_rail: null,
};

let decision = { escalate: false, lane: null, reason: "no_change" };
let stopState = { state: "no_change", reason: "No named policy threshold was crossed." };

if (!Object.keys(thresholds).length || !Object.keys(lanes).length) {
  stopState = { state: "needs_human", reason: "policy_rules must declare severity_thresholds and escalation_lanes" };
  decision.reason = "missing_policy_rules";
} else if (prior.case_id || prior.escalated === true) {
  stopState = { state: "no_change", reason: "A prior escalation case already exists for this thread." };
  decision.reason = "already_escalated";
} else {
  const severityMatch = strongestSeverityMatch(evidence.severity, thresholds);
  evidence.matched_churn_signals = churnSignals.filter((signal) => signal && threadBody.toLowerCase().includes(signal));
  const requestedLane = severityMatch?.lane || (evidence.matched_churn_signals.length ? chooseChurnLane(lanes) : null);
  if (requestedLane && Object.hasOwn(lanes, requestedLane)) {
    evidence.matched_policy_threshold = severityMatch?.threshold || `churn:${evidence.matched_churn_signals[0]}`;
    evidence.named_target_rail = text(lanes[requestedLane]);
    decision = {
      escalate: true,
      lane: requestedLane,
      reason: severityMatch ? "named_severity_threshold_crossed" : "named_churn_signal_matched",
    };
    stopState = { state: "continue", reason: "Escalation packet is ready for a separate governed dispatcher." };
  } else if (requestedLane) {
    stopState = { state: "needs_human", reason: "Matched policy lane is not declared in escalation_lanes." };
    decision.reason = "undeclared_lane";
  }
}

const caseId = decision.escalate ? stableCaseId(aggregateId, input.idempotency_key) : null;
const escalationPacket = decision.escalate ? {
  type: "runx.support.escalation_packet.v1",
  case_id: caseId,
  aggregate_id: aggregateId,
  lane: decision.lane,
  reason: decision.reason,
  target_rail: evidence.named_target_rail,
  dispatch: "named_only",
  consequence: "A downstream operator issues a separate governed run; this skill performs no post or send.",
} : null;
const caseEvent = decision.escalate ? {
  type: "support.escalation.opened",
  payload: {
    case_id: caseId,
    aggregate_id: aggregateId,
    decision,
    target_rail: evidence.named_target_rail,
    expected_version: number(input.expected_version),
    idempotency_key: text(input.idempotency_key),
  },
} : null;

const escalationDecision = {
  decision,
  case_id: caseId,
  case_event: caseEvent,
  escalation_packet: escalationPacket,
  stop_state: stopState,
  evidence,
};

process.stdout.write(`${JSON.stringify({ escalation_decision: escalationDecision }, null, 2)}\n`);

function strongestSeverityMatch(severity, configured) {
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  const actual = rank[severity] || 0;
  return Object.entries(configured)
    .map(([lane, threshold]) => ({ lane, threshold: text(threshold).toLowerCase(), rank: rank[text(threshold).toLowerCase()] || 99 }))
    .filter((candidate) => actual >= candidate.rank)
    .sort((a, b) => b.rank - a.rank)[0] || null;
}

function chooseChurnLane(configured) {
  if (Object.hasOwn(configured, "priority_support")) return "priority_support";
  return Object.keys(configured)[0] || null;
}

function stableCaseId(aggregateIdValue, key) {
  const digest = crypto.createHash("sha256").update(`${aggregateIdValue}:${text(key)}`).digest("hex").slice(0, 12);
  return `case-${digest}`;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  return {};
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : []; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
