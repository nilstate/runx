function jsonInput(name, fallback = undefined) {
  const raw = process.env[`RUNX_INPUT_${name}`];
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name.toLowerCase()} must be valid JSON`);
  }
}

function words(value) {
  return String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function normalizeAccounts(chart) {
  if (!Array.isArray(chart)) return [];
  return chart
    .map((account) => ({
      code: String(account?.code ?? "").trim(),
      name: String(account?.name ?? "").trim(),
      keywords: Array.isArray(account?.keywords)
        ? account.keywords.map((keyword) => String(keyword).toLowerCase().trim()).filter(Boolean)
        : [],
    }))
    .filter((account) => account.code && account.name);
}

function validateTransaction(txn, priorCurrency) {
  const missing = [];
  for (const key of ["id", "date", "description", "currency"]) {
    if (!String(txn?.[key] ?? "").trim()) missing.push(`${key} missing`);
  }
  const amount = Number(txn?.amount);
  if (!Number.isFinite(amount)) missing.push("amount missing or not numeric");
  if (String(txn?.currency ?? "").trim() && priorCurrency && String(txn.currency).toUpperCase() !== priorCurrency) {
    missing.push(`currency ${txn.currency} does not match prior_period currency ${priorCurrency}`);
  }
  return { ok: missing.length === 0, missing, amount };
}

function scoreAccount(txn, account) {
  const haystack = new Set(words(`${txn.description} ${txn.id}`));
  let hits = 0;
  for (const keyword of account.keywords) {
    if (haystack.has(keyword) || String(txn.description ?? "").toLowerCase().includes(keyword)) hits += 1;
  }
  return hits;
}

function categorizeOne(txn, accounts, priorCurrency) {
  const validation = validateTransaction(txn, priorCurrency);
  if (!validation.ok) {
    return {
      anomaly: {
        transaction_id: String(txn?.id ?? "unknown"),
        reason: validation.missing.join("; "),
        needs_review: true,
      },
    };
  }

  const scored = accounts
    .map((account) => ({ account, score: scoreAccount(txn, account) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      anomaly: {
        transaction_id: txn.id,
        reason: "no chart_of_accounts keyword matched the transaction description",
        needs_review: true,
      },
    };
  }

  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return {
      anomaly: {
        transaction_id: txn.id,
        reason: `ambiguous account match between ${scored[0].account.code} and ${scored[1].account.code}`,
        needs_review: true,
      },
    };
  }

  const top = scored[0];
  return {
    categorized: {
      transaction_id: txn.id,
      date: txn.date,
      description: txn.description,
      amount: validation.amount,
      currency: String(txn.currency).toUpperCase(),
      account_code: top.account.code,
      account_name: top.account.name,
      confidence: top.score >= 2 ? "high" : "medium",
      reason: `matched chart_of_accounts keyword(s): ${top.account.keywords.join(", ")}`,
    },
  };
}

function evaluate({ transactions, chartOfAccounts, priorPeriod }) {
  const accounts = normalizeAccounts(chartOfAccounts);
  const priorCurrency = String(priorPeriod?.currency ?? "").toUpperCase();
  const anomalies = [];
  const categorized = [];

  if (!Array.isArray(transactions) || transactions.length === 0) {
    anomalies.push({ transaction_id: "batch", reason: "transactions must be a non-empty array", needs_review: true });
  }
  if (accounts.length === 0) {
    anomalies.push({ transaction_id: "batch", reason: "chart_of_accounts must contain existing accounts", needs_review: true });
  }
  if (!Number.isFinite(Number(priorPeriod?.ending_cash))) {
    anomalies.push({ transaction_id: "batch", reason: "prior_period.ending_cash is missing or not numeric", needs_review: true });
  }

  if (Array.isArray(transactions) && accounts.length > 0) {
    for (const txn of transactions) {
      const result = categorizeOne(txn, accounts, priorCurrency);
      if (result.categorized) categorized.push(result.categorized);
      if (result.anomaly) anomalies.push(result.anomaly);
    }
  }

  const matched = categorized.reduce((sum, item) => sum + item.amount, 0);
  const unmatched = Array.isArray(transactions)
    ? transactions.reduce((sum, txn) => sum + (anomalies.some((a) => a.transaction_id === txn.id) ? Number(txn.amount) || 0 : 0), 0)
    : 0;
  const endingCash = Number(priorPeriod?.ending_cash);

  return {
    status: "success",
    schema: "bookkeeper.reconciliation_artifact.v1",
    package: "bookkeeper",
    version: "0.1.0",
    categorized,
    anomalies,
    reconciliation: {
      matched,
      unmatched,
      prior_period_ending_cash: Number.isFinite(endingCash) ? endingCash : null,
      projected_cash_after_matched: Number.isFinite(endingCash) ? endingCash + matched : null,
      matched_count: categorized.length,
      unmatched_count: anomalies.filter((item) => item.transaction_id !== "batch").length,
    },
    effects: {
      ledger_mutation: false,
      journal_posted: false,
      money_rail: false,
      invented_gl_account: false,
    },
  };
}

function main() {
  const transactions = jsonInput("TRANSACTIONS", []);
  const chartOfAccounts = jsonInput("CHART_OF_ACCOUNTS", []);
  const priorPeriod = jsonInput("PRIOR_PERIOD", {});
  process.stdout.write(`${JSON.stringify(evaluate({ transactions, chartOfAccounts, priorPeriod }), null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
