const STORE_ID = "runx-escalation-judge-store-v1";
const ADAPTER_REF = "registry:runx/data-store@0.1.2";

function textInput(name) {
  return String(process.env[`RUNX_INPUT_${name}`] ?? "").trim();
}

function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function numberInput(name) {
  const value = Number(process.env[`RUNX_INPUT_${name}`]);
  if (!Number.isFinite(value)) throw new Error(`${name.toLowerCase()} must be a finite number`);
  return value;
}

function requireString(name) {
  const value = textInput(name);
  if (!value) throw new Error(`${name.toLowerCase()} is required`);
  return value;
}

function stop(code, reason, extra = {}) {
  return {
    write: false,
    decision: {
      escalate: false,
      lane: null,
      reason,
    },
    stop: {
      code,
      reason,
      needs_human: code !== "no_change",
      append_emitted: false,
      packet_emitted: false,
      ...extra,
    },
  };
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function severityRank(order, severity) {
  const index = order.map(normalize).indexOf(normalize(severity));
  return index;
}

function policyShape(policyRules) {
  return policyRules && typeof policyRules === "object" &&
    policyRules.severity_thresholds && typeof policyRules.severity_thresholds === "object" &&
    Array.isArray(policyRules.churn_risk_signals) &&
    policyRules.escalation_lanes && typeof policyRules.escalation_lanes === "object";
}

function caseId(aggregateId, idempotencyKey) {
  const cleanThread = aggregateId.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const cleanKey = idempotencyKey.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(-32);
  return `case-${cleanThread}-${cleanKey}`;
}

function readProjection(aggregateId, expectedVersion) {
  return {
    adapter_ref: ADAPTER_REF,
    operation: "read_projection",
    store_id: STORE_ID,
    resource: "support_escalation_cases",
    aggregate_id: aggregateId,
    projection: {
      aggregate_id: aggregateId,
      version: expectedVersion,
      prior_escalations: [],
      already_escalated: false,
    },
  };
}

function decide({ triagePacket, threadBody, policyRules, aggregateId, expectedVersion, idempotencyKey, priorProjection }) {
  if (!policyShape(policyRules)) {
    return stop("missing_policy_rules", "policy_rules must include severity_thresholds, churn_risk_signals, and escalation_lanes", {
      needs_human_lane: "support_escalation.policy_review",
    });
  }

  const severity = normalize(triagePacket?.severity);
  const classification = normalize(triagePacket?.classification);
  const confidence = Number(triagePacket?.confidence);
  if (!severity || !classification || !Number.isFinite(confidence)) {
    return stop("ambiguous_triage_packet", "triage_packet must ground classification, severity, and confidence", {
      needs_human_lane: "support_escalation.human_review",
    });
  }
  const order = Array.isArray(policyRules.severity_order) ? policyRules.severity_order : ["sev4", "sev3", "sev2", "sev1"];
  const severityIndex = severityRank(order, severity);
  if (severityIndex < 0) {
    return stop("unknown_severity", `severity ${severity} is not declared in policy severity_order`, {
      needs_human_lane: "support_escalation.human_review",
    });
  }
  if (priorProjection?.already_escalated === true || (priorProjection?.prior_escalations ?? []).length > 0) {
    return stop("already_escalated", "prior-case projection already contains an escalation for this thread", {
      prior_case_projection: priorProjection,
    });
  }

  const matches = [];
  for (const [lane, threshold] of Object.entries(policyRules.severity_thresholds)) {
    if (!policyRules.escalation_lanes[lane]) {
      return stop("undeclared_escalation_lane", `severity threshold references undeclared lane ${lane}`, {
        requested_lane: lane,
        needs_human_lane: "support_escalation.policy_review",
      });
    }
    const minSeverity = normalize(threshold.minimum_severity);
    const minIndex = severityRank(order, minSeverity);
    if (minIndex < 0) {
      return stop("unknown_policy_threshold", `minimum_severity ${minSeverity} is not declared in severity_order`, {
        needs_human_lane: "support_escalation.policy_review",
      });
    }
    if (severityIndex >= minIndex) {
      matches.push({
        lane,
        kind: "severity_threshold",
        name: threshold.name ?? `${lane}_${minSeverity}_or_higher`,
        matched: `${severity} >= ${minSeverity}`,
      });
    }
  }

  const body = normalize(threadBody);
  const groundedChurnSignals = [];
  for (const signal of policyRules.churn_risk_signals) {
    const lane = signal?.lane;
    if (lane && !policyRules.escalation_lanes[lane]) {
      return stop("undeclared_escalation_lane", `churn signal ${signal.name ?? "unnamed"} references undeclared lane ${lane}`, {
        requested_lane: lane,
        needs_human_lane: "support_escalation.policy_review",
      });
    }
    const phrases = Array.isArray(signal?.phrases) ? signal.phrases : [];
    const matchedPhrase = phrases.find((phrase) => body.includes(normalize(phrase)));
    if (matchedPhrase) {
      groundedChurnSignals.push({
        name: signal.name,
        phrase: matchedPhrase,
        lane,
      });
      matches.push({
        lane,
        kind: "churn_risk_signal",
        name: signal.name,
        matched: `thread_body contains "${matchedPhrase}"`,
      });
    }
  }

  if (matches.length === 0) {
    return stop("no_change", "no named severity threshold or grounded churn-risk signal matched", {
      no_change: true,
    });
  }

  const match = matches[0];
  const laneConfig = policyRules.escalation_lanes[match.lane];
  const id = caseId(aggregateId, idempotencyKey);
  return {
    write: true,
    decision: {
      escalate: true,
      lane: match.lane,
      reason: `${match.kind}:${match.name} matched (${match.matched})`,
    },
    case_id: id,
    matched_threshold: match,
    grounded_churn_signals: groundedChurnSignals,
    target_rail: laneConfig.target_rail,
    driver: laneConfig.driver,
    append_event: {
      adapter_ref: ADAPTER_REF,
      operation: "append_event",
      store_id: STORE_ID,
      resource: "support_escalation_cases",
      aggregate_id: aggregateId,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
      cas: "ungated_compare_and_set",
      status: "committed",
      before_version: expectedVersion,
      after_version: expectedVersion + 1,
      event: {
        type: "support.escalation_case.opened",
        case_id: id,
        lane: match.lane,
        reason: `${match.kind}:${match.name}`,
        matched: match.matched,
        target_rail: laneConfig.target_rail,
        dispatch: "none",
        downstream_driver: laneConfig.driver,
      },
    },
  };
}

function main() {
  const triagePacket = jsonInput("TRIAGE_PACKET", {});
  const threadBody = requireString("THREAD_BODY");
  const policyRules = jsonInput("POLICY_RULES", {});
  const aggregateId = requireString("AGGREGATE_ID");
  const expectedVersion = numberInput("EXPECTED_VERSION");
  const idempotencyKey = requireString("IDEMPOTENCY_KEY");
  const priorProjection = readProjection(aggregateId, expectedVersion).projection;
  const read = readProjection(aggregateId, expectedVersion);
  const verdict = decide({ triagePacket, threadBody, policyRules, aggregateId, expectedVersion, idempotencyKey, priorProjection });
  const output = {
    schema: "runx.escalation_judgment.v1",
    package: "escalation-judge",
    version: "0.1.0",
    aggregate_id: aggregateId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    decision: verdict.decision,
    case_id: verdict.case_id ?? null,
    data_store: {
      read_projection: read,
      append_event: verdict.append_event ?? null,
    },
    matched_policy_threshold: verdict.matched_threshold ?? null,
    severity_cited: triagePacket?.severity ?? null,
    churn_signals_cited: verdict.grounded_churn_signals ?? [],
    escalation_packet: null,
    stop: verdict.stop ?? null,
    no_post_or_send: true,
  };
  if (verdict.write) {
    output.escalation_packet = {
      schema: "runx.escalation_packet.v1",
      decision: output.decision,
      case_id: verdict.case_id,
      aggregate_id: aggregateId,
      lane: verdict.decision.lane,
      reason: verdict.decision.reason,
      target_rail: verdict.target_rail,
      downstream_driver: verdict.driver,
      dispatch_by_name_only: true,
      operator_action_required: `Run governed ${verdict.driver} for ${verdict.target_rail}`,
    };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
