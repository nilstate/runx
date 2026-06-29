# list-hygiene-judge evidence report

This package adds a graph-runner skill for the Frantic `list hygiene judge` bounty.

## Implemented

- `skills/list-hygiene-judge/SKILL.md`
- `skills/list-hygiene-judge/X.yaml`
- `skills/list-hygiene-judge/fixtures/sealed_decay_re_permission.yaml`
- `skills/list-hygiene-judge/fixtures/sealed_hard_bounce_suppress.yaml`
- `skills/list-hygiene-judge/fixtures/stop_missing_or_stale_evidence.yaml`
- `skills/list-hygiene-judge/evidence/evidence.json`
- `skills/list-hygiene-judge/evidence/verification.json`

## Behavior

- `hard_bounces > 0` chooses `decision.state = suppress` and appends one event.
- stale engagement beyond `decay_threshold_days` chooses `decision.state = re_permission` and appends one event.
- stale/missing/ambiguous evidence chooses `decision.state = human_review` and appends no event.
- active unsubscribe, stale expected version, and missing evidence are stop lanes.
- the graph does not mint a grant, does not send outbound messages, and does not return an `operational_proposal`.

## Validation

- `runx --version`: `runx-cli 0.6.14`
- `git diff --check -- skills/list-hygiene-judge`: passed
- hidden/bidi/control-character scan: passed
- graph execution observed expected decisions and append counts for all three required cases.

## Local Windows blocker

On this Windows machine, the final native harness receipt-store readback fails with:

```text
receipt store is unreadable: The parameter is incorrect. (os error 87)
```

The same error reproduces on the upstream `skills/data-store` harness, so this appears to be an upstream native Windows receipt-store issue rather than package logic. The graph-state evidence still shows the required case decisions and append counts before the receipt-store summary read fails.

