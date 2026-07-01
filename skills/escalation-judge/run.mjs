import crypto from "node:crypto";
import fs from "node:fs";

const severityRank = new Map([
  ["low", 1],
  ["medium", 2],
  ["high", 3],
  ["critical", 4],
]);

const inputs = readInputs();
const triagePacket = objectValue(inputs.triage_packet, "triage_packet");
const threadBody = stringValue(inputs.thread_body);
const policyRules = maybeObject(inputs.policy_rules);
const aggregateId = stringValue(inputs.aggregate_id);
const expectedVersion = numberValue(inputs.expected_version);
const idempotencyKey = stringValue(inputs.idempotency_key);
const priorCase = maybeObject(inputs.prior_case);

if (!threadBody) fail("thread_body is required");
if (!aggregateId) fail("aggregate_id is required");
if (expectedVersion === undefined) fail("expected_version is required");
if (!idempotencyKey) fail("idempotency_key is required");

const classification = stringValue(triagePacket.classification);
const severity = normalizeSeverity(triagePacket.severity);
const confidence = numberValue(triagePacket.confidence);
const normalizedThread = normalize(threadBody);
const harnessCaseNames = [
  "high-severity-churn-opens-priority-case",
  "low-confidence-howto-stops-no-change",
  "missing-policy-needs-input",
  "undeclared-lane-needs-human",
];
const priorProjection = summarizeProjection(priorCase);

const stopReasons = [];
if (!classification) stopReasons.push("triage_packet.classification is missing");
if (!severity) stopReasons.push("triage_packet.severity is missing or not one of low, medium, high, critical");
if (confidence === undefined) stopReasons.push("triage_packet.confidence is missing");
if (!policyRules) stopReasons.push("policy_rules is required before escalation");

let laneMap = {};
let severityThresholds = [];
let churnRules = [];
if (policyRules) {
  laneMap = objectEntries(policyRules.escalation_lanes);
  severityThresholds = arrayValue(policyRules.severity_thresholds);
  churnRules = arrayValue(policyRules.churn_risk_signals);
  if (Object.keys(laneMap).length === 0) stopReasons.push("policy_rules.escalation_lanes is empty");
  if (severityThresholds.length === 0 && churnRules.length === 0) {
    stopReasons.push("policy_rules has no severity thresholds or churn risk signals");
  }
}

if (priorProjection.version > 0 || priorProjection.event_count > 0) {
  stopReasons.push(`prior escalation projection already exists for ${aggregateId}`);
}

const thresholdMatches = stopReasons.length === 0
  ? matchSeverityThresholds({ severityThresholds, classification, severity, laneMap })
  : [];
const churnMatches = stopReasons.length === 0
  ? matchChurnSignals({ churnRules, normalizedThread, laneMap })
  : [];
const undeclaredCandidates = [...thresholdMatches, ...churnMatches].filter((match) => !match.lane_declared);
if (undeclaredCandidates.length > 0) {
  stopReasons.push(`policy matched undeclared lane ${undeclaredCandidates[0].lane}`);
}

const declaredMatches = [...thresholdMatches, ...churnMatches].filter((match) => match.lane_declared);
const selected = stopReasons.length === 0 ? chooseMatch(declaredMatches) : null;
const shouldEscalate = Boolean(selected);
const stopStatus = stopReasons.length > 0
  ? stopStatusFor(stopReasons)
  : "no_change";
const stopReason = stopReasons.length > 0
  ? stopReasons.join("; ")
  : "no_change: severity and churn signals do not meet any named policy threshold";
const caseId = shouldEscalate ? `case_${sha256(`${aggregateId}:${idempotencyKey}`).slice(0, 16)}` : null;
const lanePolicy = shouldEscalate ? laneMap[selected.lane] : null;
const targetRail = shouldEscalate ? stringValue(lanePolicy.target_rail) : null;
const decision = shouldEscalate
  ? {
      escalate: true,
      lane: selected.lane,
      reason: `${selected.kind} matched ${selected.name}; route to ${selected.lane} via ${targetRail}.`,
    }
  : {
      escalate: false,
      lane: null,
      reason: stopReason,
    };

const observations = {
  escalation_decision: decision.escalate,
  escalation_lane: decision.lane,
  named_policy_threshold_matched: shouldEscalate ? selected.name : null,
  severity: severity ?? stringValue(triagePacket.severity),
  severity_thresholds_cited: thresholdMatches.map((match) => ({
    name: match.name,
    lane: match.lane,
    lane_declared: match.lane_declared,
    evidence: match.evidence,
  })),
  churn_signals_cited: churnMatches.map((match) => ({
    name: match.name,
    terms: match.terms,
    lane: match.lane,
    lane_declared: match.lane_declared,
  })),
  prior_case_projection_read: true,
  prior_case_projection: priorProjection,
  case_id_appended: caseId,
  refused_or_stop_reason: shouldEscalate ? null : stopReason,
  stop_state: shouldEscalate ? null : stopStatus,
  named_target_rail: targetRail,
  target_rail_effect: "none",
  aggregate_id: aggregateId,
  expected_version: expectedVersion,
  idempotency_key: idempotencyKey,
  harness_case_names: harnessCaseNames,
  receipt_id: "assigned by runx receipt after execution",
};

