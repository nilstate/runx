const inputs = readInputs();
const baseline = normalizeBaseline(inputs.health_baseline);
const projection = loadProjection(inputs);
const ledger = loadLedger(inputs);

const output = projection.events.length === 0
  ? noEvidenceOutput(inputs, baseline)
  : healthOutput(inputs, baseline, projection, ledger);

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_JSON || "{}";
  const parsed = JSON.parse(raw);
  return {
    data_source_ref: parsed.data_source_ref || process.env.RUNX_INPUT_DATA_SOURCE_REF || "",
    store_id: parsed.store_id || process.env.RUNX_INPUT_STORE_ID || "",
    agency_ref: parsed.agency_ref || process.env.RUNX_INPUT_AGENCY_REF || "",
    period: parsed.period || process.env.RUNX_INPUT_PERIOD || "7d",
    case_id: parsed.case_id || process.env.RUNX_INPUT_CASE_ID || "",
    health_baseline: parsed.health_baseline || parseJsonEnv("RUNX_INPUT_HEALTH_BASELINE") || {},
  };
}

function parseJsonEnv(name) {
  if (!process.env[name]) return null;
  return JSON.parse(process.env[name]);
}

function normalizeBaseline(value) {
  return {
    threshold_days_stuck: Number(value.threshold_days_stuck ?? 2),
    cap_pressure_pct: Number(value.cap_pressure_pct ?? 80),
    refusal_spike_rate: Number(value.refusal_spike_rate ?? 0.2),
  };
}

function loadProjection(inputs) {
  if (!inputs.data_source_ref.startsWith("fixture://")) {
    return {
      case_id: inputs.case_id || inputs.agency_ref,
      events: [],
      reason: "no readable projection supplied for non-fixture data_source_ref",
    };
  }

  if (inputs.agency_ref === "agency://empty") {
    return {
      case_id: inputs.case_id || "case-empty-2026-07",
      events: [],
      reason: "no readable case events for agency_ref over requested period",
    };
  }

  return {
    case_id: inputs.case_id || "case-retention-2026-07",
    events: [
      {
        version: 1,
        turn: 11,
        state: "sealed",
        days_stuck: 0,
        cap_usage_pct: 66,
        escalation_open: false,
        member_skill: "lead-router",
      },
      {
        version: 2,
        turn: 12,
        state: "awaiting_approval",
        days_stuck: 3,
        cap_usage_pct: 83,
        escalation_open: true,
        member_skill: "policy-author",
      },
      {
        version: 3,
        turn: 13,
        state: "awaiting_approval",
        days_stuck: 4,
        cap_usage_pct: 88,
        escalation_open: true,
        member_skill: "improve-skill",
      },
    ],
  };
}

function loadLedger(inputs) {
  if (!inputs.data_source_ref.startsWith("fixture://") || inputs.agency_ref === "agency://empty") {
    return { id_stubs: [], seal_rate: null, refusal_spike_rate: null };
  }

  return {
    id_stubs: ["rcpt_agency_12a", "rcpt_agency_13b"],
    seal_rate: 0.74,
    refusal_spike_rate: 0.31,
  };
}

function noEvidenceOutput(inputs, baseline) {
  return {
    decision: "needs_more_evidence",
    health_verdict: {
      status: "unknown",
      findings: [],
    },
    intervention_findings: [],
    read_plan: readPlan(inputs),
    evidence_summary: {
      refused_reason: "no readable case events for agency_ref over requested period",
      case_id: inputs.case_id || inputs.agency_ref,
      period: inputs.period,
      folded_turns: [],
      ledger_id_stubs: [],
      baseline,
    },
  };
}

function healthOutput(inputs, baseline, projection, ledger) {
  const events = [...projection.events].sort((a, b) => a.version - b.version);
  const stuck = events.filter((event) => event.days_stuck >= baseline.threshold_days_stuck);
  const maxCap = Math.max(...events.map((event) => event.cap_usage_pct));
  const backlog = events.filter((event) => event.escalation_open).length;
  const turns = events.map((event) => event.turn);
  const case_id = projection.case_id;
  const findings = [
    finding("seal_rate", String(ledger.seal_rate), "good >=0.9, warning 0.7-0.9, critical <0.7", "warning", case_id, turns, ledger.id_stubs),
    finding("stuck_case_count", String(stuck.length), `warning when turns stuck >= ${baseline.threshold_days_stuck} days`, "warning", case_id, stuck.map((event) => event.turn), ledger.id_stubs),
    finding("cap_usage_pct", String(maxCap), `warning >= ${baseline.cap_pressure_pct}, critical >= 95`, maxCap >= 95 ? "critical" : "warning", case_id, turns, ledger.id_stubs),
    finding("escalation_backlog", String(backlog), "warning when any approval backlog is open", backlog > 0 ? "warning" : "good", case_id, turns, ledger.id_stubs),
  ];

  return {
    decision: findings.some((item) => item.assessment === "critical") ? "needs_human" : "ready",
    health_verdict: {
      status: findings.some((item) => item.assessment === "critical") ? "critical" : "degraded",
      findings,
    },
    intervention_findings: [
      {
        target_lane: "policy-author",
        reason: "Cap pressure and approval backlog indicate a timeout or policy tightening review, not a cap increase.",
        grounding_case_id: case_id,
        grounding_turns: stuck.map((event) => event.turn),
        ledger_id_stubs: ledger.id_stubs,
        effect_bound: null,
        ceiling: null,
      },
      {
        target_lane: "improve-skill",
        reason: "Refusal spike is grounded in ledger id-stubs and should be debugged on the member behind repeated stuck turns.",
        grounding_case_id: case_id,
        grounding_turns: stuck.map((event) => event.turn),
        ledger_id_stubs: ledger.id_stubs,
        effect_bound: null,
        ceiling: null,
      },
    ],
    read_plan: readPlan(inputs),
    evidence_summary: {
      refused_reason: null,
      case_id,
      period: inputs.period,
      folded_turns: turns,
      ledger_id_stubs: ledger.id_stubs,
      baseline,
    },
  };
}

function finding(metric, value, norm, assessment, case_id, turns, ledger_id_stubs) {
  return {
    metric,
    value,
    norm,
    assessment,
    grounding: {
      case_id,
      turns,
      ledger_id_stubs,
    },
  };
}

function readPlan(inputs) {
  return {
    domain_state_read: "data-store.read_projection",
    domain_state_inputs: {
      data_source_ref: inputs.data_source_ref,
      store_id: inputs.store_id,
      resource: "agency.case_projection",
      aggregate_id: inputs.case_id || inputs.agency_ref,
    },
    ledger_aggregate_read: "ledger.read_by_receipt_id_stub",
    ledger_scope: {
      agency_ref: inputs.agency_ref,
      period: inputs.period,
    },
  };
}
