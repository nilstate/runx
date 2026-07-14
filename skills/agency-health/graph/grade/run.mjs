import fs from "node:fs";

const inputs = readInputs();
const agencyRef = requiredString(inputs.agency_ref, "agency_ref");
const caseId = requiredString(inputs.case_id, "case_id");
const projection = objectValue(inputs.projection);
const events = Array.isArray(inputs.events) ? inputs.events : [];
const ledger = objectValue(inputs.ledger);
const caseLedger = objectValue(inputs.case_ledger);
const period = objectValue(inputs.period);

const integrityReasons = validateIntegrity({ projection, events, caseId });
if (events.length === 0) {
  emit(nonReady(caseId, "No readable case events exist for the resolved agency case over the requested period."));
}
if (integrityReasons.length > 0) {
  emit(nonReady(caseId, integrityReasons.join(" ")));
}

const state = foldEvents(events);
if (!state.opened) {
  emit(nonReady(caseId, "The readable stream has no opened event, so no agency charter snapshot can be grounded."));
}
if (state.agency_ref !== agencyRef) {
  emit(nonReady(caseId, `The opened event belongs to ${state.agency_ref || "an unknown agency"}, not ${agencyRef}.`));
}

const suppliedBaseline = objectValue(inputs.health_baseline);
const charterBaseline = objectValue(state.limits.health_baseline);
const baseline = { ...charterBaseline, ...suppliedBaseline };
const refusedReasons = [];
const findings = [];
const actualLedgerStubs = normalizeLedgerStubs(ledger.matched_receipts);
const caseLedgerStubs = normalizeLedgerStubs(caseLedger.matched_receipts);
const caseReceiptIds = new Set(state.receipt_ids.map(normalizeReceiptIdentity));
const actualCaseLedgerStubs = actualLedgerStubs.filter((stub) => caseReceiptIds.has(normalizeReceiptIdentity(stub.receipt_id)));
const ledgerStubs = actualCaseLedgerStubs.length > 0 ? actualCaseLedgerStubs : caseLedgerStubs;
const ledgerSource = actualCaseLedgerStubs.length > 0 ? "actual-ledger-read" : caseLedgerStubs.length > 0 ? "case-referenced-ledger-read" : "none";
const turnRefs = state.turn_numbers.map((turn) => `agency_cases:${caseId}:turn:${turn}`);

gradeSealRate();
gradeStuckCases();
gradeCapUsage();
gradeEscalationBacklog();

const critical = findings.some((finding) => finding.severity === "critical");
const concerning = findings.some((finding) => finding.assessment !== "within_norm");
const decision = critical ? "needs_human" : refusedReasons.length > 0 ? "needs_more_evidence" : "ready";
const status = critical ? "critical" : concerning ? "degraded" : findings.length > 0 ? "healthy" : "unknown";
const interventions = decision === "needs_more_evidence"
  ? []
  : buildInterventions({ findings, caseId, turnNumbers: state.turn_numbers, ledgerStubs, critical });

emit({
  schema: "runx.agency_health.v1",
  decision,
  health_verdict: {
    status,
    findings,
  },
  intervention_findings: interventions,
  evidence: {
    folded_case_id: caseId,
    projection_version: numberValue(projection.version),
    turn_numbers: state.turn_numbers,
    turn_refs: turnRefs,
    ledger_id_stubs: ledgerStubs.map((stub) => stub.receipt_id),
    ledger_source: ledgerSource,
    refused_reasons: refusedReasons,
  },
});

function gradeSealRate() {
  const refusalThreshold = finiteNumber(baseline.refusal_spike_rate);
  if (refusalThreshold === null) {
    refusedReasons.push("seal_rate was not graded because refusal_spike_rate is absent from the charter snapshot and supplied baseline.");
    return;
  }
  if (ledgerStubs.length === 0) {
    refusedReasons.push("seal_rate was not graded because ledger.read returned no grounded receipt id-stubs.");
    return;
  }
  const relevant = ledgerStubs.filter((stub) => stub.status === "sealed" || stub.status === "refused");
  if (relevant.length === 0) {
    refusedReasons.push("seal_rate was not graded because no ledger id-stub had sealed or refused status.");
    return;
  }
  const sealed = relevant.filter((stub) => stub.status === "sealed").length;
  const rate = round(sealed / relevant.length, 4);
  const minimum = round(1 - refusalThreshold, 4);
  const breached = rate < minimum;
  findings.push(finding({
    metric: "seal_rate",
    value: rate,
    norm: `seal_rate >= ${minimum} (1 - refusal_spike_rate ${refusalThreshold})`,
    assessment: breached ? "breached" : "within_norm",
    severity: breached ? "warning" : "info",
    evidenceRefs: relevant.map((stub) => `ledger:${stub.receipt_id}`),
  }));
}

