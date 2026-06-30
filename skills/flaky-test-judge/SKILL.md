---
name: flaky-test-judge
description: Read test-run history and release policy, then decide whether a flaky test should be temporarily quarantined, stopped for missing evidence, or refused as above-threshold.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  test_run_history:
    type: json
    required: true
    description: "Run history shaped as {runs:[{status,duration,logs}],sample_size}."
  test_metadata:
    type: json
    required: true
    description: "Test metadata shaped as {test_path,suite,tags}."
  release_policy:
    type: json
    required: true
    description: "Release policy shaped as {flake_threshold_pct,min_sample_size,max_quarantine_days}."
runx:
  input_resolution:
    required:
      - test_run_history
      - test_metadata
      - release_policy
  artifacts:
    wrap_as: flaky_test_triage
    packet: runx.flaky.test_triage.v1
---

# Flaky Test Judge

`flaky-test-judge` is a pure read-only triage skill for release operators. It
reads supplied test-run history, test metadata, and a release policy, computes
the observed pass rate and failure modes from the provided logs, then emits a
typed `runx.flaky.test_triage.v1` disposition.

It never edits the repository, never disables a test, never mints authority,
and never starts a PR run. When quarantine is justified it emits a data packet
that names the separate downstream `issue-to-pr` handoff target; an operator or
driver must invoke that governed run separately, and the human merge gate on the
draft PR is the only path to a live disable.

## Inputs

- `test_run_history`: `{ runs: [{ status, duration, logs }], sample_size }`
- `test_metadata`: `{ test_path, suite, tags }`
- `release_policy`: `{ flake_threshold_pct, min_sample_size, max_quarantine_days }`

## Output

The skill emits:

- `disposition`: `{ decision, confidence, reason }`
- `quarantine_packet`: only when quarantine is justified; includes
  `test_path`, bounded `duration_days`, `fix_template`, and
  `exclusion_marker`
- `escalation`: human lane guidance when evidence is missing or near-threshold
- `dispatch_target`: a dispatch-by-naming target for `issue-to-pr`, not an
  in-graph effect
- `evidence`: pass-rate, cited run count, policy values, and failure-mode counts

## Decision rules

1. Refuse to quarantine when no run history is supplied.
2. Refuse to quarantine when the observed sample is below
   `release_policy.min_sample_size`.
3. Refuse to quarantine when the pass rate is at or above
   `release_policy.flake_threshold_pct`.
4. Quarantine only when the sample is sufficient, pass rate is below threshold,
   and failure modes are grounded in the supplied logs.
5. Cap any proposed quarantine duration at
   `release_policy.max_quarantine_days`.
6. Never invent a failure mode absent from the logs.

## Harness

The inline harness declares exactly two cases:

- `quarantine_justified`: 13 passes out of 20 runs (65%) with 6 timeout failures
  out of 7 total failures against a 70% threshold. The result is
  `disposition.decision = quarantine`, a bounded quarantine packet, and a
  dispatch target naming `issue-to-pr`.
- `missing_run_history`: no run history. The run seals a stop disposition with
  a missing-evidence reason and no quarantine packet.

## Example local run

```bash
runx harness ./skills/flaky-test-judge
runx skill ./skills/flaky-test-judge --json \
  --input-json test_run_history='{"sample_size":0,"runs":[]}' \
  --input-json test_metadata='{"test_path":"tests/no-history.spec.ts","suite":"release","tags":[]}' \
  --input-json release_policy='{"flake_threshold_pct":70,"min_sample_size":20,"max_quarantine_days":10}'
```
