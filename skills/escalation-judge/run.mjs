const inputs = readInputs();

const severityRank = new Map([
  ["none", 0],
  ["info", 1],
  ["low", 2],
  ["medium", 3],
  ["moderate", 3],
  ["high", 4],
  ["critical", 5],
]);

const storeId = stringOrDefault(inputs.store_id, "runx-escalation-cases");
const aggregateId = stringOrDefault(inputs.aggregate_id, "unknown-thread");
const expectedVersion = Number.isFinite(Number(inputs.expected_version))
  ? Number(inputs.expected_version)
  : 0;
const idempotencyKey = stringOrDefault(
  inputs.idempotency_key,
  `escalation:${aggregateId}:${expectedVersion}`,
);
const triage = objectOrEmpty(inputs.triage_packet);
const policy = objectOrNull(inputs.policy_rules);
const threadBody = stringOrDefault(inputs.thread_body, "");
const severity = stringOrDefault(triage.severity, "none").toLowerCase();
const confidence = Number.isFinite(Number(triage.confidence)) ? Number(triage.confidence) : 0;
const projection = normalizeProjection(inputs.prior_projection, expectedVersion);

let judgment;
if (!policy) {
  judgment = stop("refused", ["policy_rules are required before escalation can be judged."], []);
} else if (!policy.escalation_lanes || Object.keys(policy.escalation_lanes).length === 0) {
  judgment = stop("refused", ["policy_rules.escalation_lanes must declare at least one lane."], []);
} else {
  const match = choosePolicyMatch(policy, triage, threadBody, severity);
  if (!match) {
    judgment = stop("no_change", [], []);
  } else if (!policy.escalation_lanes[match.lane]) {
    judgment = stop(
      "refused",
      [`matched lane ${match.lane} is not declared in policy_rules.escalation_lanes.`],
      match.signals,
    );
  } else if (!["slack-notify", "send-as"].includes(match.targetRail)) {
    judgment = stop(
      "needs_human",
      [`lane ${match.lane} declares unsupported target rail ${match.targetRail}.`],
      match.signals,
    );
  } else if (!severityRank.has(severity)) {
    judgment = stop("needs_human", [`severity ${triage.severity} is not recognized by policy rank.`], match.signals);
  } else {
    judgment = escalate(match);
  }
}

process.stdout.write(`${JSON.stringify({
  schema: "runx.escalation.judgment.v1",
  data: {
    escalation_judgment: judgment,
  },
}, null, 2)}\n`);

if (judgment.decision.reason === "refused") {
  process.exit(2);
}

function readInputs() {
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {};
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function normalizeProjection(value, version) {
  const projection = objectOrEmpty(value);
  return {
    version: Number.isFinite(Number(projection.version)) ? Number(projection.version) : version,
    open_case_ids: Array.isArray(projection.open_case_ids) ? projection.open_case_ids : [],
    prior_escalation_count: Number.isFinite(Number(projection.prior_escalation_count))
      ? Number(projection.prior_escalation_count)
      : 0,
  };
}

function choosePolicyMatch(policy, triage, body, normalizedSeverity) {
  const severityMatches = Object.entries(objectOrEmpty(policy.severity_thresholds))
    .filter(([, rule]) => objectOrEmpty(rule).min_severity)
    .map(([name, rule]) => {
      const threshold = String(rule.min_severity).toLowerCase();
      const matched = (severityRank.get(normalizedSeverity) ?? -1) >= (severityRank.get(threshold) ?? Number.POSITIVE_INFINITY);
      return matched
        ? {
            name,
            kind: "severity",
            rank: severityRank.get(threshold) ?? 0,
            threshold,
            lane: rule.lane,
            targetRail: rule.target_rail,
            signals: [
              {
                name: `severity_${normalizedSeverity}`,
                source: "triage_packet",
                excerpt_or_ref: "triage_packet.severity",
              },
            ],
          }
        : null;
    })
    .filter(Boolean);

  const bodyLower = body.toLowerCase();
  const churnMatches = Object.entries(objectOrEmpty(policy.churn_risk_signals))
    .map(([name, rule]) => {
      const keywords = Array.isArray(rule?.keywords) ? rule.keywords : [];
      const matchedKeyword = keywords.find((keyword) => bodyLower.includes(String(keyword).toLowerCase()));
      if (!matchedKeyword) return null;
      return {
        name,
        kind: "churn",
        rank: 3,
        threshold: name,
        lane: rule.lane,
        targetRail: rule.target_rail,
        signals: [
          {
            name,
            source: "thread_body",
            excerpt_or_ref: matchedKeyword,
          },
        ],
      };
    })
    .filter(Boolean);

  const triageSignals = Array.isArray(triage.signals)
    ? triage.signals.map((signal, index) => ({
        name: String(signal),
        source: "triage_packet",
        excerpt_or_ref: `triage_packet.signals[${index}]`,
      }))
    : [];

  const chosen = [...severityMatches, ...churnMatches]
    .sort((a, b) => b.rank - a.rank)
    .at(0);
  if (!chosen) return null;
  return {
    ...chosen,
    signals: [...triageSignals, ...chosen.signals].filter(
      (signal, index, all) => all.findIndex((other) => other.name === signal.name && other.source === signal.source) === index,
    ),
  };
}

function baseDecision(reason, signals) {
  return {
    decision: {
      escalate: false,
      lane: null,
      reason,
      matched_policy: null,
      matched_threshold: null,
    },
    evidence: {
      severity,
      confidence,
      grounded_signals: signals,
    },
    data_store: {
      store_id: storeId,
      aggregate_id: aggregateId,
      read_projection: projection,
      append_event: {
        attempted: false,
        idempotency_key: idempotencyKey,
        expected_version: expectedVersion,
        event_type: null,
        case_id: null,
      },
    },
    case_event: null,
    escalation_packet: null,
    needs_input: [],
    needs_human: [],
  };
}

function stop(reason, needs, signals) {
  const result = baseDecision(reason, signals);
  if (reason === "needs_human") {
    result.needs_human = needs;
  } else {
    result.needs_input = needs;
  }
  return result;
}

function escalate(match) {
  const caseId = `case_${aggregateId}_${String(expectedVersion + 1).padStart(4, "0")}`;
  return {
    decision: {
      escalate: true,
      lane: match.lane,
      reason: "policy_threshold_matched",
      matched_policy: match.name,
      matched_threshold: match.threshold,
    },
    evidence: {
      severity,
      confidence,
      grounded_signals: match.signals,
    },
    data_store: {
      store_id: storeId,
      aggregate_id: aggregateId,
      read_projection: projection,
      append_event: {
        attempted: true,
        idempotency_key: idempotencyKey,
        expected_version: expectedVersion,
        event_type: "escalation.case_opened",
        case_id: caseId,
      },
    },
    case_event: {
      case_id: caseId,
      event_type: "escalation.case_opened",
      aggregate_id: aggregateId,
      payload: {
        classification: stringOrDefault(triage.classification, "unclassified"),
        severity,
        lane: match.lane,
        matched_policy: match.name,
      },
    },
    escalation_packet: {
      packet_type: "runx.escalation.packet.v1",
      case_id: caseId,
      target_rail: match.targetRail,
      lane: match.lane,
      thread_ref: aggregateId,
      summary: `${severity} ${stringOrDefault(triage.classification, "thread")} crossed ${match.name}; downstream driver should run governed ${match.targetRail} for ${match.lane}.`,
    },
    needs_input: [],
    needs_human: [],
  };
}
