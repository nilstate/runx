#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const happy = run({
  prospect: {
    company: "Acme Logistics",
    contact: "VP Operations",
  },
  icp: {
    offer: "governed agent workflows for operations teams",
    pain: "manual exception handling across support and finance",
  },
  source_allowlist: ["acme.example"],
  sources: [
    {
      url: "https://acme.example/blog/exception-ops",
      title: "Exception operations update",
      excerpt: "Acme describes new SLA pressure from invoice and shipment exceptions.",
    },
    {
      url: "https://acme.example/news/finance-automation",
      title: "Finance automation note",
      excerpt: "The finance team is consolidating manual approval queues this quarter.",
    },
  ],
});
assert.equal(happy.decision.status, "sealed");
assert.equal(happy.research.sources.length, 2);
assert.match(happy.research.angle, /source-1/);
assert.equal(happy.sequence.length, 3);
assert.equal(happy.sequence[0].citations[0], "source-1");
assert.equal(happy.send_proposal.effect, "send-as");
assert.equal(happy.send_proposal.gated, true);
assert.equal(happy.send_proposal.sends_directly, false);

const noSources = run({
  prospect: { company: "PrivateCo", contact: "Revenue Operations" },
  icp: { offer: "governed outreach planning", pain: "unverified account context" },
  source_allowlist: ["private.example"],
  sources: [],
});
assert.equal(noSources.decision.status, "needs_agent");
assert.equal(noSources.sequence.length, 0);

const offAllowlist = run({
  prospect: { company: "Acme Logistics", contact: "VP Operations" },
  icp: { offer: "governed workflows", pain: "manual queues" },
  source_allowlist: ["acme.example"],
  sources: [
    {
      url: "https://evil.example/post",
      title: "Untrusted source",
      excerpt: "This source should not be used because its host is outside the allowlist.",
    },
  ],
});
assert.equal(offAllowlist.decision.status, "policy_denied");
assert.match(offAllowlist.decision.reasons[0], /outside source_allowlist/);

const privateHost = run({
  prospect: { company: "LocalCo", contact: "Ops" },
  icp: { offer: "governed workflows", pain: "manual queues" },
  source_allowlist: ["localhost"],
  sources: [
    {
      url: "http://localhost/private",
      title: "Private source",
      excerpt: "This local source must be refused before any synthesis occurs.",
    },
  ],
});
assert.equal(privateHost.decision.status, "policy_denied");
assert.match(privateHost.decision.reasons[0], /private-network/);

console.log("prospect-sequence tests passed");

function run(input) {
  const child = spawnSync(process.execPath, ["run.mjs"], {
    cwd: new URL(".", import.meta.url),
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
