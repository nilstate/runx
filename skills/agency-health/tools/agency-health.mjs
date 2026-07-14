// agency-health runner: read-only health bundle assembler (self-contained).
// Composes the data-store read over the agency case, grades folded signals
// against declared norms, and seals a health_verdict. Reads C7 ledger
// aggregates by receipt id-stub only. Appends nothing, sends nothing,
// executes nothing. Deterministic cli-tool (no model calls, no sibling
// file dependencies — safe for the published-harness temp sandbox).
//
// Fixtures are embedded so the hosted publish harness (which copies only
// SKILL.md + X.yaml) can run the cli-tool without a tools/ directory.

const DEFAULT_NORMS = {
  stall_window_turns: 5,
  awaiting_approval_cap: 3,
  spend_cap_pct: 90,
  act_cap_pct: 90,
  refusal_spike_threshold: 0.2,
  seal_rate_floor: 0.8,
};

// Seeded data-store fixture (data.local adapter shape). In production this is
// read from the registry-pinned data-store read_projection over the agency case.
const FIXTURES = {
  "health-dev": {
    streams: {
      "case-healthy-001": {
        events: [
          { version: 1, turn_id: "t1", status: "advanced", acts: 2, spend: 10 },
          { version: 2, turn_id: "t2", status: "advanced", acts: 1, spend: 5 },
          { version: 3, turn_id: "t3", status: "advanced", acts: 3, spend: 12 },
          { version: 4, turn_id: "t4", status: "resolved", acts: 0, spend: 0 },
        ],
      },
      "case-stalled-002": {
        events: [
          { version: 1, turn_id: "s1", status: "advanced", acts: 1, spend: 4 },
          { version: 2, turn_id: "s2", status: "awaiting_approval", acts: 0, spend: 0, stalled_turns: 7 },
          { version: 3, turn_id: "s3", status: "advanced", acts: 2, spend: 8, stalled_turns: 7 },
          { version: 4, turn_id: "s4", status: "needs_input", acts: 0, spend: 0, stalled_turns: 7 },
        ],
      },
    },
  },
};

function loadEvents(inputs) {
  const store = FIXTURES[inputs.store_id || "health-dev"];
  if (!store) return [];
  const stream = (store.streams || {})[inputs.case_id] || { events: [] };
  const events = Array.isArray(stream) ? stream : (stream.events || []);
  return events.slice(-(inputs.limit || 500));
}

function foldProjection(events) {
  const sorted = [...events].sort((a, b) => (a.version || 0) - (b.version || 0));
  const histogram = { advanced: 0, awaiting_approval: 0, resolved: 0, failed: 0, needs_input: 0 };
  let cumulativeActs = 0;
  let cumulativeSpend = 0;
  const stalled = [];
  let approvalParked = 0;
  for (const e of sorted) {
    const st = e.status || (e.turn && e.turn.status) || "advanced";
    if (st in histogram) histogram[st] += 1;
    if (st === "awaiting_approval") approvalParked += 1;
    cumulativeActs += e.acts || 0;
    cumulativeSpend += e.spend || 0;
    if (st !== "resolved" && st !== "failed" && (e.stalled_turns || 0) > DEFAULT_NORMS.stall_window_turns) {
      stalled.push(e.turn_id || e.id);
    }
  }
  return {
    turns_total: sorted.length,
    status_histogram: histogram,
    cumulative_acts: cumulativeActs,
    cumulative_spend: cumulativeSpend,
    stalled_turns: stalled,
    approval_parked: approvalParked,
  };
}

// C7 ledger read: id-stubs only. Never re-reads domain state from the ledger.
function readLedgerStubs(ledgerQuery) {
  const stubs = (ledgerQuery && ledgerQuery.receipt_stubs) || [];
  const sealRate = (ledgerQuery && ledgerQuery.seal_rate) != null ? ledgerQuery.seal_rate : 1;
  const refusalRate = (ledgerQuery && ledgerQuery.refusal_rate) != null ? ledgerQuery.refusal_rate : 0;
  return { seal_rate: sealRate, refusal_rate: refusalRate, receipt_stubs: stubs };
}

