import fs from "node:fs";

const inputs = readInputs();
const ledger = arrayValue(inputs.ledger_lines, "ledger_lines");
const subs = arrayValue(inputs.known_subscriptions, "known_subscriptions");
const windowDays = numberOrDefault(inputs.baseline_window_days, 35);
const tolerancePct = numberOrDefault(inputs.tolerance_pct, 0.15);

if (ledger.length === 0) fail("ledger_lines[] is required and must be non-empty");
if (subs.length === 0) fail("known_subscriptions[] is required and must be non-empty");

const expectedVsActual = subs.map((sub) => auditSubscription(sub, ledger, windowDays, tolerancePct));
const leakCandidates = expectedVsActual.filter((row) => row.delta > 0 && row.confidence >= 0.4);
const refundRecommendation = buildRefundRecommendation(expectedVsActual);
const stopConditions = [
  "manual_review_required_for_high_value_discrepancies",
  "private_customer_data_not_to_leave_audit_skill",
];
const handoff = {
  next_skill: "governed-outbound",
  requires_human_approval: true,
};

const result = {
  leak_candidates: leakCandidates,
  expected_vs_actual: expectedVsActual,
  refund_recommendation: refundRecommendation,
  stop_conditions: stopConditions,
  handoff,
  meta: {
    window_days: windowDays,
    tolerance_pct: tolerancePct,
    ledger_line_count: ledger.length,
    subscription_count: subs.length,
    leak_count: leakCandidates.length,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    ledger_lines: parseInputValue(process.env.RUNX_INPUT_LEDGER_LINES),
    known_subscriptions: parseInputValue(process.env.RUNX_INPUT_KNOWN_SUBSCRIPTIONS),
    baseline_window_days: parseInputValue(process.env.RUNX_INPUT_BASELINE_WINDOW_DAYS),
    tolerance_pct: parseInputValue(process.env.RUNX_INPUT_TOLERANCE_PCT),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be a JSON array`);
  return value;
}

function numberOrDefault(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

function fail(reason) {
  process.stdout.write(`${JSON.stringify({ error: "revenue_audit_invalid_input", detail: reason }, null, 2)}\n`);
  process.exit(64);
}

function auditSubscription(sub, ledger, windowDays, tolerancePct) {
  const name = String(sub.name || "unknown").toLowerCase();
  const expected = Number(sub.expected_amount_usd);
  const cadence = Number(sub.cadence_days || 30);
  const expectedCharges = Math.max(1, Math.round(windowDays / cadence));

  const matches = ledger.filter((line) => {
    const vendor = String(line.vendor_hint || "").toLowerCase();
    const tokens = name.split(/\s+/);
    const tokenOverlap = tokens.some((t) => t.length >= 3 && vendor.includes(t));
    const amountMatch = Math.abs(Number(line.amount_usd) - expected) <= expected * tolerancePct;
    return tokenOverlap || amountMatch;
  });

  const actualCharges = matches.length;
  const delta = expectedCharges - actualCharges;
  let confidence = 0;
  let matchBasis = "no_match";
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    const vendor = String(lastMatch.vendor_hint || "").toLowerCase();
    const tokenOverlap = name.split(/\s+/).some((t) => t.length >= 3 && vendor.includes(t));
    const amountMatch = Math.abs(Number(lastMatch.amount_usd) - expected) <= expected * tolerancePct;
    if (tokenOverlap && amountMatch) { confidence = 0.85; matchBasis = "vendor_and_amount"; }
    else if (tokenOverlap) { confidence = 0.6; matchBasis = "vendor_token_overlap"; }
    else { confidence = 0.5; matchBasis = "amount_within_tolerance_pct"; }
  } else {
    confidence = 0.45;
    matchBasis = "no_match";
  }

  return {
    subscription: sub.name,
    expected_charges: expectedCharges,
    actual_charges: actualCharges,
    delta,
    confidence,
    match_basis: matchBasis,
    window_days: windowDays,
  };
}

function buildRefundRecommendation(rows) {
  const overcharges = rows.filter((r) => r.delta < 0);
  if (overcharges.length === 0) return null;
  const total = overcharges.reduce((sum, r) => sum + Math.abs(r.delta) * 0, 0); // bounded — no per-charge price known
  return {
    proposed: true,
    affected_subscription_count: overcharges.length,
    requires_invoice_review: true,
    note: "Per-charge refund amount bounded by auditor inputs; finance team must verify exact invoice line items before issuing.",
  };
}