// Consume categorized lines and independently recompute statement controls.
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

function main() {
  const inputs = readInputs();
  const batch = inputs.categorized_batch;
  const prior = inputs.prior_period;
  if (!batch || batch.schema !== "runx.bookkeeper.categorized_batch.v1" || batch.decision !== "categorized") {
    process.stderr.write("runx.bookkeeper.reconciliation.invalid: categorized batch is missing.\n");
    process.exitCode = 78;
    return;
  }
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) {
    process.stderr.write("runx.bookkeeper.reconciliation.invalid: admitted prior-period controls are missing.\n");
    process.exitCode = 78;
    return;
  }
  if (
    !batch.controls?.source_fetch_performed
    || !batch.controls?.source_bytes_verified
    || !batch.source?.content_digest
    || !batch.source?.final_url
    || !Number.isInteger(batch.source?.status)
    || batch.source.status < 200
    || batch.source.status >= 300
    || batch.source?.exact_bytes_verified !== true
    || batch.source?.exact_hosts_only !== true
  ) {
    process.stderr.write("runx.bookkeeper.reconciliation.invalid: runtime source-fetch evidence is missing.\n");
    process.exitCode = 78;
    return;
  }
  const accountCodes = new Set((batch.account_universe || []).map((item) => item.code));
  const matched = [];
  const unmatched = [];
  const seen = new Set();
  let netMovementMinor = 0;
  for (const line of batch.categorized || []) {
    if (seen.has(line.transaction_id)) {
      unmatched.push({ kind: "duplicate_consumer_line", transaction_id: line.transaction_id, reason: "consumer received the same source transaction more than once" });
      continue;
    }
    seen.add(line.transaction_id);
    if (!accountCodes.has(line.account_code)) {
      unmatched.push({ kind: "invented_account", transaction_id: line.transaction_id, account_code: line.account_code, reason: "account code is absent from the admitted chart" });
      continue;
    }
    if (!Number.isSafeInteger(line.amount_minor)) {
      unmatched.push({ kind: "invalid_amount", transaction_id: line.transaction_id, reason: "amount_minor is not a safe integer" });
      continue;
    }
    netMovementMinor += line.amount_minor;
    matched.push({
      transaction_id: line.transaction_id,
      source_ref: line.source_ref,
      account_code: line.account_code,
      amount_minor: line.amount_minor,
      evidence: "existing_account_binding_consumed",
    });
  }

  if (matched.length + unmatched.filter((item) => item.transaction_id).length !== (batch.categorized || []).length) {
    unmatched.push({ kind: "line_coverage", reason: "consumer line coverage differs from categorized batch length" });
  }
  const openingBalanceMinor = prior.opening_balance_minor;
  const expectedEndingBalanceMinor = prior.expected_ending_balance_minor;
  const calculatedEndingBalanceMinor = openingBalanceMinor + netMovementMinor;
  if (calculatedEndingBalanceMinor !== expectedEndingBalanceMinor) {
    unmatched.push({
      kind: "statement_balance",
      reason: "opening balance plus consumed transaction movement does not equal expected ending balance",
      expected_ending_balance_minor: expectedEndingBalanceMinor,
      calculated_ending_balance_minor: calculatedEndingBalanceMinor,
      difference_minor: calculatedEndingBalanceMinor - expectedEndingBalanceMinor,
    });
  }

  const decision = unmatched.length === 0 ? "reconciled" : "needs_review";
  const packetBody = {
    schema: "runx.bookkeeper.reconciliation_packet.v1",
    decision,
    reconciliation: {
      matched,
      unmatched,
      totals: {
        currency: String(prior.currency).toUpperCase(),
        opening_balance_minor: openingBalanceMinor,
        net_movement_minor: netMovementMinor,
        calculated_ending_balance_minor: calculatedEndingBalanceMinor,
        expected_ending_balance_minor: expectedEndingBalanceMinor,
      },
    },
    source: batch.source,
    consumed_batch_digest: batch.batch_digest,
    consumer: {
      step: "reconcile-readonly",
      recomputed_net_movement: true,
      verified_account_membership: true,
      verified_line_coverage: true,
      source_fetch_verified: true,
      source_bytes_verified: true,
      ledger_mutation_performed: false,
    },
  };
  process.stdout.write(`${JSON.stringify({ reconciliation_packet: { ...packetBody, reconciliation_digest: digest(packetBody) } })}\n`);
}

main();
