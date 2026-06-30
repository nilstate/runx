import test from "node:test";
import assert from "node:assert/strict";
import { triage } from "../run.mjs";

test("clear real break emits issue-to-pr routing", () => {
  const packet = triage({
    ci_failure: {
      commit: "1".repeat(40),
      logs: [
        "npm test",
        "FAIL tests/parser.test.ts",
        "TypeError: Cannot read properties of undefined (reading 'items')",
        "Expected 3 received 2",
        "Tests failed in parser regression suite",
      ].join("\n"),
      repo_state: { branch: "main", changed_files: ["src/parser.ts"] },
    },
    repo_config: { default_branch: "main", test_command: "npm test" },
    escalation_policy: { min_confidence: 0.75 },
  });

  assert.equal(packet.status, "sealed");
  assert.equal(packet.classification.verdict, "real-break");
  assert.equal(packet.triage_packet.routing_decision.recommended_lane, "issue-to-pr");
  assert.equal(packet.triage_packet.rerun_verdict, null);
  assert.equal(packet.policy.no_tracking_item_opened, true);
});

test("ambiguous truncated logs stop without routing", () => {
  const packet = triage({
    ci_failure: {
      commit: "2".repeat(40),
      logs: "Error: job failed ... output truncated",
      repo_state: { branch: "main" },
    },
    repo_config: {},
    escalation_policy: { min_confidence: 0.75 },
  });

  assert.equal(packet.status, "needs_agent");
  assert.equal(packet.classification.verdict, "unknown");
  assert.equal(packet.triage_packet.routing_decision, null);
  assert.match(packet.triage_packet.escalation.reason, /truncated|too thin/i);
});

test("conflicting signals escalate instead of guessing", () => {
  const packet = triage({
    ci_failure: {
      commit: "3".repeat(40),
      logs: [
        "npm ERR! dependency resolution failed",
        "TypeError: Cannot read properties of undefined",
        "tests failed after package lockfile update",
        "dependency graph changed in this commit",
      ].join("\n"),
      repo_state: { branch: "main" },
    },
    repo_config: {},
    escalation_policy: { min_confidence: 0.75 },
  });

  assert.equal(packet.status, "needs_agent");
  assert.equal(packet.triage_packet.routing_decision, null);
});
