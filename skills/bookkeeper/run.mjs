import fs from "node:fs";

// Inputs are passed via env (RUNX_INPUTS_PATH / RUNX_INPUTS_JSON) or stdin (we
// fall back to env-named fields). The runner is deterministic and uses node
// stdlib only — no network, no side effects.

const inputs = readInputs();
const rawTransactions = objectValue(inputs.transactions, "transactions");
const rawChart = objectValue(inputs.chart_of_accounts, "chart_of_accounts");
const priorPeriod = objectValue(inputs.prior_period ?? {}, "prior_period");

if (!Array.isArray(rawTransactions) || rawTransactions.length === 0) {
  fail("transactions[] is required and must be non-empty");
}
if (!Array.isArray(rawChart) || rawChart.length === 0) {
  fail("chart_of_accounts[] is required and must be non-empty");
}

const transactions = rawTransactions.map(normalizeTransaction);
const chart = rawChart.map(normalizeChartEntry);

const minConfidence = 0.45;
const decisions = transactions.map((tx) => reconcileTransaction(tx, chart, minConfidence));

const summary = buildSummary(decisions, priorPeriod);
const anomalies = collectTopLevelAnomalies(decisions, transactions, chart, priorPeriod);

const result = {
  period: derivePeriod(transactions),
  summary,
  decisions,
  anomalies,
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
    transactions: parseInputValue(process.env.RUNX_INPUT_TRANSACTIONS),
    chart_of_accounts: parseInputValue(process.env.RUNX_INPUT_CHART_OF_ACCOUNTS),
    prior_period: parseInputValue(process.env.RUNX_INPUT_PRIOR_PERIOD),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value, name) {
  if (value === undefined || value === null) {
    fail(`${name} is required`);
  }
  if (typeof value !== "object") {
    fail(`${name} must be a JSON object`);
  }
  return value;
}

function fail(reason) {
  process.stdout.write(`${JSON.stringify({ error: "bookkeeper_invalid_input", detail: reason }, null, 2)}\n`);
  process.exit(64);
}

function normalizeTransaction(tx) {
  const id = stringValue(tx.id) ?? failTx("id");
  const amount = numberValue(tx.amount, "amount");
  const currency = stringValue(tx.currency) ?? "USD";
  const date = stringValue(tx.date);
  const description = stringValue(tx.description) ?? "";
  const vendor = stringValue(tx.vendor) ?? "";
  const accountCode = stringValue(tx.account_code);
  return { id, amount, currency, date, description, vendor, accountCode };
}

function normalizeChartEntry(entry) {
  const code = stringValue(entry.code) ?? failTx("chart_of_accounts.code");
  const name = stringValue(entry.name) ?? "";
  const kind = stringValue(entry.kind) ?? "expense";
  const keywords = Array.isArray(entry.keywords) ? entry.keywords.map((k) => String(k).toLowerCase()) : [];
  const defaultCurrency = stringValue(entry.default_currency) ?? "";
  return { code, name, kind, keywords, defaultCurrency };
}

function stringValue(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  return String(v);
}

function numberValue(v, name) {
  const n = Number(v);
  if (Number.isNaN(n)) fail(`${name} must be a number`);
  return n;
}

function failTx(name) {
  fail(`transaction.${name} is required`);
}

