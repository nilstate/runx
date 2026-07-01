---
name: flaky-test-judge
description: Judge supplied test-run history and emit a bounded flaky-test disposition without mutating a repository.
runx:
  category: ops
---

# Flaky Test Judge

Decide whether one test should be quarantined temporarily, treated as
environmental noise, fixed as a real bug, or escalated for human review.

The skill reads only the supplied run history, test metadata, and release
policy. It emits a `runx.flaky.test_triage.v1` handoff packet. It never edits a
test, changes CI configuration, opens an issue, or starts a pull request.

## Inputs

- `test_run_history`: ordered `runs` containing `status`, `duration`, and
  `logs`, plus the declared `sample_size`, `window_start`, and `window_end`.
- `test_metadata`: `test_path`, `suite`, and optional `tags`.
- `release_policy`: `flake_threshold_pct`, `min_sample_size`, and
  `max_quarantine_days`.

## Evidence calculation

1. Count only supplied runs.
2. Verify `sample_size` equals the number of supplied runs.
3. Compute pass rate as `passing runs / total runs * 100`.
4. Count failure modes only when their evidence is visible in supplied logs.
5. Cite run indexes or exact log fragments for every failure-mode claim.

Do not infer hidden retries, infrastructure incidents, or product defects.

## Disposition rules

- **Stop:** no run history, a sample-size mismatch, or fewer runs than
  `min_sample_size`. Use a `missing-evidence` reason and emit no quarantine
  packet.
- **Keep enabled:** pass rate is at or above `flake_threshold_pct`. Refuse to
  quarantine.
- **Human review:** evidence is near the threshold, failure modes conflict, or
  logs do not distinguish environmental noise from a real break.
- **Fix now:** supplied evidence consistently identifies a reproducible product
  or test defect rather than intermittent environmental behavior.
- **Ignore environmental noise:** failures are clearly external and policy
  allows no repository action.
- **Quarantine:** pass rate is below the policy threshold, the sample is
  sufficient, intermittent failure evidence is explicit, and a bounded
  temporary exclusion is justified.

Confidence must reflect the supplied evidence. A classification cannot exceed
the strength of its cited logs.

## Quarantine packet

When quarantine is justified, include:

```yaml
schema: runx.flaky.test_triage.v1
disposition:
  decision: quarantine
  confidence: 0.96
  reason: 65% pass rate over 20 runs; six of seven failures are explicit timeouts.
quarantine:
  test_path: tests/integration/test_checkout.py::test_retries_expired_session
  duration_days: 7
  exclusion_marker: '@pytest.mark.skip(reason="quarantined: tracked flaky timeout")'
  fix_template:
    thread_title: Fix flaky checkout retry timeout
    thread_body: >
      Temporarily exclude the named test, preserve the cited run evidence, and
      remove the exclusion when the timeout cause is fixed.
    target_repo: example/project
    base: main
escalation:
  required: false
  lane: human_review
  reason: ""
dispatch_target: issue-to-pr
```

`duration_days` must be positive and must never exceed
`release_policy.max_quarantine_days`. The packet names `issue-to-pr` only as a
downstream dispatch target. A separate governed run must map the fix template
to `thread_title`, `thread_body`, `target_repo`, and `base`.

The downstream run drafts the change. A human merge gate is the only path to a
live test disable.

## Refusal and escalation

- Refuse quarantine when the pass rate is at or above the threshold.
- Stop when no runs are supplied or the sample is below policy minimum.
- Escalate near-threshold or conflicting evidence.
- Never invent a failure mode absent from the logs.
- Never exceed the quarantine duration ceiling.
- Never mutate a repository or consume the handoff as an effect.
- Emit no mint, `AttenuationRequest`, data-store operation, or
  `operational_proposal.v1`.

## Evidence

Record:

- disposition decision, confidence, and reason;
- pass rate, run count, and sample window;
- failure-mode counts and cited run evidence;
- quarantine duration and exclusion marker when present;
- refusal or escalation reason;
- dispatch target;
- harness case names;
- sealed receipt id.

## Local verification

```bash
runx --version
runx harness ./skills/flaky-test-judge
```

The inline harness contains exactly two cases:

- `quarantine_justified`: 13 passes and 7 failures over 20 runs, including 6
  explicit timeouts, produce a bounded quarantine packet.
- `missing_run_history`: no runs produce a sealed missing-evidence stop with no
  quarantine packet.

After publishing:

```bash
runx add <owner>/flaky-test-judge@0.1.0
runx skill <owner>/flaky-test-judge@0.1.0 --json
runx verify --receipt <receipt.json> --json
```