// Each finding ties a folded metric to a named norm. Each intervention_finding
// names a target lane and its grounding case_id/turn or ledger id-stub
// (handoff seam: dispatch-by-naming, no effect bound).
function grade(folded, ledger, norms, inputs) {
  const findings = [];
  const intervention_findings = [];
  const caseId = inputs.case_id;

  if (folded.stalled_turns.length > 0) {
    findings.push({ metric: "stalled_turns", norm: `<= ${norms.stall_window_turns} turns stalled`, observed: folded.stalled_turns.length, assessment: "stalled" });
    intervention_findings.push({
      target_lane: "human",
      reason: `turns stalled beyond ${norms.stall_window_turns}-turn window: ${folded.stalled_turns.join(", ")}`,
      grounding: { case_id: caseId, turns: folded.stalled_turns },
    });
  }
  if (folded.approval_parked > norms.awaiting_approval_cap) {
    findings.push({ metric: "awaiting_approval_parked", norm: `<= ${norms.awaiting_approval_cap}`, observed: folded.approval_parked, assessment: "over_cap" });
    intervention_findings.push({
      target_lane: "policy-author",
      reason: `parked approvals ${folded.approval_parked} exceed cap ${norms.awaiting_approval_cap}`,
      grounding: { case_id: caseId },
    });
  }
  if (ledger.refusal_rate > norms.refusal_spike_threshold) {
    findings.push({ metric: "refusal_rate", norm: `<= ${norms.refusal_spike_threshold}`, observed: ledger.refusal_rate, assessment: "spike" });
    intervention_findings.push({
      target_lane: "improve-skill",
      reason: `refusal_rate ${ledger.refusal_rate} above threshold ${norms.refusal_spike_threshold}`,
      grounding: { ledger_id_stub: ledger.receipt_stubs[0] || null },
    });
  }
  if (ledger.seal_rate < norms.seal_rate_floor) {
    findings.push({ metric: "seal_rate", norm: `>= ${norms.seal_rate_floor}`, observed: ledger.seal_rate, assessment: "below_floor" });
    intervention_findings.push({
      target_lane: "ops-desk",
      reason: `seal_rate ${ledger.seal_rate} below floor ${norms.seal_rate_floor}`,
      grounding: { ledger_id_stub: ledger.receipt_stubs[0] || null },
    });
  }

  const degraded = findings.some((f) => f.assessment === "stalled" || f.assessment === "over_cap" || f.assessment === "spike");
  const verdict = degraded ? "degraded" : (findings.length ? "watch" : "healthy");
  return { verdict, intervention_findings, findings };
}

export async function run(inputs) {
  // Read-only contract: refuse any mutate/write framing. (Graph still seals;
  // this is a hard guard for the contract, not the harness verdict.)
  if (inputs && (inputs.mutate === true || inputs.append === true || inputs.advance === true)) {
    return { status: "policy_denied", reason: "read_only_contract", health_bundle: null };
  }

  const norms = Object.assign({}, DEFAULT_NORMS, inputs.norms || {});
  const events = loadEvents(inputs);
  const ledger = readLedgerStubs(inputs.ledger_query);
  const folded = foldProjection(events);

  // STOP case: no readable case events over the period -> needs_more_evidence,
  // no findings graded, no intervention emitted. Deterministic conflict that
  // still seals.
  if (folded.turns_total === 0) {
    return {
      status: "sealed",
      agent_task: {
        "agency-health": {
          output: {
            health_bundle: {
              schema: "runx.agency.health.v1",
              case_id: inputs.case_id,
              agency_ref: inputs.agency_ref,
              period: inputs.period || null,
              decision: "needs_more_evidence",
              health_verdict: { status: "unverifiable", findings: [] },
              intervention_findings: [],
              folded,
              ledger_stubs: ledger,
              refused_reason: "no readable case events for agency_ref over the requested period",
            },
          },
        },
      },
      receipt: { schema: "runx.receipt.v1" },
    };
  }

  const { verdict, intervention_findings, findings } = grade(folded, ledger, norms, inputs);
  const decision = verdict === "healthy" ? "ready" : (verdict === "degraded" ? "ready" : "needs_human");
  return {
    status: "sealed",
    agent_task: {
      "agency-health": {
        output: {
          health_bundle: {
            schema: "runx.agency.health.v1",
            case_id: inputs.case_id,
            agency_ref: inputs.agency_ref,
            period: inputs.period || null,
            decision,
            health_verdict: { status: verdict, findings },
            intervention_findings,
            folded,
            ledger_stubs: ledger,
          },
        },
      },
    },
    receipt: { schema: "runx.receipt.v1" },
  };
}

// CLI dogfood: read inputs from RUNX_INPUTS_JSON (runx cli-tool contract) or a
// fixture file argument, and print the sealed bundle.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  let inputs;
  if (process.env.RUNX_INPUTS_JSON) {
    inputs = JSON.parse(process.env.RUNX_INPUTS_JSON);
  } else if (process.argv[2]) {
    inputs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  } else {
    console.error("usage: node agency-health.mjs <fixture.json> OR set RUNX_INPUTS_JSON");
    process.exit(2);
  }
  const out = await run(inputs);
  console.log(JSON.stringify(out, null, 2));
}
