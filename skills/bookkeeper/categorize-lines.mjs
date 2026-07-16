// Materialize admitted bindings without inventing accounts.
import { createHash } from "node:crypto";

function readInputs() {
  return JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, deepSort(value[key])]));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(deepSort(value))).digest("hex")}`;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeTransactions(transactions) {
  return transactions.map((item) => ({
    id: String(item.id).trim(),
    date: String(item.date).trim(),
    description: String(item.description).trim(),
    amount_minor: item.amount_minor,
    currency: String(item.currency).trim().toUpperCase(),
    counterparty: String(item.counterparty).trim(),
    source_ref: String(item.source_ref).trim(),
  }));
}

function normalizeChart(chart) {
  return chart.map((item) => ({
    code: String(item.code).trim(),
    name: String(item.name).trim(),
    type: String(item.type).trim().toLowerCase(),
    match: {
      direction: String(item.match.direction).trim().toLowerCase(),
      description_contains: (item.match.description_contains || []).map(normalizeText),
      counterparty_exact: (item.match.counterparty_exact || []).map(normalizeText),
    },
  }));
}

function fail(message) {
  process.stdout.write(`${JSON.stringify({ categorized_batch: { schema: "runx.bookkeeper.categorized_batch.v1", decision: "needs_review", reason: message } })}\n`);
  process.stderr.write(`runx.bookkeeper.binding.invalid: ${message}\n`);
  process.exitCode = 78;
}

function main() {
  const inputs = readInputs();
  const admission = inputs.admission;
  if (!admission || admission.schema !== "runx.bookkeeper.admission.v1" || admission.decision !== "ready") {
    fail("A ready source admission is required.");
    return;
  }
  if (
    !admission.controls?.source_fetch_performed
    || !admission.controls?.source_bytes_verified
    || !admission.source?.content_digest
    || !admission.source?.final_url
    || !Number.isInteger(admission.source?.status)
    || admission.source.status < 200
    || admission.source.status >= 300
    || admission.source?.exact_bytes_verified !== true
    || admission.source?.exact_hosts_only !== true
  ) {
    fail("Admission must prove an allowlisted runtime source fetch.");
    return;
  }
  const transactions = normalizeTransactions(admission.transactions || []);
  const chart = normalizeChart(admission.chart_of_accounts || []);
  if (digest(transactions) !== admission.transaction_digest || digest(chart) !== admission.chart_digest) {
    fail("Admitted transaction or chart bytes changed before categorization.");
    return;
  }
  const transactionById = new Map(transactions.map((item) => [item.id, item]));
  const accountByCode = new Map(chart.map((item) => [item.code, item]));
  const categorized = [];
  for (const assignment of admission.assignments || []) {
    const transaction = transactionById.get(assignment.transaction_id);
    const account = accountByCode.get(assignment.account_code);
    if (!transaction || !account) {
      fail(`Admitted binding ${assignment.transaction_id} -> ${assignment.account_code} does not resolve.`);
      return;
    }
    categorized.push({
      transaction_id: transaction.id,
      date: transaction.date,
      description: transaction.description,
      amount_minor: transaction.amount_minor,
      currency: transaction.currency,
      counterparty: transaction.counterparty,
      source_ref: transaction.source_ref,
      account_code: account.code,
      account_name: account.name,
      account_type: account.type,
      confidence: assignment.confidence,
      reason: assignment.reason,
      matched_evidence: assignment.matched_evidence,
      read_only: true,
    });
  }
  if (categorized.length !== transactions.length || new Set(categorized.map((item) => item.transaction_id)).size !== transactions.length) {
    fail("Categorization did not produce exactly one binding for every source transaction.");
    return;
  }

  const known = new Set(admission.anomaly_inputs?.known_counterparties || []);
  const averageAbs = admission.anomaly_inputs?.average_abs_amount_minor;
  const anomalies = [];
  for (const line of categorized) {
    if (known.size > 0 && !known.has(normalizeText(line.counterparty))) {
      anomalies.push({ type: "new_counterparty", severity: "low", transaction_id: line.transaction_id, reason: `${line.counterparty} was not present in prior_period.known_counterparties` });
    }
    if (Number.isSafeInteger(averageAbs) && Math.abs(line.amount_minor) > averageAbs * 4) {
      anomalies.push({ type: "amount_outlier", severity: "medium", transaction_id: line.transaction_id, reason: `absolute amount ${Math.abs(line.amount_minor)} exceeds four times prior average ${averageAbs}` });
    }
  }

  const batchBody = {
    schema: "runx.bookkeeper.categorized_batch.v1",
    decision: "categorized",
    categorized,
    anomalies,
    source: admission.source,
    source_refs: [...new Set(categorized.map((item) => item.source_ref))],
    account_universe: chart.map(({ code, name, type }) => ({ code, name, type })),
    transaction_digest: admission.transaction_digest,
    chart_digest: admission.chart_digest,
    prior_period_digest: admission.prior_period_digest,
    net_movement_minor: categorized.reduce((sum, item) => sum + item.amount_minor, 0),
    controls: {
      read_only: true,
      ledger_mutation_performed: false,
      invented_accounts: false,
      one_binding_per_transaction: true,
      source_fetch_performed: true,
      source_bytes_verified: true,
    },
  };
  process.stdout.write(`${JSON.stringify({ categorized_batch: { ...batchBody, batch_digest: digest(batchBody) } })}\n`);
}

main();
