// Admit only sourced lines with unique existing-account bindings.
import { createHash } from "node:crypto";

const ACCOUNT_TYPES = new Set(["asset", "liability", "equity", "income", "expense"]);
const DIRECTIONS = new Set(["inflow", "outflow", "any"]);

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

function safeString(value, field, min = 1, max = 160) {
  const text = String(value || "").trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f]/.test(text)) {
    throw new Error(`${field} must contain ${min}-${max} printable characters.`);
  }
  return text;
}

function sourceRef(value, field) {
  const ref = safeString(value, field, 8, 500);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) throw new Error(`${field} must be an absolute source URI.`);
  return ref;
}

function directionFor(amountMinor) {
  return amountMinor > 0 ? "inflow" : "outflow";
}

function normalizedMatcherList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${field} must be an array with at most 12 items.`);
  return value.map((item, index) => normalizeText(safeString(item, `${field}[${index}]`, 2, 64)));
}

function accountCandidate(transaction, account) {
  const direction = directionFor(transaction.amount_minor);
  if (account.match.direction !== "any" && account.match.direction !== direction) return null;
  const description = normalizeText(transaction.description);
  const counterparty = normalizeText(transaction.counterparty);
  const descriptionEvidence = account.match.description_contains.filter((phrase) => description.includes(phrase));
  const counterpartyEvidence = account.match.counterparty_exact.filter((name) => counterparty === name);
  const score = descriptionEvidence.length * 2 + counterpartyEvidence.length * 3;
  if (score === 0) return null;
  return {
    account_code: account.code,
    score,
    description_evidence: descriptionEvidence,
    counterparty_evidence: counterpartyEvidence,
  };
}

function emitNeedsReview(inputs, diagnostics, reviewItems = []) {
  const admission = {
    schema: "runx.bookkeeper.admission.v1",
    decision: "needs_review",
    diagnostics,
    needs_review: reviewItems,
    controls: {
      read_only: true,
      ledger_mutation_performed: false,
      invented_accounts: false,
    },
  };
  process.stdout.write(`${JSON.stringify({ admission })}\n`);
  if (diagnostics[0]) process.stderr.write(`${diagnostics[0].id}: ${diagnostics[0].message}\n`);
}

function main() {
  const inputs = readInputs();
  try {
    const transactions = inputs.transactions;
    const chart = inputs.chart_of_accounts;
    const prior = inputs.prior_period;
    if (!Array.isArray(transactions) || transactions.length < 1 || transactions.length > 100) {
      throw new Error("transactions must contain 1-100 sourced lines.");
    }
    if (!Array.isArray(chart) || chart.length < 1 || chart.length > 100) {
      throw new Error("chart_of_accounts must contain 1-100 existing accounts.");
    }
    if (!prior || typeof prior !== "object" || Array.isArray(prior)) {
      throw new Error("prior_period must be an object.");
    }

    const currency = safeString(prior.currency, "prior_period.currency", 3, 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("prior_period.currency must be an ISO-like three-letter code.");
    for (const field of ["opening_balance_minor", "expected_ending_balance_minor"]) {
      if (!Number.isSafeInteger(prior[field])) throw new Error(`prior_period.${field} must be a safe integer.`);
    }
    const previousIds = new Set(Array.isArray(prior.previous_transaction_ids) ? prior.previous_transaction_ids.map(String) : []);
    const knownCounterparties = new Set(Array.isArray(prior.known_counterparties) ? prior.known_counterparties.map(normalizeText) : []);
    const averageAbs = prior.average_abs_amount_minor;
    if (averageAbs !== undefined && (!Number.isSafeInteger(averageAbs) || averageAbs <= 0)) {
      throw new Error("prior_period.average_abs_amount_minor must be a positive safe integer when supplied.");
    }

    const codes = new Set();
    const normalizedChart = chart.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`chart_of_accounts[${index}] must be an object.`);
      const code = safeString(raw.code, `chart_of_accounts[${index}].code`, 1, 32);
      if (codes.has(code)) throw new Error(`chart_of_accounts contains duplicate code ${code}.`);
      codes.add(code);
      const name = safeString(raw.name, `chart_of_accounts[${index}].name`, 2, 100);
      const type = String(raw.type || "").trim().toLowerCase();
      if (!ACCOUNT_TYPES.has(type)) throw new Error(`chart_of_accounts[${index}].type is unsupported.`);
      if (!raw.match || typeof raw.match !== "object" || Array.isArray(raw.match)) {
        throw new Error(`chart_of_accounts[${index}].match must be an object.`);
      }
      const direction = String(raw.match.direction || "").trim().toLowerCase();
      if (!DIRECTIONS.has(direction)) throw new Error(`chart_of_accounts[${index}].match.direction is unsupported.`);
      const descriptionContains = normalizedMatcherList(raw.match.description_contains, `chart_of_accounts[${index}].match.description_contains`);
      const counterpartyExact = normalizedMatcherList(raw.match.counterparty_exact, `chart_of_accounts[${index}].match.counterparty_exact`);
      if (descriptionContains.length + counterpartyExact.length === 0) {
        throw new Error(`chart_of_accounts[${index}].match needs deterministic evidence.`);
      }
      return {
        code,
        name,
        type,
        match: { direction, description_contains: descriptionContains, counterparty_exact: counterpartyExact },
      };
    });

    const ids = new Set();
    const normalizedTransactions = transactions.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`transactions[${index}] must be an object.`);
      const id = safeString(raw.id, `transactions[${index}].id`, 1, 100);
      if (ids.has(id)) throw new Error(`transactions contains duplicate id ${id}.`);
      ids.add(id);
      if (previousIds.has(id)) throw new Error(`transaction ${id} already appears in prior_period.previous_transaction_ids.`);
      const date = safeString(raw.date, `transactions[${index}].date`, 10, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        throw new Error(`transactions[${index}].date must be a real YYYY-MM-DD date.`);
      }
      const description = safeString(raw.description, `transactions[${index}].description`, 2, 240);
      if (!Number.isSafeInteger(raw.amount_minor) || raw.amount_minor === 0) {
        throw new Error(`transactions[${index}].amount_minor must be a non-zero safe integer.`);
      }
      const lineCurrency = safeString(raw.currency, `transactions[${index}].currency`, 3, 3).toUpperCase();
      if (lineCurrency !== currency) throw new Error(`transaction ${id} currency ${lineCurrency} differs from prior_period currency ${currency}.`);
      const counterparty = safeString(raw.counterparty, `transactions[${index}].counterparty`, 1, 120);
      return {
        id,
        date,
        description,
        amount_minor: raw.amount_minor,
        currency: lineCurrency,
        counterparty,
        source_ref: sourceRef(raw.source_ref, `transactions[${index}].source_ref`),
      };
    });

    const assignments = [];
    const reviewItems = [];
    for (const transaction of normalizedTransactions) {
      const candidates = normalizedChart
        .map((account) => accountCandidate(transaction, account))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.account_code.localeCompare(b.account_code));
      if (candidates.length === 0 || (candidates[1] && candidates[0].score === candidates[1].score)) {
        reviewItems.push({
          transaction_id: transaction.id,
          reason: candidates.length === 0 ? "no_existing_account_match" : "ambiguous_existing_account_match",
          candidate_account_codes: candidates.filter((item) => !candidates[0] || item.score === candidates[0].score).map((item) => item.account_code),
        });
        continue;
      }
      const winner = candidates[0];
      const matchedEvidence = [
        ...winner.counterparty_evidence.map((value) => `counterparty_exact:${value}`),
        ...winner.description_evidence.map((value) => `description_contains:${value}`),
      ];
      assignments.push({
        transaction_id: transaction.id,
        account_code: winner.account_code,
        confidence: winner.score >= 5 ? 0.99 : winner.score >= 3 ? 0.95 : 0.9,
        matched_evidence: matchedEvidence,
        reason: `unique existing-account match ${winner.account_code} using ${matchedEvidence.join(", ")}`,
      });
    }

    if (reviewItems.length > 0) {
      emitNeedsReview(inputs, [{ id: "runx.bookkeeper.account_binding.needs_review", severity: "error", message: `${reviewItems.length} transaction(s) lack a unique existing-account binding.` }], reviewItems);
      return;
    }

    const admission = {
      schema: "runx.bookkeeper.admission.v1",
      decision: "ready",
      transaction_digest: digest(normalizedTransactions),
      chart_digest: digest(normalizedChart),
      prior_period_digest: digest(prior),
      currency,
      assignments,
      source_refs: normalizedTransactions.map((item) => item.source_ref),
      anomaly_inputs: {
        known_counterparties: [...knownCounterparties],
        average_abs_amount_minor: averageAbs ?? null,
      },
      controls: {
        read_only: true,
        ledger_mutation_performed: false,
        invented_accounts: false,
        unique_binding_required: true,
      },
      diagnostics: [],
    };
    process.stdout.write(`${JSON.stringify({ admission })}\n`);
  } catch (error) {
    emitNeedsReview(inputs, [{ id: "runx.bookkeeper.input.needs_review", severity: "error", message: error instanceof Error ? error.message : String(error) }]);
  }
}

main();