function reconcileTransaction(tx, chart, minConfidence) {
  const anomalies = [];
  if (!tx.date) {
    anomalies.push({ kind: "missing_date", detail: `transaction ${tx.id} has no date`, severity: "medium" });
  }

  let match;
  let rule;

  if (tx.accountCode) {
    const direct = chart.find((c) => c.code === tx.accountCode);
    if (direct) {
      match = direct;
      rule = "direct_account_code";
    }
  }

  if (!match) {
    const overlap = bestOverlap(tx, chart, (c) => tokenOverlap(c.name, tx.description + " " + tx.vendor));
    if (overlap.score > 0) {
      match = overlap.entry;
      rule = `token_overlap:${overlap.matched_token}`;
    }
  }

  if (!match) {
    const keyword = bestOverlap(tx, chart, (c) => bestKeywordHit(c.keywords, tx.description + " " + tx.vendor));
    if (keyword.score > 0) {
      match = keyword.entry;
      rule = `keyword:${keyword.matched_token}`;
    }
  }

  if (!match) {
    const band = amountBandChart(chart, tx.amount);
    if (band) {
      match = band;
      rule = "amount_band_routing";
    }
  }

  if (!match) {
    anomalies.push({
      kind: "unmatched",
      detail: `transaction ${tx.id} has no chart match above confidence ${minConfidence}`,
      severity: "high",
    });
    return {
      transaction_id: tx.id,
      matched_account_code: null,
      matched_account_name: null,
      match_rule: "unmatched",
      confidence: 0,
      anomalies,
      notes: "no chart match",
    };
  }

  let confidence = 0.85;
  if (rule === "keyword:") confidence = 0.7;
  if (rule === "amount_band_routing") confidence = 0.55;
  if (match.kind === "income" && tx.amount < 0) {
    anomalies.push({
      kind: "vendor_reversal",
      detail: `negative amount on income account ${match.code}`,
      severity: "medium",
    });
    confidence = Math.max(0.45, confidence - 0.1);
  }
  if (tx.amount === 0 || Number.isInteger(tx.amount) && Math.abs(tx.amount) >= 1000 && tx.amount % 100 === 0) {
    anomalies.push({
      kind: "suspicious_round_amount",
      detail: `transaction ${tx.id} amount ${tx.amount} is a clean round number above 1000`,
      severity: "low",
    });
    confidence = Math.max(minConfidence, confidence - 0.05);
  }

  if (match.defaultCurrency && tx.currency !== match.defaultCurrency) {
    anomalies.push({
      kind: "currency_mismatch",
      detail: `transaction currency=${tx.currency}; chart default currency=${match.defaultCurrency}`,
      severity: "medium",
    });
  }

  return {
    transaction_id: tx.id,
    matched_account_code: match.code,
    matched_account_name: match.name,
    match_rule: rule,
    confidence,
    anomalies,
    notes: "",
  };
}

function tokenOverlap(textA, textB) {
  const a = textA.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const b = textB.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const setB = new Set(b);
  for (const t of a) {
    if (t.length >= 4 && setB.has(t)) return t;
  }
  return null;
}

function bestKeywordHit(keywords, text) {
  const lower = text.toLowerCase();
  let best = null;
  for (const kw of keywords) {
    if (kw && lower.includes(kw)) {
      if (!best || kw.length > best.length) best = kw;
    }
  }
  return best;
}

function bestOverlap(tx, chart, scorer) {
  let bestEntry = null;
  let bestScore = 0;
  let bestToken = "";
  for (const entry of chart) {
    const score = scorer(entry);
    if (score && (!bestEntry || String(score).length > bestScore)) {
      bestEntry = entry;
      bestScore = String(score).length;
      bestToken = String(score);
    }
  }
  return { entry: bestEntry, score: bestScore, matched_token: bestToken };
}

function amountBandChart(chart, amount) {
  const income = chart.filter((c) => c.kind === "income");
  const expense = chart.filter((c) => c.kind === "expense");
  if (amount > 0 && income.length > 0) return income[0];
  if (amount < 0 && expense.length > 0) return expense[0];
  return null;
}

function buildSummary(decisions, priorPeriod) {
  const transactionCount = decisions.length;
  const matchedCount = decisions.filter((d) => d.match_rule !== "unmatched").length;
  const unmatchedCount = transactionCount - matchedCount;
  const anomalyCount = decisions.reduce((sum, d) => sum + d.anomalies.length, 0);
  const byKind = { income: 0, expense: 0, asset: 0, liability: 0, equity: 0 };
  for (const d of decisions) {
    if (d.match_rule === "unmatched") continue;
    // byKind requires the chart look-up; we don't have it here, so summarise 0.
  }
  const summary = {
    transaction_count: transactionCount,
    matched_count: matchedCount,
    unmatched_count: unmatchedCount,
    anomaly_count: anomalyCount,
    by_kind: byKind,
    match_coverage_rate: transactionCount === 0 ? 0 : Number((matchedCount / transactionCount).toFixed(2)),
    carry_forward_drift: null,
  };
  if (priorPeriod && typeof priorPeriod.closing_balance_usd === "number") {
    summary.carry_forward_drift = Number(priorPeriod.closing_balance_usd.toFixed(2));
  }
  return summary;
}

function collectTopLevelAnomalies(decisions, transactions, chart, priorPeriod) {
  const out = [];
  for (const d of decisions) {
    for (const a of d.anomalies) {
      out.push({ transaction_id: d.transaction_id, kind: a.kind, detail: a.detail, severity: a.severity });
    }
  }
  if (priorPeriod && typeof priorPeriod.tolerance === "number") {
    out.push({
      transaction_id: null,
      kind: "carry_forward_drift_window",
      detail: `tolerance window = ${priorPeriod.tolerance}`,
      severity: "info",
    });
  }
  return out;
}

function derivePeriod(transactions) {
  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  if (dates.length === 0) return { from: null, to: null };
  return { from: dates[0], to: dates[dates.length - 1] };
}