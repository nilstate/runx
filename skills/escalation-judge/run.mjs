import fs from "node:fs";
import { createHash } from "node:crypto";

const inputs = readInputs();

try {
  const output = judgeEscalation(inputs);
  emit(output);
} catch (error) {
  emit(needsHuman(error.code ?? "invalid_input", error.message));
  process.exit(2);
}

function judgeEscalation(rawInputs) {
  const triage = objectValue(rawInputs.triage_packet);
  const threadBody = stringInput(rawInputs.thread_body, "thread_body");
  const policy = objectValue(rawInputs.policy_rules);
  const aggregateId = stringInput(rawInputs.aggregate_id, "aggregate_id");
  const expectedVersion = numberInput(rawInputs.expected_version, "expected_version");
  const idempotencyKey = stringInput(rawInputs.idempotency_key, "idempotency_key");
  const priorProjection = normalizeProjection(rawInputs.prior_case_projection, aggregateId, expectedVersion);

  validateTriage(triage);
  validatePolicy(policy);

  const projectionRead = {
    operation: "read_projection",
    store: "registry:runx/data-store@0.1.2",
    store_id: "runx.support.escalation_cases.v1",
    aggregate_id: aggregateId,
    version: priorProjection.version,
    open_case: Boolean(priorProjection.open_case),
  };

  if (priorProjection.open_case) {
    return sealed({
      decision: {
        escalate: false,
        lane: null,
        reason: "already_escalated",
      },
      prior_case_projection: projectionRead,
      stop_state: {
        state: "no_change",
        reason: "prior projection already has an open escalation case",
      },
      observations: baseObservations(triage, [], projectionRead),
    });
  }

  const policyMatch = matchPolicy({ triage, threadBody, policy });
  if (!policyMatch) {
    return sealed({
      decision: {
        escalate: false,
        lane: null,
        reason: "no_change",
      },
      prior_case_projection: projectionRead,
      stop_state: {
        state: "no_change",
        reason: "no severity threshold or churn-risk signal crossed policy",
      },
      observations: baseObservations(triage, [], projectionRead),
    });
  }

  const lane = policy.escalation_lanes[policyMatch.lane];
  if (!lane) {
    throw problem("undeclared_lane", `Matched lane is not declared in policy_rules.escalation_lanes: ${policyMatch.lane}`);
  }
  const caseId = `case_${hashShort(`${aggregateId}:${idempotencyKey}`)}`;
  const afterVersion = expectedVersion + 1;
  const appendEvent = {
    operation: "append_event",
    store: "registry:runx/data-store@0.1.2",
    store_id: "runx.support.escalation_cases.v1",
    aggregate_id: aggregateId,
    idempotency_key: idempotencyKey,
    expected_version: expectedVersion,
    before_version: expectedVersion,
    after_version: afterVersion,
    event: {
      type: "support.escalation_case_opened",
      case_id: caseId,
      lane: policyMatch.lane,
      threshold: policyMatch.threshold,
      evidence: policyMatch.evidence,
    },
    gated: false,
    cas: "expected_version",
  };

  const targetRail = lane.target_rail || policyMatch.target_rail;
  const escalationPacket = {
    schema: "runx.reply.routing.v1",
    type: "runx.support.escalation_packet.v1",
    classification: {
      type: triage.classification,
      severity: triage.severity,
      confidence: triage.confidence,
    },
    send_target: {
      lane: policyMatch.lane,
      target_rail: targetRail,
      target: lane.target,
      bounded: true,
    },
    principal: {
      type: "operator",
      ref: "caller_supplied_principal_required",
    },
    dispatch: {
      named_run: targetRail === "send-as" ? "send-as" : "slack-notify",
      consequence: "separate_governed_run_required",
      this_skill_sends: false,
    },
  };

  return sealed({
    decision: {
      escalate: true,
      lane: policyMatch.lane,
      reason: policyMatch.reason,
    },
    case_id: caseId,
    prior_case_projection: projectionRead,
    append_event: appendEvent,
    escalation_packet: escalationPacket,
    observations: baseObservations(triage, policyMatch.evidence, projectionRead).concat([
      {
        type: "policy_threshold_matched",
        threshold: policyMatch.threshold,
        lane: policyMatch.lane,
        target_rail: targetRail,
      },
      {
        type: "case_append",
        case_id: caseId,
        aggregate_id: aggregateId,
        idempotency_key: idempotencyKey,
        before_version: expectedVersion,
        after_version: afterVersion,
      },
    ]),
  });
}

function sealed(fields) {
  return {
    schema: "runx.support.escalation_judge.v1",
    status: "sealed",
    ...fields,
  };
}

function needsHuman(reasonCode, message) {
  return {
    schema: "runx.support.escalation_judge.v1",
    status: "needs_agent",
    decision: {
      escalate: false,
      lane: null,
      reason: reasonCode,
    },
    stop_state: {
      state: "needs_human",
      reason_code: reasonCode,
      message,
    },
  };
}

