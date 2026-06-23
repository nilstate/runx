import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

runCase("contract review extracts clauses and redlines playbook risks", {
  input: {
    contract: {
      id: "msa-acme-2026",
      clauses: [
        {
          id: "c1",
          type: "termination",
          title: "Termination for Convenience",
          text: "Either party may terminate this Agreement with 90 days notice.",
        },
        {
          id: "c2",
          type: "liability",
          title: "Limitation of Liability",
          text: "Supplier liability is uncapped for all damages.",
        },
      ],
    },
    playbook: {
      id: "legal-playbook-2026-06",
      rules: [
        {
          id: "term-notice-max-30",
          clause_type: "termination",
          description: "Termination for convenience must not require more than 30 days notice.",
          max_notice_days: 30,
          severity: "medium",
          recommendation: "Change notice period to 30 days or less.",
        },
        {
          id: "liability-cap-required",
          clause_type: "liability",
          description: "Liability must be expressly capped.",
          requires_liability_cap: true,
          severity: "high",
          recommendation: "Add a negotiated liability cap.",
        },
      ],
    },
  },
  assertOutput(output) {
    assert.equal(output.decision.status, "reviewed");
    assert.equal(output.clauses.length, 2);
    assert.equal(output.redlines.length, 2);
    assert.equal(output.redlines[0].clause_id, "c1");
    assert.match(output.redlines[0].citation.clause_text, /90 days/);
    assert.match(output.redlines[0].citation.playbook_rule, /30 days/);
    assert.equal(output.risk_summary.level, "high");
    assert.equal(output.risk_summary.no_effects_emitted, true);
  },
});

runCase("non-contract input is refused", {
  input: {
    contract: {
      id: "random-note",
      text: "Please summarize this lunch menu and draft a friendly reply.",
    },
    playbook: {
      id: "legal-playbook-2026-06",
      rules: [
        {
          id: "term-notice-max-30",
          clause_type: "termination",
          max_notice_days: 30,
        },
      ],
    },
  },
  assertOutput(output) {
    assert.equal(output.decision.status, "refused");
    assert.deepEqual(output.clauses, []);
    assert.deepEqual(output.redlines, []);
    assert.equal(output.risk_summary.read_only, true);
  },
});

console.log("contract-review tests passed");

function runCase(name, { input, assertOutput }) {
  const result = spawnSync(process.execPath, [join(here, "run.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      RUNX_INPUTS_JSON: JSON.stringify(input),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${name} exited with ${result.status}: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assertOutput(output);
}
