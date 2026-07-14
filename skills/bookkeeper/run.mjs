#!/usr/bin/env node
// bookkeeper run.mjs
// Read-only categorizer: transactions[] + chart_of_accounts + prior_period ->
// categorized[], anomalies[], reconciliation{matched,unmatched,opening_balance,closing_balance,per_account[]}.
// Deterministic, no network, no side effects, no live-ledger mutation.
// Refuses to invent a GL account the chart does not expose.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function readInputs() {
  // The runx harness and installed-skill runtime may spill typed inputs to a
  // file or an environment variable. Keep stdin as the final CLI fallback.
  if (process.env.RUNX_INPUTS_PATH) {
    try {
      return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
    } catch (err) {
      fail("RUNX_INPUTS_PATH could not be parsed", { parse_error: String(err) });
    }
  }
  if (process.env.RUNX_INPUTS_JSON) {
    try {
      return JSON.parse(process.env.RUNX_INPUTS_JSON);
    } catch (err) {
      fail("RUNX_INPUTS_JSON could not be parsed", { parse_error: String(err) });
    }
  }
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail("inputs must be valid JSON", { parse_error: String(err) });
  }
}

function fail(message, extra = {}) {
  const out = {
    status: "refused",
    reason: message,
    ...extra,
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

function need(obj, key) {
  if (obj[key] === undefined || obj[key] === null || obj[key] === "") {
    fail(`missing required input: ${key}`);
  }
  return obj[key];
}

function optional(obj, key, fallback) {
  if (obj[key] === undefined || obj[key] === null) return fallback;
  return obj[key];
}

function normalizePayee(s) {
  return String(s || "").trim().toLowerCase();
}

function memoFingerprint(t) {
  const payee = normalizePayee(t.payee);
  const date = String(t.date || "").slice(0, 10);
  const amount = Number(t.amount).toFixed(2);
  return `${payee}|${date}|${amount}`;
}

function inPeriod(dateStr, period) {
  if (!period) return true;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return false;
  if (period.since && t < Date.parse(period.since)) return false;
  if (period.until && t > Date.parse(period.until)) return false;
  return true;
}

function derivePeriod(transactions, supplied) {
  if (supplied && supplied.since && supplied.until) return supplied;
  let min = null, max = null;
  for (const t of transactions) {
    const tMs = Date.parse(t.date);
    if (Number.isNaN(tMs)) continue;
    if (min === null || tMs < min) min = tMs;
    if (max === null || tMs > max) max = tMs;
  }
  if (min === null) return null;
  return {
    since: new Date(min).toISOString().slice(0, 10),
    until: new Date(max).toISOString().slice(0, 10),
  };
}

function buildChartIndex(chart) {
  const byCode = new Map();
  for (const a of chart) {
    byCode.set(String(a.code), {
      code: String(a.code),
      name: String(a.name || ""),
      type: String(a.type || ""),
      sub: a.sub ? String(a.sub) : null,
      keywords: Array.isArray(a.keywords) ? a.keywords.map((k) => String(k).toLowerCase()) : [],
    });
  }
  return byCode;
}

function keywordScore(needle, keywords) {
  const n = needle.toLowerCase();
  let best = 0;
  for (const kw of keywords) {
    if (n.includes(kw)) {
      if (kw.length > best) best = kw.length;
    }
  }
  return best;
}

function categorizeOne(t, chartIdx, priorPeriod) {
  const txId = String(t.id);
  const result = {
    transaction_id: txId,
    account_code: null,
    confidence: 0.0,
    reason: "needs_review",
    amount: Number(t.amount),
    currency: String(t.currency || ""),
  };
  const anomalies = [];

  // 1. explicit suggested_account if it exists in chart
  if (t.suggested_account && chartIdx.has(String(t.suggested_account))) {
    result.account_code = String(t.suggested_account);
    result.confidence = 1.0;
    result.reason = "explicit";
  }

  // 2. vendor memory
  if (!result.account_code && priorPeriod && priorPeriod.vendor_map) {
    const np = normalizePayee(t.payee);
    const code = priorPeriod.vendor_map[np] || priorPeriod.vendor_map[t.payee];
    if (code && chartIdx.has(String(code))) {
      result.account_code = String(code);
      result.confidence = 0.85;
      result.reason = "vendor_memory";
    }
  }

  // 3. keyword match against memo+payee
  // Treat every matching account as a candidate. Multiple candidates are
  // ambiguous even when one keyword is longer; the skill must not guess.
  if (!result.account_code) {
    const needle = `${t.payee || ""} ${t.memo || ""}`;
    const matchedCodes = [];
    for (const [code, acct] of chartIdx.entries()) {
      if (keywordScore(needle, acct.keywords) > 0) matchedCodes.push(code);
    }
    if (matchedCodes.length === 1) {
      result.account_code = matchedCodes[0];
      result.confidence = 0.6;
      result.reason = "keyword_match";
    }
  }

  // 4. duplicate detection
  if (priorPeriod && Array.isArray(priorPeriod.booked_fingerprints)) {
    const fp = memoFingerprint(t);
    if (priorPeriod.booked_fingerprints.includes(fp)) {
      anomalies.push({
        transaction_id: txId,
        kind: "duplicate",
        detail: `fingerprint ${fp} already booked in prior period`,
      });
      // duplicate gets routed to needs_review (not categorized)
      result.account_code = null;
      result.confidence = 0.0;
      result.reason = "needs_review";
    }
  }

  // 5. amount outlier (>5x vendor median in prior period)
  if (priorPeriod && priorPeriod.vendor_median_amount && result.account_code) {
    const np = normalizePayee(t.payee);
    const median = priorPeriod.vendor_median_amount[np] || priorPeriod.vendor_median_amount[t.payee];
    if (median && Math.abs(Number(t.amount)) > 5 * Math.abs(Number(median))) {
      anomalies.push({
        transaction_id: txId,
        kind: "amount_outlier",
        detail: `amount ${t.amount} > 5x vendor median ${median}`,
      });
    }
  }

  // 6. missing memo
  if (!t.memo || String(t.memo).trim() === "") {
    anomalies.push({
      transaction_id: txId,
      kind: "missing_memo",
      detail: "no memo attached",
    });
  }

  return { result, anomalies };
}

function reconcile({ categorized, chartIdx, priorPeriod, transactions }) {
  const perAccount = new Map();
  let matched = 0;
  let unmatched = 0;
  for (const c of categorized) {
    if (c.account_code && chartIdx.has(c.account_code)) {
      const key = c.account_code;
      perAccount.set(key, (perAccount.get(key) || 0) + Number(c.amount));
      matched += 1;
    } else {
      unmatched += 1;
    }
  }
  const per_account = Array.from(perAccount.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account_code, net]) => ({ account_code, net: Number(net.toFixed(2)) }));

  // cash equivalents
  const cashCodes = [];
  for (const [code, acct] of chartIdx.entries()) {
    if (acct.sub === "cash_equivalent" || acct.type === "asset") {
      // only count accounts that were actually used or marked as cash_equivalent
      if (acct.sub === "cash_equivalent") cashCodes.push(code);
    }
  }

  const opening_balance = (() => {
    if (!priorPeriod || !priorPeriod.opening_balances) return null;
    const totals = [];
    for (const code of cashCodes) {
      if (priorPeriod.opening_balances[code] !== undefined) {
        totals.push(Number(priorPeriod.opening_balances[code]));
      }
    }
    if (totals.length === 0) return null;
    return Number(totals.reduce((a, b) => a + b, 0).toFixed(2));
  })();

  const closing_balance = (() => {
    if (cashCodes.length !== 1) return null;
    const code = cashCodes[0];
    const opening = opening_balance || 0;
    const net = perAccount.get(code) || 0;
    return Number((opening + net).toFixed(2));
  })();

  return {
    matched,
    unmatched,
    opening_balance,
    closing_balance,
    per_account,
    _cash_codes: cashCodes,
  };
}

