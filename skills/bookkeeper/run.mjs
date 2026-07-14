const DECIMAL_PLACES = 2;
const MIN_CONFIDENCE = 0.6;

function input(name) {
  return process.env[`RUNX_INPUT_${name.toUpperCase()}`] ?? "";
}

function parseJsonInput(name) {
  const raw = input(name);
  if (!raw.trim()) {
    fail(`missing required input: ${name}`, { missing_input: name });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`invalid JSON input: ${name}`, { missing_input: name, error: String(error.message || error) });
  }
}

function fail(message, extra = {}) {
  const packet = {
    schema: "runx.bookkeeper.result.v1",
    status: "needs_review",
    decision: "needs_review",
    reason_code: "bookkeeper.input_or_matching_refused",
    message,
    categorized: [],
    anomalies: [],
    reconciliation: {
      matched: { count: 0, total: 0 },
      unmatched: { count: 0, total: 0 },
    },
    ...extra,
  };
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  process.exit(64);
}

function assertArray(name, value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${name} must be a non-empty array`, { invalid_input: name });
  }
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function rounded(value) {
  return Number(Number(value || 0).toFixed(DECIMAL_PLACES));
}

function moneyAbs(value) {
  return Math.abs(Number(value || 0));
}

function accountKeywords(account) {
  const keywords = Array.isArray(account.keywords) ? account.keywords : [];
  return [account.code, account.name, account.type, ...keywords]
    .filter(Boolean)
    .map(normalizeText)
    .filter(Boolean);
}

function scoreAccount(transaction, account) {
  const haystack = normalizeText([
    transaction.description,
    transaction.counterparty,
    transaction.category_hint,
  ].filter(Boolean).join(" "));
  const keywords = accountKeywords(account);
  const hits = keywords.filter((keyword) => keyword && haystack.includes(keyword));
  const signedAmount = Number(transaction.amount);
  let score = hits.length > 0 ? Math.min(0.95, 0.45 + hits.length * 0.2) : 0;

  if (account.type === "income" && signedAmount > 0) score += 0.1;
  if (account.type === "expense" && signedAmount < 0) score += 0.1;
  if (account.type === "asset" && /transfer|deposit|bank|wallet/.test(haystack)) score += 0.05;

  return {
    account,
    confidence: Math.min(0.99, rounded(score)),
    hits,
  };
}

function categorize(transactions, accounts) {
  const categorized = [];
  const unmatched = [];

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      unmatched.push({ transaction_id: null, reason: "transaction is not an object" });
      continue;
    }
    if (!transaction.id || !transaction.description || transaction.amount == null || !transaction.currency) {
      unmatched.push({ transaction_id: transaction.id || null, reason: "transaction missing id, description, amount, or currency" });
      continue;
    }

    const ranked = accounts
      .map((account) => scoreAccount(transaction, account))
      .sort((a, b) => b.confidence - a.confidence);
    const best = ranked[0];
    const second = ranked[1];
    const ambiguous = !best
      || best.confidence < MIN_CONFIDENCE
      || (second && best.confidence - second.confidence < 0.15);

    if (ambiguous) {
      unmatched.push({
        transaction_id: transaction.id,
        description: transaction.description,
        amount: rounded(transaction.amount),
        reason: best ? "no existing GL account matched with enough confidence" : "chart of accounts is empty",
        top_candidates: ranked.slice(0, 3).map((candidate) => ({
          account_code: candidate.account.code,
          account_name: candidate.account.name,
          confidence: candidate.confidence,
          matched_keywords: candidate.hits,
        })),
      });
      continue;
    }

    categorized.push({
      transaction_id: transaction.id,
      date: transaction.date || null,
      description: transaction.description,
      amount: rounded(transaction.amount),
      currency: transaction.currency,
      account_code: best.account.code,
      account_name: best.account.name,
      account_type: best.account.type,
      confidence: best.confidence,
      reason: `matched existing account ${best.account.code} via keywords: ${best.hits.join(", ")}`,
      read_only: true,
    });
  }

  return { categorized, unmatched };
}

function findAnomalies(transactions, categorized, unmatched, priorPeriod) {
  const anomalies = [];
  const seenIds = new Set();
  const expectedCurrency = priorPeriod.currency || transactions[0]?.currency;
  const avg = Number(priorPeriod.average_transaction_amount || 0);
  const knownCounterparties = new Set((priorPeriod.known_counterparties || []).map((value) => normalizeText(value)));

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") continue;
    if (seenIds.has(transaction.id)) {
      anomalies.push({
        type: "duplicate_transaction_id",
        transaction_id: transaction.id,
        severity: "high",
        reason: "same transaction id appeared more than once",
      });
    }
    seenIds.add(transaction.id);

    if (expectedCurrency && transaction.currency && transaction.currency !== expectedCurrency) {
      anomalies.push({
        type: "currency_mismatch",
        transaction_id: transaction.id,
        severity: "medium",
        reason: `transaction currency ${transaction.currency} differs from prior period ${expectedCurrency}`,
      });
    }

    if (avg > 0 && moneyAbs(transaction.amount) > avg * 4) {
      anomalies.push({
        type: "amount_outlier",
        transaction_id: transaction.id,
        severity: "medium",
        reason: `absolute amount ${moneyAbs(transaction.amount)} is more than 4x prior average ${avg}`,
      });
    }

    if (transaction.counterparty && knownCounterparties.size > 0 && !knownCounterparties.has(normalizeText(transaction.counterparty))) {
      anomalies.push({
        type: "new_counterparty",
        transaction_id: transaction.id,
        severity: "low",
        reason: `${transaction.counterparty} was not present in prior_period.known_counterparties`,
      });
    }
  }

  for (const item of unmatched) {
    anomalies.push({
      type: "needs_review",
      transaction_id: item.transaction_id,
      severity: "high",
      reason: item.reason,
    });
  }

  const income = categorized.filter((line) => line.account_type === "income").reduce((sum, line) => sum + Number(line.amount), 0);
  const expense = categorized.filter((line) => line.account_type === "expense").reduce((sum, line) => sum + Math.abs(Number(line.amount)), 0);
  if (priorPeriod.total_income && income < Number(priorPeriod.total_income) * 0.05) {
    anomalies.push({
      type: "income_drop_review",
      severity: "low",
      reason: "matched income is below 5% of prior period income; confirm this is a partial batch",
    });
  }
  if (priorPeriod.total_expense && expense > Number(priorPeriod.total_expense) * 2) {
    anomalies.push({
      type: "expense_spike_review",
      severity: "medium",
      reason: "matched expenses exceed 2x prior period expense",
    });
  }

  return anomalies;
}

function validateAccounts(accounts) {
  const bad = accounts.filter((account) => !account || typeof account !== "object" || !account.code || !account.name || !account.type);
  if (bad.length > 0) {
    fail("every chart_of_accounts entry must include code, name, and type", { invalid_accounts: bad.length });
  }
  const seen = new Set();
  for (const account of accounts) {
    if (seen.has(account.code)) {
      fail(`duplicate GL account code: ${account.code}`, { duplicate_account_code: account.code });
    }
    seen.add(account.code);
  }
}

const transactions = parseJsonInput("transactions");
const chartOfAccounts = parseJsonInput("chart_of_accounts");
const priorPeriod = parseJsonInput("prior_period");

assertArray("transactions", transactions);
assertArray("chart_of_accounts", chartOfAccounts);
if (!priorPeriod || typeof priorPeriod !== "object" || Array.isArray(priorPeriod)) {
  fail("prior_period must be an object", { invalid_input: "prior_period" });
}
validateAccounts(chartOfAccounts);

const { categorized, unmatched } = categorize(transactions, chartOfAccounts);
const anomalies = findAnomalies(transactions, categorized, unmatched, priorPeriod);
const matchedTotal = rounded(categorized.reduce((sum, line) => sum + Number(line.amount), 0));
const unmatchedTotal = rounded(unmatched.reduce((sum, item) => {
  const source = transactions.find((transaction) => transaction?.id === item.transaction_id);
  return sum + Number(source?.amount || 0);
}, 0));

const packet = {
  schema: "runx.bookkeeper.result.v1",
  status: unmatched.length === 0 ? "categorized" : "needs_review",
  decision: unmatched.length === 0 ? "ready" : "needs_review",
  package: {
    name: "bookkeeper",
    version: "0.1.0",
  },
  categorized,
  anomalies,
  reconciliation: {
    matched: {
      count: categorized.length,
      total: matchedTotal,
      transaction_ids: categorized.map((line) => line.transaction_id),
    },
    unmatched: {
      count: unmatched.length,
      total: unmatchedTotal,
      transactions: unmatched,
    },
  },
  controls: {
    read_only: true,
    ledger_mutation_performed: false,
    invented_accounts: false,
    account_universe: chartOfAccounts.map((account) => ({ code: account.code, name: account.name, type: account.type })),
  },
};

process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
if (unmatched.length > 0) {
  process.exit(64);
}
