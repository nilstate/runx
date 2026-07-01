import crypto from "node:crypto";

const VERSION = "0.1.0";
const SEVERITIES = ["low", "medium", "high", "critical"];
const CLOSED_STATUSES = new Set(["closed", "resolved", "cancelled", "canceled", "no_change"]);

function loadInputs() {
  const fromJson = safeJson(process.env.RUNX_INPUTS_JSON, {});
  const inputs = { ...fromJson };

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("RUNX_INPUT_") || name === "RUNX_INPUTS_JSON") {
      continue;
    }
    const key = name.slice("RUNX_INPUT_".length).toLowerCase();
    inputs[key] = parseMaybeJson(value);
  }

  return inputs;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return safeJson(trimmed, value);
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }
  return value;
}

function safeJson(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hasObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSeverity(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return SEVERITIES.includes(normalized) ? normalized : null;
}

function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

function normalizePolicyRules(policyRules) {
  if (!hasObject(policyRules)) {
    return null;
  }
  const lanes = hasObject(policyRules.escalation_lanes) ? policyRules.escalation_lanes : {};
  const thresholds = [];
  const rawThresholds = policyRules.severity_thresholds;

  if (Array.isArray(rawThresholds)) {
    for (const entry of rawThresholds) {
      if (!hasObject(entry)) {
        continue;
      }
      const severity = normalizeSeverity(entry.severity ?? entry.min_severity ?? entry.threshold);
      const lane = typeof entry.lane === "string" ? entry.lane : null;
      if (severity && lane) {
        thresholds.push({ severity, lane, reason: entry.reason ?? "severity_threshold_matched" });
      }
    }
  } else if (hasObject(rawThresholds)) {
    for (const [severityKey, threshold] of Object.entries(rawThresholds)) {
      const severity = normalizeSeverity(severityKey);
      if (!severity) {
        continue;
      }
      if (typeof threshold === "string") {
        thresholds.push({ severity, lane: threshold, reason: "severity_threshold_matched" });
      } else if (hasObject(threshold) && typeof threshold.lane === "string") {
        thresholds.push({
          severity,
          lane: threshold.lane,
          reason: typeof threshold.reason === "string" ? threshold.reason : "severity_threshold_matched",
        });
      }
    }
  }

  return {
    severity_thresholds: thresholds,
    churn_risk_signals: Array.isArray(policyRules.churn_risk_signals) ? policyRules.churn_risk_signals : [],
    escalation_lanes: lanes,
  };
}

function findSeverityMatch(policy, severity) {
  const rank = severityRank(severity);
  return policy.severity_thresholds
    .filter((threshold) => rank >= severityRank(threshold.severity))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0] ?? null;
}

function findChurnMatches(policy, threadBody) {
  const body = String(threadBody ?? "").toLowerCase();
  const matches = [];

  for (const entry of policy.churn_risk_signals) {
    if (typeof entry === "string") {
      const signal = entry.toLowerCase();
      if (signal && body.includes(signal)) {
        matches.push({ signal: entry, lane: null, patterns: [entry], matched_pattern: entry });
      }
      continue;
    }

    if (!hasObject(entry)) {
      continue;
    }

    const signal = String(entry.signal ?? entry.name ?? "").trim();
    const patterns = Array.isArray(entry.patterns)
      ? entry.patterns.map((pattern) => String(pattern))
      : signal
        ? [signal]
        : [];
    const matchedPattern = patterns.find((pattern) => pattern && body.includes(pattern.toLowerCase()));

    if (matchedPattern) {
      matches.push({
        signal,
        lane: typeof entry.lane === "string" ? entry.lane : null,
        patterns,
        matched_pattern: matchedPattern,
      });
    }
  }

  return matches;
}