function seal({ decision, categorized, anomalies, reconciliation, refusals, observations, refused }) {
  // Map decision -> runx status vocabulary so inline harness expectation passes:
  //   ready/needs_human -> sealed
  //   needs_more_evidence -> needs_agent (routes back to operator for review)
  let status;
  if (refused) {
    status = "needs_agent";
  } else if (decision === "needs_more_evidence") {
    status = "needs_agent";
  } else {
    status = "sealed";
  }
  const out = {
    schema: "runx.bookkeeping.v1",
    status,
    decision,
    categorized,
    anomalies,
    reconciliation: {
      matched: reconciliation.matched,
      unmatched: reconciliation.unmatched,
      opening_balance: reconciliation.opening_balance,
      closing_balance: reconciliation.closing_balance,
      per_account: reconciliation.per_account,
    },
    refusals,
    observations,
  };
  // The package is deterministic: do not embed a wall-clock timestamp in the
  // read-only artifact. The governed runx receipt carries its own seal time.
  const canon = JSON.stringify(out, Object.keys(out).sort(), 2);
  out.receipt_local = {
    schema: "runx.receipt.local.v1",
    algorithm: "sha256",
    digest: crypto.createHash("sha256").update(canon).digest("hex"),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

const inputs = readInputs();
const transactions = need(inputs, "transactions");
const chart = need(inputs, "chart_of_accounts");
const priorPeriod = optional(inputs, "prior_period", null);
const suppliedPeriod = optional(inputs, "period", null);

if (!Array.isArray(transactions)) {
  fail("transactions must be an array");
}
if (!Array.isArray(chart)) {
  fail("chart_of_accounts must be an array");
}

if (transactions.length === 0) {
  seal({
    decision: "needs_more_evidence",
    categorized: [],
    anomalies: [],
    reconciliation: { matched: 0, unmatched: 0, opening_balance: null, closing_balance: null, per_account: [] },
    refusals: [{ when: "empty_batch", reason: "transactions[] is empty" }],
    observations: {
      categorized_count: 0,
      anomaly_count: 0,
      unmatched_count: 0,
      needs_review_count: 0,
      period: { since: null, until: null },
      chart_size: Array.isArray(chart) ? chart.length : 0,
    },
    refused: true,
  });
  process.exit(0);
}

if (chart.length === 0) {
  seal({
    decision: "needs_more_evidence",
    categorized: [],
    anomalies: [],
    reconciliation: { matched: 0, unmatched: 0, opening_balance: null, closing_balance: null, per_account: [] },
    refusals: [{ when: "empty_chart", reason: "chart_of_accounts[] is empty" }],
    observations: {
      categorized_count: 0,
      anomaly_count: 0,
      unmatched_count: 0,
      needs_review_count: 0,
      period: { since: null, until: null },
      chart_size: 0,
    },
    refused: true,
  });
  process.exit(0);
}

const chartIdx = buildChartIndex(chart);
const period = derivePeriod(transactions, suppliedPeriod);

const allCategorized = [];
const allAnomalies = [];
const allRefusals = [];
let outOfPeriodCount = 0;
let unknownPayeeCount = 0;

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function validateLine(t) {
  const errs = [];
  if (t.id === undefined || t.id === null || t.id === "") errs.push("id");
  if (!isValidDate(t.date)) errs.push("date");
  if (typeof t.amount !== "number" || !Number.isFinite(t.amount)) errs.push("amount");
  if (typeof t.currency !== "string" || t.currency === "") errs.push("currency");
  if (typeof t.payee !== "string" || t.payee === "") errs.push("payee");
  return errs;
}

for (const t of transactions) {
  const errs = validateLine(t);
  if (errs.length > 0) {
    allRefusals.push({
      when: "missing_field",
      reason: `transaction missing/invalid field(s): ${errs.join(",")}`,
      transaction_id: t.id || null,
    });
  }

  if (!errs.includes("date") && !inPeriod(t.date, period)) {
    allAnomalies.push({
      transaction_id: String(t.id),
      kind: "out_of_period",
      detail: `date ${t.date} outside period ${period ? period.since : "?"}..${period ? period.until : "?"}`,
    });
    outOfPeriodCount += 1;
  }

  const { result, anomalies } = categorizeOne(t, chartIdx, priorPeriod);
  allCategorized.push(result);
  for (const a of anomalies) allAnomalies.push(a);

  if (!result.account_code) {
    unknownPayeeCount += 1;
    if (!anomalies.some((a) => a.transaction_id === String(t.id))) {
      allAnomalies.push({
        transaction_id: String(t.id),
        kind: "unknown_payee",
        detail: `no vendor memory and no keyword match for payee "${t.payee}"`,
      });
    }
  }
}

// chart_missing_account check: explicit suggested_account that isn't in chart
for (const t of transactions) {
  if (t.suggested_account && !chartIdx.has(String(t.suggested_account))) {
    allRefusals.push({
      when: "chart_missing_account",
      reason: `suggested_account ${t.suggested_account} not in chart`,
      transaction_id: String(t.id),
    });
  }
}

const reconciliation = reconcile({
  categorized: allCategorized,
  chartIdx,
  priorPeriod,
  transactions,
});

// ambiguous_cash_set -> closing_balance null + refusal
if (reconciliation._cash_codes.length !== 1) {
  allRefusals.push({
    when: "ambiguous_cash_set",
    reason: `chart exposes ${reconciliation._cash_codes.length} cash_equivalent account(s); closing_balance omitted`,
    transaction_id: null,
  });
  reconciliation.closing_balance = null;
}
delete reconciliation._cash_codes;

const needsReviewCount = allCategorized.filter((c) => !c.account_code).length;

let decision = "ready";
if (allRefusals.some((r) => r.when === "chart_missing_account")) {
  decision = "needs_human";
} else if (
  transactions.length > 0 &&
  needsReviewCount > 0 &&
  needsReviewCount / transactions.length >= 0.5
) {
  // majority of the batch needs human attention; route to review rather than
  // a partial ready.
  decision = "needs_more_evidence";
}

const observations = {
  categorized_count: allCategorized.filter((c) => c.account_code).length,
  anomaly_count: allAnomalies.length,
  unmatched_count: reconciliation.unmatched,
  needs_review_count: needsReviewCount,
  out_of_period_count: outOfPeriodCount,
  unknown_payee_count: unknownPayeeCount,
  period: { since: period ? period.since : null, until: period ? period.until : null },
  chart_size: chartIdx.size,
};

const isRefused = decision === "needs_more_evidence" && allCategorized.filter((c) => c.account_code).length === 0;

seal({
  decision,
  categorized: allCategorized,
  anomalies: allAnomalies,
  reconciliation,
  refusals: allRefusals,
  observations,
  refused: isRefused,
});