function matchPolicy({ triage, threadBody, policy }) {
  const severityRule = objectValue(policy.severity_thresholds)[triage.severity];
  if (severityRule) {
    return {
      threshold: `severity:${triage.severity}`,
      lane: severityRule.lane,
      target_rail: severityRule.target_rail,
      reason: severityRule.reason || `severity ${triage.severity} crossed policy threshold`,
      evidence: [
        {
          source: "triage_packet.severity",
          value: triage.severity,
          citation: `severity ${triage.severity}`,
        },
      ],
    };
  }

  const body = threadBody.toLowerCase();
  const triageSignals = Array.isArray(triage.signals)
    ? triage.signals.map((signal) => String(signal).toLowerCase())
    : [];
  const churnSignals = Array.isArray(policy.churn_risk_signals) ? policy.churn_risk_signals : [];
  const matchedSignal = churnSignals.find((signal) => {
    const normalized = String(signal).toLowerCase();
    return body.includes(normalized) || triageSignals.includes(normalized);
  });
  if (matchedSignal) {
    const laneName = policy.churn_lane || Object.keys(objectValue(policy.escalation_lanes))[0];
    const lane = policy.escalation_lanes[laneName];
    return {
      threshold: `churn_risk:${matchedSignal}`,
      lane: laneName,
      target_rail: lane?.target_rail,
      reason: `churn risk signal matched policy: ${matchedSignal}`,
      evidence: [
        {
          source: body.includes(String(matchedSignal).toLowerCase()) ? "thread_body" : "triage_packet.signals",
          value: matchedSignal,
          citation: `matched churn signal '${matchedSignal}'`,
        },
      ],
    };
  }

  return null;
}

function baseObservations(triage, evidence, projectionRead) {
  return [
    {
      type: "triage_packet",
      classification: triage.classification,
      severity: triage.severity,
      confidence: triage.confidence,
      signals: Array.isArray(triage.signals) ? triage.signals : [],
    },
    {
      type: "evidence",
      items: evidence,
    },
    {
      type: "prior_case_projection_read",
      aggregate_id: projectionRead.aggregate_id,
      version: projectionRead.version,
      open_case: projectionRead.open_case,
    },
  ];
}

function validateTriage(triage) {
  const severity = stringField(triage, "severity");
  const classification = stringField(triage, "classification");
  if (!classification) throw problem("missing_classification", "triage_packet.classification is required.");
  if (!severity) throw problem("missing_severity", "triage_packet.severity is required.");
  if (typeof triage.confidence !== "number") {
    throw problem("missing_confidence", "triage_packet.confidence must be a number.");
  }
  if (triage.confidence < 0.5) {
    throw problem("ambiguous_confidence", "triage_packet.confidence is too low for deterministic escalation.");
  }
}

function validatePolicy(policy) {
  if (!policy || Object.keys(policy).length === 0) {
    throw problem("missing_policy_rules", "policy_rules is required.");
  }
  if (!policy.severity_thresholds || typeof policy.severity_thresholds !== "object") {
    throw problem("missing_severity_thresholds", "policy_rules.severity_thresholds is required.");
  }
  if (!policy.escalation_lanes || typeof policy.escalation_lanes !== "object") {
    throw problem("missing_escalation_lanes", "policy_rules.escalation_lanes is required.");
  }
  for (const [severity, rule] of Object.entries(policy.severity_thresholds)) {
    const lane = objectValue(rule).lane;
    if (!lane || !policy.escalation_lanes[lane]) {
      throw problem("undeclared_lane", `severity threshold ${severity} points to undeclared lane ${lane}`);
    }
  }
}

function normalizeProjection(raw, aggregateId, expectedVersion) {
  const projection = objectValue(raw);
  if (projection.aggregate_id && projection.aggregate_id !== aggregateId) {
    throw problem("projection_aggregate_mismatch", "prior_case_projection aggregate_id does not match input aggregate_id.");
  }
  const version = typeof projection.version === "number" ? projection.version : expectedVersion;
  if (version !== expectedVersion) {
    throw problem("expected_version_mismatch", "expected_version must match the prior-case projection version.");
  }
  return {
    aggregate_id: aggregateId,
    version,
    open_case: Boolean(projection.open_case),
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
    triage_packet: parseMaybeJson(process.env.RUNX_INPUT_TRIAGE_PACKET),
    thread_body: parseMaybeJson(process.env.RUNX_INPUT_THREAD_BODY),
    policy_rules: parseMaybeJson(process.env.RUNX_INPUT_POLICY_RULES),
    aggregate_id: parseMaybeJson(process.env.RUNX_INPUT_AGGREGATE_ID),
    expected_version: parseMaybeJson(process.env.RUNX_INPUT_EXPECTED_VERSION),
    idempotency_key: parseMaybeJson(process.env.RUNX_INPUT_IDEMPOTENCY_KEY),
    prior_case_projection: parseMaybeJson(process.env.RUNX_INPUT_PRIOR_CASE_PROJECTION),
  };
}

function parseMaybeJson(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringField(object, key) {
  const value = objectValue(object)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringInput(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw problem(`missing_${name}`, `${name} is required.`);
  }
  return value.trim();
}

function numberInput(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw problem(`missing_${name}`, `${name} must be a finite number.`);
  }
  return value;
}

function hashShort(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