function findActiveCase(projection) {
  if (!hasObject(projection)) {
    return null;
  }

  const directStatus = String(projection.status ?? "").toLowerCase();
  if (projection.open_case_id) {
    return { case_id: String(projection.open_case_id), status: directStatus || "open" };
  }
  if (projection.case_id && !CLOSED_STATUSES.has(directStatus)) {
    return { case_id: String(projection.case_id), status: directStatus || "open" };
  }
  if (hasObject(projection.latest) && projection.latest.case_id) {
    const status = String(projection.latest.status ?? "").toLowerCase();
    if (!CLOSED_STATUSES.has(status)) {
      return { case_id: String(projection.latest.case_id), status: status || "open" };
    }
  }
  if (Array.isArray(projection.active_cases)) {
    const active = projection.active_cases.find((item) => hasObject(item) && item.case_id);
    if (active) {
      return { case_id: String(active.case_id), status: String(active.status ?? "open") };
    }
  }

  return null;
}

function stableId(...parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
  return `case_${digest}`;
}

function baseDecision(inputs, reason, status = "needs_human") {
  return {
    schema: "runx.escalation_judge.decision.v1",
    escalate: false,
    lane: null,
    reason,
    status,
    aggregate_id: String(inputs.aggregate_id ?? ""),
    severity: typeof inputs.triage_packet?.severity === "string" ? inputs.triage_packet.severity : null,
    classification: typeof inputs.triage_packet?.classification === "string" ? inputs.triage_packet.classification : null,
    confidence: typeof inputs.triage_packet?.confidence === "number" ? inputs.triage_packet.confidence : null,
    matched_threshold: null,
    churn_signals: [],
  };
}

