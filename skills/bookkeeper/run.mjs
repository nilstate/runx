import fs from "node:fs";
import { loadFranticFundingTransactions } from "./frantic-receipts.mjs";

const SCHEMA = "runx.bookkeeper.result.v1";
const inputs = readInputs();
const fetchedSource = inputs.receipt_urls === undefined
  ? null
  : await loadFranticFundingTransactions(inputs.receipt_urls);
const transactions = requireArray(
  fetchedSource?.transactions ?? inputs.transactions,
  fetchedSource ? "fetched transactions" : "transactions",
);
const accounts = normalizeAccounts(requireArray(inputs.chart_of_accounts, "chart_of_accounts"));
const priorPeriod = requireObject(inputs.prior_period, "prior_period");
const priorTransactions = Array.isArray(priorPeriod.transactions) ? priorPeriod.transactions : [];

if (accounts.length === 0) {
  throw new Error("chart_of_accounts must contain at least one valid account");
}

const categorized = [];
const anomalies = [];
const needsReview = [];
const duplicateIndexes = duplicateTransactionIndexes(transactions);
const priorMedian = median(
  priorTransactions
    .map((transaction) => Math.abs(Number(transaction?.amount)))
    .filter((amount) => Number.isFinite(amount) && amount > 0),
);
let priorPeriodMatches = 0;

for (const [index, rawTransaction] of transactions.entries()) {
  const transactionId = transactionIdentifier(rawTransaction, index);
  const normalized = normalizeTransaction(rawTransaction, transactionId);

  if (!normalized.valid) {
    anomalies.push({
      type: "invalid_transaction",
      transaction_id: transactionId,
      reason: normalized.reason,
    });
    needsReview.push({ transaction_id: transactionId, reason: normalized.reason });
    continue;
  }

  if (!normalized.date) {
    anomalies.push({
      type: "missing_date",
      transaction_id: transactionId,
      reason: "transaction has no date",
    });
  }
  if (normalized.amount === 0) {
    anomalies.push({
      type: "zero_amount",
      transaction_id: transactionId,
      reason: "zero-value transaction requires review",
    });
  }
  if (duplicateIndexes.has(index)) {
    anomalies.push({
      type: "possible_duplicate",
      transaction_id: transactionId,
      reason: "another line has the same date, description, amount, and currency",
    });
  }
  if (priorMedian !== null && Math.abs(normalized.amount) > priorMedian * 3) {
    anomalies.push({
      type: "amount_outlier",
      transaction_id: transactionId,
      amount: normalized.amount,
      prior_period_median_absolute_amount: priorMedian,
      reason: "absolute amount exceeds three times the prior-period median",
    });
  }

  const match = chooseAccount(normalized, accounts, priorTransactions);
  if (match.decision === "needs_review") {
    anomalies.push({
      type: match.anomaly_type,
      transaction_id: transactionId,
      candidates: match.candidates,
      reason: match.reason,
    });
    needsReview.push({
      transaction_id: transactionId,
      candidates: match.candidates,
      reason: match.reason,
    });
    continue;
  }

  if (match.prior_period_match) {
    priorPeriodMatches += 1;
  }
  categorized.push({
    transaction_id: transactionId,
    date: normalized.date,
    description: normalized.description,
    amount: normalized.amount,
    currency: normalized.currency,
    account_id: match.account.id,
    account_name: match.account.name,
    confidence: match.confidence,
    reason: match.reason,
  });
}

