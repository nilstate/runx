#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const basePolicy = {
  cap: 3,
  escalation_lane: "ar-manager",
  steps: [
    { step: 1, min_aging_days: 7, channel: "email", content_digest: "first-notice-template" },
    { step: 2, min_aging_days: 14, channel: "email", content_digest: "second-notice-template" },
    { step: 3, min_aging_days: 21, channel: "email", content_digest: "final-notice-template" },
  ],
};

const withinCap = run({
  invoice_status: {
    invoice_id: "inv-2026-0601",
    status: "overdue",
    amount_due: 1840,
    currency: "USD",
    customer_ref: "acct-acme-legal",
    reminders_sent: 1,
  },
  aging_days: 22,
  cadence_policy: basePolicy,
});
assert.equal(withinCap.decision.status, "proposed");
assert.equal(withinCap.decision.step, 2);
assert.equal(withinCap.reminder_proposal.effect, "send-as");
assert.equal(withinCap.reminder_proposal.gated, true);
assert.equal(withinCap.reminder_proposal.sends_directly, false);
assert.equal(withinCap.reminder_proposal.content_digest, "second-notice-template");
assert.equal(withinCap.escalation.required, false);

const capReached = run({
  invoice_status: {
    invoice_id: "inv-2026-0520",
    status: "overdue",
    amount_due: 940,
    currency: "USD",
    customer_ref: "acct-northwind",
    reminders_sent: 3,
  },
  aging_days: 31,
  cadence_policy: basePolicy,
});
assert.equal(capReached.decision.status, "escalated");
assert.equal(capReached.reminder_proposal.content_digest, null);
assert.equal(capReached.escalation.required, true);
assert.equal(capReached.escalation.lane, "ar-manager");

const notOverdue = run({
  invoice_status: {
    invoice_id: "inv-2026-0608",
    status: "paid",
    reminders_sent: 0,
  },
  aging_days: 0,
  cadence_policy: basePolicy,
});
assert.equal(notOverdue.decision.status, "refused");
assert.equal(notOverdue.reminder_proposal.content_digest, null);

console.log("dunning-ladder tests passed");

function run(input) {
  const child = spawnSync(process.execPath, ["run.mjs"], {
    cwd: new URL(".", import.meta.url),
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