function buildResult(inputs) {
  const dataSourceRef = String(inputs.data_source_ref ?? "local://runx-escalation-judge/default");
  const storeId = String(inputs.store_id ?? "escalation-judge-local-v1");
  const resource = String(inputs.resource ?? "escalation_cases");
  const aggregateId = String(inputs.aggregate_id ?? "");
  const expectedVersion = Number(inputs.expected_version ?? 0);
  const idempotencyKey = String(inputs.idempotency_key ?? "");
  const priorProjection = hasObject(inputs.prior_case_projection) ? inputs.prior_case_projection : {};

  const operationBase = {
    skill_ref: "registry:runx/data-store@0.1.2",
    shape: "read_projection -> decide -> append_event",
    data_source_ref: dataSourceRef,
    store_id: storeId,
    resource,
    aggregate_id: aggregateId,
    read_projection: {
      operation: "read_projection",
      resource,
      aggregate_id: aggregateId,
      projection: priorProjection,
    },
    append_event: null,
  };

  const required = [
    ["triage_packet", inputs.triage_packet],
    ["thread_body", inputs.thread_body],
    ["policy_rules", inputs.policy_rules],
    ["aggregate_id", aggregateId],
    ["idempotency_key", idempotencyKey],
  ];
  const missing = required.filter(([, value]) => value === undefined || value === null || value === "").map(([key]) => key);
  if (!Number.isFinite(expectedVersion)) {
    missing.push("expected_version");
  }
  if (missing.length > 0) {
    return finish(inputs, baseDecision(inputs, "missing_required_input", "needs_input"), null, null, operationBase, [
      `missing required input: ${missing.join(", ")}`,
    ]);
  }

  const policy = normalizePolicyRules(inputs.policy_rules);
  if (!policy) {
    return finish(inputs, baseDecision(inputs, "missing_policy_rules"), null, null, operationBase, [
      "refused to escalate because policy_rules were missing or malformed",
    ]);
  }

  const severity = normalizeSeverity(inputs.triage_packet?.severity);
  if (!severity) {
    return finish(inputs, baseDecision(inputs, "unknown_severity"), null, null, operationBase, [
      "refused to invent an unsupported severity level",
    ]);
  }

  const activeCase = findActiveCase(priorProjection);
  if (activeCase) {
    const decision = {
      ...baseDecision(inputs, "already_escalated", "no_change"),
      severity,
      prior_case_id: activeCase.case_id,
    };
    return finish(inputs, decision, null, null, operationBase, [
      `prior-case projection read found active case ${activeCase.case_id}`,
      "no escalation packet emitted",
    ]);
  }

  const severityMatch = findSeverityMatch(policy, severity);
  const churnMatches = findChurnMatches(policy, inputs.thread_body);
  const churnLane = churnMatches.find((match) => match.lane)?.lane ?? null;
  const lane = severityMatch?.lane ?? churnLane;

  if (!lane) {
    const decision = {
      ...baseDecision(inputs, "no_threshold_matched", "no_change"),
      severity,
      churn_signals: churnMatches,
    };
    return finish(inputs, decision, null, null, operationBase, [
      "prior-case projection read",
      "no named severity threshold or churn-risk signal matched",
      "no case opened and no escalation packet emitted",
    ]);
  }

  if (!Object.hasOwn(policy.escalation_lanes, lane)) {
    const decision = {
      ...baseDecision(inputs, "undeclared_lane"),
      severity,
      lane,
      matched_threshold: severityMatch,
      churn_signals: churnMatches,
    };
    return finish(inputs, decision, null, null, operationBase, [
      `refused lane ${lane} because policy_rules.escalation_lanes does not declare it`,
    ]);
  }

  const lanePolicy = policy.escalation_lanes[lane];
  const targetRail = hasObject(lanePolicy) && typeof lanePolicy.target_rail === "string" ? lanePolicy.target_rail : null;
  if (!targetRail) {
    const decision = {
      ...baseDecision(inputs, "missing_target_rail"),
      severity,
      lane,
      matched_threshold: severityMatch,
      churn_signals: churnMatches,
    };
    return finish(inputs, decision, null, null, operationBase, [
      `refused lane ${lane} because it does not name a target_rail`,
    ]);
  }

  const caseId = stableId(aggregateId, idempotencyKey, lane, severity);
  const matchedReason = severityMatch ? "severity_threshold_matched" : "churn_signal_matched";
  const decision = {
    schema: "runx.escalation_judge.decision.v1",
    escalate: true,
    lane,
    reason: matchedReason,
    status: "sealed",
    aggregate_id: aggregateId,
    severity,
    classification: String(inputs.triage_packet.classification ?? ""),
    confidence: Number(inputs.triage_packet.confidence),
    matched_threshold: severityMatch,
    churn_signals: churnMatches,
  };
  const escalationPacket = {
    schema: "runx.escalation.packet.v1",
    package: "escalation-judge",
    version: VERSION,
    aggregate_id: aggregateId,
    case_id: caseId,
    lane,
    reason: matchedReason,
    target_rail: targetRail,
    severity,
    churn_signals: churnMatches,
    downstream_instruction:
      "A downstream governed driver may issue slack-notify or send-as for this named rail; escalation-judge performs no post or send.",
  };
  const caseEvent = {
    type: "escalation.case_opened",
    schema: "runx.escalation.case_event.v1",
    case_id: caseId,
    aggregate_id: aggregateId,
    lane,
    reason: matchedReason,
    target_rail: targetRail,
    severity,
    churn_signals: churnMatches,
    idempotency_key: idempotencyKey,
    expected_version: expectedVersion,
  };

  operationBase.append_event = {
    operation: "append_event",
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    event: caseEvent,
  };

  const observations = [
    "prior-case projection read",
    `matched ${matchedReason} for lane ${lane}`,
    `severity cited: ${severity}`,
    `churn signals cited: ${churnMatches.map((match) => match.signal).filter(Boolean).join(", ") || "none"}`,
    `case_id appended to data-store: ${caseId}`,
    `target rail named: ${targetRail}`,
  ];

  return finish(inputs, decision, caseId, escalationPacket, operationBase, observations, caseEvent);
}

function finish(inputs, decision, caseId, escalationPacket, dataStoreOperation, observations, caseEvent = null) {
  return {
    schema: "runx.escalation_judge.result.v1",
    package: "escalation-judge",
    version: VERSION,
    decision,
    case_id: caseId,
    escalation_packet: escalationPacket,
    case_event: caseEvent,
    data_store_operation: dataStoreOperation,
    needs_input: decision.status === "needs_input" ? decision.reason : null,
    needs_human: decision.status === "needs_human" ? decision.reason : null,
    observations,
    input_summary: {
      aggregate_id: inputs.aggregate_id,
      idempotency_key: inputs.idempotency_key,
      expected_version: inputs.expected_version,
    },
  };
}

const result = buildResult(loadInputs());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
