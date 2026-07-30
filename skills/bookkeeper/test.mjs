import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  transformFranticReceipt,
  validateReceiptUrl,
} from "./frantic-receipts.mjs";

const skillDir = dirname(fileURLToPath(import.meta.url));

const clean = runFixture("clean-batch.json", 0);
assert.equal(clean.decision, "ready");
assert.equal(clean.categorized.length, 3);
assert.deepEqual(clean.anomalies, []);
assert.deepEqual(clean.needs_review, []);
assert.deepEqual(clean.reconciliation, {
  matched: 3,
  unmatched: 0,
  total: 3,
  prior_period_matches: 0,
  debits: 185,
  credits: 300,
  net: 115,
});
assert.deepEqual(
  clean.categorized.map((entry) => entry.account_id),
  ["4000", "6100", "6200"],
);
for (const entry of clean.categorized) {
  assert.equal(typeof entry.confidence, "number");
  assert.ok(entry.confidence >= 0 && entry.confidence <= 1);
  assert.ok(entry.reason.length > 0);
}

const ambiguous = runFixture("ambiguous-batch.json", 2);
assert.equal(ambiguous.decision, "needs_review");
assert.deepEqual(ambiguous.categorized, []);
assert.equal(ambiguous.needs_review.length, 1);
assert.equal(ambiguous.anomalies[0].type, "ambiguous_account");
assert.deepEqual(ambiguous.anomalies[0].candidates, ["6000", "6200"]);
assert.deepEqual(ambiguous.reconciliation, {
  matched: 0,
  unmatched: 1,
  total: 1,
  prior_period_matches: 0,
  debits: 500,
  credits: 0,
  net: -500,
});

const allowedAccounts = new Set(["6000", "6200"]);
for (const entry of ambiguous.categorized) {
  assert.ok(allowedAccounts.has(entry.account_id), "runner invented a GL account");
}

const receiptBody = JSON.stringify({
  ok: true,
  receipt: {
    ref: "frantic:receipt:test",
    published_at: "2026-07-12T03:43:49.746Z",
    payload: {
      effect: {
        kind: "posting.funded",
        posting_id: "p-test",
        currency: "USD",
        fee_cents: 80,
        worker_liability_cents: 800,
        occurred_at: "2026-07-12T03:43:49.746Z",
      },
    },
  },
});
const transformedReceipt = transformFranticReceipt(
  JSON.parse(receiptBody),
  "https://gofrantic.com/v1/receipts/test",
  receiptBody,
);
assert.deepEqual(transformedReceipt.transactions, [
  {
    id: "frantic:receipt:test:worker-liability",
    date: "2026-07-12",
    description: "Frantic p-test worker liability funded",
    amount: 8,
    currency: "USD",
  },
  {
    id: "frantic:receipt:test:posting-fee",
    date: "2026-07-12",
    description: "Frantic p-test demand-side posting fee",
    amount: -0.8,
    currency: "USD",
  },
]);
assert.match(transformedReceipt.source.sha256, /^[0-9a-f]{64}$/);
assert.throws(
  () => validateReceiptUrl("https://example.com/v1/receipts/test"),
  /outside the allowlisted Frantic endpoint/,
);

process.stdout.write("bookkeeper fixture tests passed\n");

function runFixture(name, expectedStatus) {
  const fixturePath = join(skillDir, "fixtures", name);
  const execution = spawnSync(process.execPath, [join(skillDir, "run.mjs")], {
    cwd: skillDir,
    env: { ...process.env, RUNX_INPUTS_PATH: fixturePath },
    encoding: "utf8",
  });
  assert.equal(execution.status, expectedStatus, execution.stderr || execution.stdout);
  return JSON.parse(execution.stdout);
}
