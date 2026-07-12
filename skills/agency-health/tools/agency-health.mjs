// agency-health runner: read-only health bundle assembler.
// Composes data-store read_projection (C2) for the agency case, grades signals
// against declared norms, and seals a health_verdict. Reads C7 ledger aggregates
// by receipt id-stub only. Appends nothing, sends nothing, executes nothing.
//
// Harness contract: receives graph inputs, returns agent_task.agency-health.output
// with a health_bundle, or refuses when a write/mutate framing is supplied.

const DEFAULT_NORMS = {
  stall_window_turns: 5,
  awaiting_approval_cap: 3,
  spend_cap_pct: 90,
  act_cap_pct: 90,
  refusal_spike_threshold: 0.2,
  seal_rate_floor: 0.8,
};

// In OSS dogfood the data-store fixture adapter returns a seeded projection.
// This runner reads the caller-supplied projection (from data-store.read_projection
// in production) and folds it; it never calls append_event.
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
    // stalled: a turn with no resolved successor within stall_window
    if (st !== "resolved" && st !== "failed" && e.stalled_turns > DEFAULT_NORMS.stall_window_turns) {
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
  // In production this shells `runx history --json` filtered by agency_ref+period.
  // Here we accept caller-supplied stubs (harness seeds deterministically).
  const stubs = (ledgerQuery && ledgerQuery.receipt_stubs) || [];
  const sealRate = (ledgerQuery && ledgerQuery.seal_rate) != null ? ledgerQuery.seal_rate : 1;
  const refusalRate = (ledgerQuery && ledgerQuery.refusal_rate) != null ? ledgerQuery.refusal_rate : 0;
  return { seal_rate: sealRate, refusal_rate: refusalRate, receipt_stubs: stubs };
}

function grade(folded, ledger, norms) {
  const findings = [];
  if (folded.stalled_turns.length > 0) {
    findings.push({
      lane: "human",
      signal: "stalled_turns",
      severity: "degraded",
      evidence: "turns: " + folded.stalled_turns.join(", "),
      recommendation: "Escalate stalled turns to a human or tighten the driver cadence.",
    });
  }
  if (folded.approval_parked > norms.awaiting_approval_cap) {
    findings.push({
      lane: "policy-author",
      signal: "approval_parked",
      severity: "degraded",
      evidence: `parked=${folded.approval_parked} > cap=${norms.awaiting_approval_cap}`,
      recommendation: "Tighten approval policy or timeout parked approvals.",
    });
  }
  if (ledger.refusal_rate > norms.refusal_spike_threshold) {
    findings.push({
      lane: "improve-skill",
      signal: "refusal_spike",
      severity: "degraded",
      evidence: `refusal_rate=${ledger.refusal_rate} > ${norms.refusal_spike_threshold}`,
      recommendation: "Debug the member skill emitting refusals.",
    });
  }
  if (ledger.seal_rate < norms.seal_rate_floor) {
    findings.push({
      lane: "ops-desk",
      signal: "seal_rate_low",
      severity: "watch",
      evidence: `seal_rate=${ledger.seal_rate} < ${norms.seal_rate_floor}`,
      recommendation: "Retune dispatch to raise seal rate.",
    });
  }
  const hasDegraded = findings.some((f) => f.severity === "degraded");
  const verdict = hasDegraded ? "degraded" : findings.length ? "watch" : "healthy";
  return { verdict, intervention_findings: findings };
}

export async function run(inputs) {
  // Read-only contract: refuse any mutate/write framing -> policy_denied (stop case).
  if (inputs && (inputs.mutate === true || inputs.append === true || inputs.advance === true)) {
    return {
      status: "policy_denied",
      reason: "read_only_contract",
      health_bundle: null,
    };
  }
  const norms = Object.assign({}, DEFAULT_NORMS, inputs.norms || {});
  const events = (inputs.projection && inputs.projection.events) || inputs.events || [];
  const ledger = readLedgerStubs(inputs.ledger_query);
  const folded = foldProjection(events);
  // Hard gate: empty/unreadable case OR explicit negative fixture -> failure (stop case).
  if (folded.turns_total === 0 || process.env.AGENCY_HEALTH_DENY === "1") {
    return {
      status: "failure",
      reason: "ledger_unreadable_or_tampered",
      health_bundle: null,
    };
  }
  const { verdict, intervention_findings } = grade(folded, ledger, norms);
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
            verdict,
            folded,
            ledger_stubs: ledger,
            intervention_findings,
          },
        },
      },
    },
    receipt: { schema: "runx.receipt.v1" },
  };
}

// CLI dogfood: read inputs from RUNX_INPUTS_JSON (runx cli-tool contract) or a
// fixture file argument, merge context, and print the sealed bundle.
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
  // merge context (e.g. projection from a prior graph step) into inputs
  const ctx = process.env.RUNX_CONTEXT_JSON ? JSON.parse(process.env.RUNX_CONTEXT_JSON) : {};
  inputs = Object.assign({}, inputs, ctx);
  const out = await run(inputs);
  console.log(JSON.stringify(out, null, 2));
}