const result = {
  schema: SCHEMA,
  source: fetchedSource
    ? {
        kind: "frantic_public_funding_receipts",
        receipts: fetchedSource.receipts,
      }
    : {
        kind: "supplied_transactions",
      },
  decision: needsReview.length === 0 ? "ready" : "needs_review",
  categorized,
  anomalies,
  reconciliation: {
    matched: categorized.length,
    unmatched: needsReview.length,
    total: transactions.length,
    debits: roundMoney(transactions.reduce((sum, transaction) => {
      const amount = Number(transaction?.amount);
      return Number.isFinite(amount) && amount < 0 ? sum + Math.abs(amount) : sum;
    }, 0)),
    credits: roundMoney(transactions.reduce((sum, transaction) => {
      const amount = Number(transaction?.amount);
      return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
    }, 0)),
    net: roundMoney(transactions.reduce((sum, transaction) => {
      const amount = Number(transaction?.amount);
      return Number.isFinite(amount) ? sum + amount : sum;
    }, 0)),
    prior_period_matches: priorPeriodMatches,
  },
  needs_review: needsReview,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.decision === "needs_review") {
  process.exitCode = 2;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    transactions: parseEnvironmentJson("RUNX_INPUT_TRANSACTIONS"),
    chart_of_accounts: parseEnvironmentJson("RUNX_INPUT_CHART_OF_ACCOUNTS"),
    prior_period: parseEnvironmentJson("RUNX_INPUT_PRIOR_PERIOD"),
  };
}

function parseEnvironmentJson(name) {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  return JSON.parse(raw);
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

function normalizeAccounts(rawAccounts) {
  const seen = new Set();
  return rawAccounts.map((account, index) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw new Error(`chart_of_accounts[${index}] must be an object`);
    }
    const id = String(account.id ?? account.account_id ?? account.code ?? "").trim();
    const name = String(account.name ?? "").trim();
    if (!id || !name) {
      throw new Error(`chart_of_accounts[${index}] requires id and name`);
    }
    if (seen.has(id)) {
      throw new Error(`chart_of_accounts contains duplicate id ${id}`);
    }
    seen.add(id);
    const keywords = Array.isArray(account.keywords)
      ? account.keywords.map((keyword) => normalizeText(keyword)).filter(Boolean)
      : [];
    return {
      id,
      name,
      type: normalizeText(account.type ?? ""),
      keywords: [...new Set(keywords)],
      name_tokens: meaningfulTokens(name),
    };
  });
}

function transactionIdentifier(transaction, index) {
  const id = transaction && typeof transaction === "object" ? transaction.id : null;
  return String(id ?? `line-${index + 1}`);
}

function normalizeTransaction(transaction, transactionId) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    return { valid: false, reason: "transaction must be an object" };
  }
  const description = String(transaction.description ?? transaction.memo ?? "").trim();
  const amount = Number(transaction.amount);
  if (!description) {
    return { valid: false, reason: "transaction description is required" };
  }
  if (!Number.isFinite(amount)) {
    return { valid: false, reason: "transaction amount must be finite" };
  }
  return {
    valid: true,
    id: transactionId,
    date: transaction.date ? String(transaction.date) : null,
    description,
    normalized_description: normalizeText(description),
    description_tokens: meaningfulTokens(description),
    amount,
    currency: transaction.currency ? String(transaction.currency).toUpperCase() : null,
    explicit_account_id: transaction.account_id === undefined
      ? null
      : String(transaction.account_id),
  };
}