const result = {
  decision,
  observations,
};

if (shouldEscalate) {
  const escalationPacket = {
    schema: "runx.support.escalation_judge.v1",
    case_id: caseId,
    aggregate_id: aggregateId,
    lane: selected.lane,
    target_rail: targetRail,
    target_rail_kind: stringValue(lanePolicy.consequence) ?? "internal_lane",
    dispatch_by_name_only: true,
    rail_effect: "none",
    matched_policy: {
      kind: selected.kind,
      name: selected.name,
      evidence: selected.evidence,
    },
    triage: {
      classification,
      severity,
      confidence,
    },
  };
  const caseEvent = {
    type: "support_case.escalation_opened",
    payload: {
      packet: "runx.support.escalation_judge.v1",
      case_id: caseId,
      aggregate_id: aggregateId,
      decision,
      escalation_packet: escalationPacket,
      triage: {
        classification,
        severity,
        confidence,
      },
      policy_match: {
        kind: selected.kind,
        name: selected.name,
        lane: selected.lane,
        target_rail: targetRail,
        evidence: selected.evidence,
      },
      prior_case_projection: priorProjection,
      data_store: {
        aggregate_id: aggregateId,
        expected_version: expectedVersion,
        idempotency_key: idempotencyKey,
      },
    },
  };
  result.case_id = caseId;
  result.escalation_packet = escalationPacket;
  result.case_event = caseEvent;
} else {
  result.stop_state = {
    status: stopStatus,
    reason: stopReason,
    no_case_opened: true,
    no_escalation_packet_emitted: true,
  };
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function matchSeverityThresholds({ severityThresholds, classification, severity, laneMap }) {
  const rank = severityRank.get(severity);
  return severityThresholds
    .map((rule) => {
      const name = stringValue(rule.name) ?? "unnamed_severity_threshold";
      const lane = stringValue(rule.lane);
      const minSeverity = normalizeSeverity(rule.min_severity);
      const allowedClassifications = uniqueStrings(rule.classifications);
      if (!lane || !minSeverity || rank < severityRank.get(minSeverity)) return null;
      if (allowedClassifications.length > 0 && !allowedClassifications.includes(classification)) return null;
      return {
        kind: "severity_threshold",
        name,
        lane,
        lane_declared: Boolean(laneMap[lane]),
        rank: severityRank.get(minSeverity),
        evidence: {
          classification,
          observed_severity: severity,
          min_severity: minSeverity,
        },
      };
    })
    .filter(Boolean);
}

function matchChurnSignals({ churnRules, normalizedThread, laneMap }) {
  return churnRules
    .map((rule) => {
      const terms = uniqueStrings(rule.terms).filter((term) => normalizedThread.includes(normalize(term)));
      if (terms.length === 0) return null;
      const lane = stringValue(rule.lane);
      if (!lane) return null;
      return {
        kind: "churn_risk_signal",
        name: stringValue(rule.name) ?? terms[0],
        lane,
        lane_declared: Boolean(laneMap[lane]),
        rank: 5,
        terms,
        evidence: {
          matched_terms: terms,
        },
      };
    })
    .filter(Boolean);
}

function chooseMatch(matches) {
  if (matches.length === 0) return null;
  return [...matches].sort((left, right) => {
    if (right.rank !== left.rank) return right.rank - left.rank;
    return left.name.localeCompare(right.name);
  })[0];
}

function stopStatusFor(reasons) {
  if (reasons.some((reason) => reason.includes("policy_rules") || reason.includes("missing"))) return "needs_input";
  return "needs_human";
}

function summarizeProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      seen: false,
      version: 0,
      event_count: 0,
      last_event_type: null,
    };
  }
  return {
    seen: true,
    version: numberValue(value.version) ?? 0,
    event_count: numberValue(value.event_count) ?? 0,
    last_event_type: stringValue(value.last_event_type),
    last_event_ref: stringValue(value.last_event_ref),
  };
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    triage_packet: parseInputValue(process.env.RUNX_INPUT_TRIAGE_PACKET),
    thread_body: parseInputValue(process.env.RUNX_INPUT_THREAD_BODY),
    policy_rules: parseInputValue(process.env.RUNX_INPUT_POLICY_RULES),
    aggregate_id: parseInputValue(process.env.RUNX_INPUT_AGGREGATE_ID),
    expected_version: parseInputValue(process.env.RUNX_INPUT_EXPECTED_VERSION),
    idempotency_key: parseInputValue(process.env.RUNX_INPUT_IDEMPOTENCY_KEY),
    prior_case: parseInputValue(process.env.RUNX_INPUT_PRIOR_CASE),
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

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function maybeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function objectEntries(value) {
  return maybeObject(value) ?? {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function normalizeSeverity(value) {
  const candidate = stringValue(value)?.toLowerCase();
  return severityRank.has(candidate) ? candidate : null;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
