// Emit only after the reconciliation consumer proves a complete match.
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
  const reconciliation = inputs.reconciliation_packet;
  if (!batch || batch.decision !== "categorized" || !reconciliation || reconciliation.decision !== "reconciled") {
    process.stderr.write("runx.bookkeeper.emit.denied: consumer-verified reconciliation is required.\n");
    process.exitCode = 78;
    return;
  }
  if (reconciliation.consumed_batch_digest !== batch.batch_digest) {
    process.stderr.write("runx.bookkeeper.emit.binding.invalid: reconciliation consumed a different batch.\n");
    process.exitCode = 78;
    return;
  }
  const resultBody = {
    schema: "runx.bookkeeper.result.v1",
    status: "reconciled",
    categorized: batch.categorized,
    anomalies: batch.anomalies,
    reconciliation: reconciliation.reconciliation,
    source: reconciliation.source,
    source_refs: batch.source_refs,
    controls: {
      read_only: true,
      ledger_mutation_performed: false,
      invented_accounts: false,
      categorized_batch_digest: batch.batch_digest,
      reconciliation_digest: reconciliation.reconciliation_digest,
      consumer_step: reconciliation.consumer.step,
      source_fetch_performed: reconciliation.consumer.source_fetch_verified === true,
      source_bytes_verified: reconciliation.consumer.source_bytes_verified === true,
      posting_authority: "none",
    },
  };
  process.stdout.write(`${JSON.stringify({ bookkeeper_result: { ...resultBody, artifact_digest: digest(resultBody) } })}\n`);
}

main();