function chooseAccount(transaction, accounts, priorTransactions) {
  if (transaction.explicit_account_id) {
    const account = accounts.find((candidate) => candidate.id === transaction.explicit_account_id);
    if (!account) {
      return {
        decision: "needs_review",
        anomaly_type: "unknown_explicit_account",
        candidates: [],
        reason: `explicit account ${transaction.explicit_account_id} is absent from chart_of_accounts`,
      };
    }
    return {
      decision: "categorized",
      account,
      confidence: 1,
      prior_period_match: false,
      reason: "explicit account_id exists in chart_of_accounts",
    };
  }

  const priorMatches = priorTransactions.filter((prior) =>
    normalizeText(prior?.description ?? prior?.memo ?? "") === transaction.normalized_description
      && Number(prior?.amount) === transaction.amount
      && accounts.some((account) => account.id === String(prior?.account_id ?? "")),
  );
  const priorAccountIds = [...new Set(priorMatches.map((prior) => String(prior.account_id)))];
  if (priorAccountIds.length === 1) {
    const account = accounts.find((candidate) => candidate.id === priorAccountIds[0]);
    return {
      decision: "categorized",
      account,
      confidence: 0.99,
      prior_period_match: true,
      reason: "exact description and amount match a prior-period line bound to this account",
    };
  }
  if (priorAccountIds.length > 1) {
    return {
      decision: "needs_review",
      anomaly_type: "conflicting_prior_period_accounts",
      candidates: priorAccountIds,
      reason: "matching prior-period lines point to more than one account",
    };
  }

  const scored = accounts.map((account) => scoreAccount(transaction, account))
    .sort((left, right) => right.total - left.total || left.account.id.localeCompare(right.account.id));
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.lexical === 0) {
    return {
      decision: "needs_review",
      anomaly_type: "insufficient_account_evidence",
      candidates: [],
      reason: "no account keyword or meaningful name token matched the transaction",
    };
  }
  if (runnerUp && best.total === runnerUp.total) {
    return {
      decision: "needs_review",
      anomaly_type: "ambiguous_account",
      candidates: scored.filter((entry) => entry.total === best.total).map((entry) => entry.account.id),
      reason: "multiple accounts have the same best evidence score",
    };
  }

  const margin = best.total - (runnerUp?.total ?? 0);
  const confidence = Math.min(0.98, 0.55 + best.lexical * 0.07 + Math.min(margin, 4) * 0.05);
  const reasonParts = [];
  if (best.matched_keywords.length > 0) {
    reasonParts.push(`matched keywords: ${best.matched_keywords.join(", ")}`);
  }
  if (best.matched_name_tokens.length > 0) {
    reasonParts.push(`matched account-name tokens: ${best.matched_name_tokens.join(", ")}`);
  }
  if (best.direction_reason) {
    reasonParts.push(best.direction_reason);
  }
  return {
    decision: "categorized",
    account: best.account,
    confidence: Number(confidence.toFixed(2)),
    prior_period_match: false,
    reason: reasonParts.join("; "),
  };
}

function scoreAccount(transaction, account) {
  const matchedKeywords = account.keywords.filter((keyword) =>
    keyword.includes(" ")
      ? transaction.normalized_description.includes(keyword)
      : transaction.description_tokens.includes(keyword),
  );
  const matchedNameTokens = account.name_tokens.filter((token) =>
    transaction.description_tokens.includes(token),
  );
  const lexical = matchedKeywords.reduce((score, keyword) => score + (keyword.includes(" ") ? 4 : 3), 0)
    + matchedNameTokens.length;
  const direction = directionSupport(transaction.amount, account.type);
  return {
    account,
    lexical,
    total: lexical + (lexical > 0 ? direction.score : 0),
    matched_keywords: matchedKeywords,
    matched_name_tokens: matchedNameTokens,
    direction_reason: lexical > 0 ? direction.reason : null,
  };
}

function directionSupport(amount, accountType) {
  const revenueTypes = ["revenue", "income", "sales", "other income"];
  const expenseTypes = ["expense", "cost", "cost of goods sold", "cogs"];
  if (amount > 0 && revenueTypes.includes(accountType)) {
    return { score: 2, reason: `positive amount supports ${accountType}` };
  }
  if (amount < 0 && expenseTypes.includes(accountType)) {
    return { score: 2, reason: `negative amount supports ${accountType}` };
  }
  return { score: 0, reason: null };
}

function duplicateTransactionIndexes(transactions) {
  const signatures = new Map();
  transactions.forEach((transaction, index) => {
    if (!transaction || typeof transaction !== "object") {
      return;
    }
    const amount = Number(transaction.amount);
    const description = normalizeText(transaction.description ?? transaction.memo ?? "");
    if (!Number.isFinite(amount) || !description) {
      return;
    }
    const signature = [transaction.date ?? "", description, amount, transaction.currency ?? ""].join("|");
    const indexes = signatures.get(signature) ?? [];
    indexes.push(index);
    signatures.set(signature, indexes);
  });
  return new Set([...signatures.values()].filter((indexes) => indexes.length > 1).flat());
}

function meaningfulTokens(value) {
  return [...new Set(normalizeText(value).split(" ").filter((token) => token.length >= 3))];
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}
