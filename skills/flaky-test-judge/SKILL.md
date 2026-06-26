---
name: flaky-test-judge
description: Judge flaky test run history and emit a bounded quarantine or stop packet.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  test_run_history:
    type: json
    required: true
    description: Runs with status, duration, and logs plus the declared sample size.
  test_metadata:
    type: json
    required: true
    description: Test path, suite, tags, and optional repository routing hints.
  release_policy:
    type: json
    required: true
    description: Flake threshold, minimum sample size, and maximum quarantine days.
runx:
  category: quality
  input_resolution:
    required:
      - test_run_history
      - test_metadata
      - release_policy
---

# flaky-test-judge

`flaky-test-judge` turns supplied test-run evidence into a deterministic
`runx.flaky.test_triage.v1` packet. It does not mutate a repository, open an
issue, disable a test, call a downstream graph, mint anything, or use a data
store. Its only job is to decide whether the evidence justifies a bounded
quarantine proposal and to name the downstream lane an operator may run next.

## When To Use

Use this skill after a CI system, test dashboard, or operator has already
provided a bounded run history for one test. The caller supplies:

- `test_run_history`: `runs[{status,duration,logs}]` and `sample_size`.
- `test_metadata`: `test_path`, `suite`, `tags`, plus optional `target_repo`
  and `base` routing hints.
- `release_policy`: `flake_threshold_pct`, `min_sample_size`, and
  `max_quarantine_days`.

The skill computes pass rate, failure-mode counts, evidence sufficiency, and a
policy-capped quarantine duration. When quarantine is justified it emits a
packet shaped for an offline `issue-to-pr` leg. A separate governed run must
open the issue/PR, and a human merge gate is the only path to a live disable.

## Stop Conditions

The judge stops without a quarantine packet when:

- no run history is supplied;
- `sample_size` is below `min_sample_size`;
- the pass rate is at or above `flake_threshold_pct`;
- failures do not show a repeatable failure mode;
- a quarantine would exceed `max_quarantine_days`.

Stop decisions still seal successfully so the receipt records why the judge did
not propose a repo change.

## Output

The runner writes a single JSON packet to stdout:

```json
{
  "schema": "runx.flaky.test_triage.v1",
  "disposition": {
    "decision": "quarantine",
    "confidence": 0.86,
    "reason": "65% pass rate across 20 runs is below the 70% policy threshold; 6 of 7 failures are timeout failures."
  },
  "quarantine_packet": {
    "test_path": "tests/e2e/login.spec.ts",
    "duration_days": 3,
    "fix_template": "...",
    "exclusion_marker": "@flaky-quarantine:flaky-test-judge"
  },
  "escalation": {
    "lane": "human_merge_gate",
    "required": true
  },
  "dispatch_target": {
    "name": "issue-to-pr",
    "typed_inputs": {
      "thread_title": "...",
      "thread_body": "...",
      "target_repo": "owner/repo",
      "base": "main"
    }
  }
}
```

`quarantine_packet` is `null` whenever the decision is a stop or no-quarantine
result. The packet includes evidence observations for pass rate, run count,
failure-mode count, quarantine duration, exclusion marker, refused reason, and
the dispatch target.