function gradeStuckCases() {
  const threshold = finiteNumber(baseline.threshold_days_stuck);
  const to = isoMillis(period.to);
  const lastProgress = isoMillis(state.last_progress_at);
  if (threshold === null) {
    refusedReasons.push("stuck_case_count was not graded because threshold_days_stuck is absent from the charter snapshot and supplied baseline.");
    return;
  }
  if (to === null || lastProgress === null) {
    refusedReasons.push("stuck_case_count was not graded because period.to or a grounded progress timestamp is unavailable.");
    return;
  }
  const days = Math.max(0, (to - lastProgress) / 86_400_000);
  const count = state.closed ? 0 : days >= threshold ? 1 : 0;
  const critical = count === 1 && days >= threshold * 2;
  findings.push(finding({
    metric: "stuck_case_count",
    value: count,
    norm: `0 cases without grounded progress for ${threshold} days`,
    assessment: count === 0 ? "within_norm" : critical ? "breached" : "concerning",
    severity: count === 0 ? "info" : critical ? "critical" : "warning",
    evidenceRefs: state.last_turn === null
      ? [`agency_cases:${caseId}:opened`]
      : [`agency_cases:${caseId}:turn:${state.last_turn}`],
  }));
}

function gradeCapUsage() {
  const threshold = finiteNumber(baseline.cap_pressure_pct);
  if (threshold === null) {
    refusedReasons.push("cap_usage_pct was not graded because cap_pressure_pct is absent from the charter snapshot and supplied baseline.");
    return;
  }
  const ratios = [];
  const maxTurns = positiveNumber(state.limits.max_turns);
  if (maxTurns !== null) ratios.push((state.acts / maxTurns) * 100);
  const spendCap = positiveNumber(state.limits.spend?.max_per_run?.amount);
  if (spendCap !== null) ratios.push((state.spend_amount / spendCap) * 100);
  if (ratios.length === 0) {
    refusedReasons.push("cap_usage_pct was not graded because the opened charter snapshot contains no readable turn or spend cap.");
    return;
  }
  const value = round(Math.max(...ratios), 2);
  const critical = value >= 100;
  const concerning = value >= threshold;
  findings.push(finding({
    metric: "cap_usage_pct",
    value,
    norm: `cap_usage_pct < ${threshold} until the declared cap is exhausted`,
    assessment: critical ? "breached" : concerning ? "concerning" : "within_norm",
    severity: critical ? "critical" : concerning ? "warning" : "info",
    evidenceRefs: [`agency_cases:${caseId}:opened`, ...state.turn_numbers.map((turn) => `agency_cases:${caseId}:turn:${turn}`)],
  }));
}

function gradeEscalationBacklog() {
  const value = state.pending_escalations.length;
  findings.push(finding({
    metric: "escalation_backlog",
    value,
    norm: "0 unresolved agency escalation events",
    assessment: value > 0 ? "concerning" : "within_norm",
    severity: value > 0 ? "warning" : "info",
    evidenceRefs: value > 0
      ? state.pending_escalations.map((turn) => `agency_cases:${caseId}:turn:${turn}`)
      : [`agency_cases:${caseId}:projection:${projection.version ?? events.length}`],
  }));
}

function validateIntegrity({ projection, events, caseId }) {
  const reasons = [];
  const version = numberValue(projection.version);
  const count = numberValue(projection.event_count);
  if (projection.aggregate_id && projection.aggregate_id !== caseId) {
    reasons.push("Projection aggregate_id does not match the resolved case_id.");
  }
  if (version !== null && version !== events.length) {
    reasons.push(`Projection version ${version} does not match ${events.length} readable events.`);
  }
  if (count !== null && count !== events.length) {
    reasons.push(`Projection event_count ${count} does not match ${events.length} readable events.`);
  }
  const digests = Array.isArray(projection.event_digests) ? projection.event_digests : [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (numberValue(event?.version) !== index + 1) {
      reasons.push(`Event order is not contiguous at index ${index}.`);
      break;
    }
    if (digests.length > 0 && event?.event_digest !== digests[index]) {
      reasons.push(`Event digest does not match projection order at version ${index + 1}.`);
      break;
    }
  }
  return reasons;
}

function foldEvents(entries) {
  const state = {
    opened: false,
    agency_ref: "",
    limits: {},
    turn_numbers: [],
    last_turn: null,
    last_progress_at: null,
    acts: 0,
    spend_amount: 0,
    pending_escalations: [],
    receipt_ids: [],
    closed: false,
  };
  for (const entry of entries) {
    const event = objectValue(entry?.event);
    const payload = objectValue(event.payload);
    const committedAt = optionalString(entry?.committed_at);
    if (event.type === "opened") {
      state.opened = true;
      state.agency_ref = optionalString(payload.agency_ref) ?? "";
      state.limits = objectValue(payload.limits);
      state.last_progress_at = committedAt;
      continue;
    }
    if (event.type === "turn") {
      const turn = numberValue(payload.turn);
      if (turn !== null) {
        state.turn_numbers.push(turn);
        state.last_turn = turn;
      }
      const result = objectValue(payload.member_result);
      if (Object.keys(result).length > 0) {
        state.acts += 1;
        const receiptId = optionalString(result.receipt_id) ?? optionalString(result.receipt_ref);
        if (receiptId) state.receipt_ids.push(receiptId);
        const spend = finiteNumber(result.spend?.amount);
        if (spend !== null) state.spend_amount += spend;
        const outcome = (optionalString(result.status) ?? optionalString(result.outcome) ?? "").toLowerCase();
        const resultAt = optionalString(result.created_at) ?? committedAt;
        if (!["refused", "blocked", "no_progress", "failed"].includes(outcome) && resultAt) {
          state.last_progress_at = resultAt;
        }
      }
      if (payload.decision === "escalate") {
        if (turn !== null) state.pending_escalations.push(turn);
      } else if (payload.decision === "done" || payload.decision === "failed") {
        state.closed = true;
        state.pending_escalations = [];
      }
      continue;
    }
    if (event.type === "approved" || event.type === "denied") {
      state.pending_escalations.shift();
      if (committedAt) state.last_progress_at = committedAt;
    }
  }
  return state;
}

function buildInterventions({ findings, caseId, turnNumbers, ledgerStubs, critical }) {
  const ledgerIds = ledgerStubs.map((stub) => stub.receipt_id);
  if (critical) {
    return [{
      target_lane: "human-ops",
      severity: "critical",
      reason: "A critical grounded finding requires human review; any cap or authority widening is outside this read-only lane.",
      grounding: { case_id: caseId, turns: turnNumbers, ledger_id_stubs: ledgerIds },
    }];
  }
  const interventions = [];
  const byMetric = new Map(findings.map((entry) => [entry.metric, entry]));
  if (["concerning", "breached"].includes(byMetric.get("cap_usage_pct")?.assessment)
      || ["concerning", "breached"].includes(byMetric.get("escalation_backlog")?.assessment)) {
    interventions.push({
      target_lane: "policy-author",
      severity: "warning",
      reason: "Review a narrower policy or approval timeout; do not widen the declared cap or authority.",
      grounding: { case_id: caseId, turns: turnNumbers, ledger_id_stubs: [] },
    });
  }
  if (["concerning", "breached"].includes(byMetric.get("stuck_case_count")?.assessment)
      || ["concerning", "breached"].includes(byMetric.get("seal_rate")?.assessment)) {
    interventions.push({
      target_lane: "improve-skill",
      severity: "warning",
      reason: "Inspect the member or skill behind the grounded stall or refusal pattern in a separate governed run.",
      grounding: { case_id: caseId, turns: turnNumbers, ledger_id_stubs: ledgerIds },
    });
  }
  return interventions;
}

function finding({ metric, value, norm, assessment, severity, evidenceRefs }) {
  return { metric, value, norm, assessment, severity, evidence_refs: evidenceRefs };
}

function normalizeLedgerStubs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => ({
    receipt_id: optionalString(row?.receipt_id) ?? "",
    skill_ref: optionalString(row?.skill_ref) ?? "",
    status: normalizeLedgerStatus(row?.status),
    created_at: optionalString(row?.created_at) ?? "",
  })).filter((row) => row.receipt_id.length > 0);
}

function normalizeLedgerStatus(value) {
  const status = (optionalString(value) ?? "").toLowerCase();
  return status === "closed" ? "sealed" : status;
}

function normalizeReceiptIdentity(value) {
  return (optionalString(value) ?? "").replace(/^runx:receipt:/, "");
}

function nonReady(caseId, reason) {
  return {
    schema: "runx.agency_health.v1",
    decision: "needs_more_evidence",
    health_verdict: { status: "unknown", findings: [] },
    intervention_findings: [],
    evidence: {
      folded_case_id: caseId,
      projection_version: null,
      turn_numbers: [],
      turn_refs: [],
      ledger_id_stubs: [],
      ledger_source: "none",
      refused_reasons: [reason],
    },
  };
}

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
}

function requiredString(value, field) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numberValue(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function isoMillis(value) {
  const text = optionalString(value);
  if (!text || Number.isNaN(Date.parse(text))) return null;
  return Date.parse(text);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
