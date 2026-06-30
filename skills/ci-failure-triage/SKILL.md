---
name: ci-failure-triage
description: Classify CI failures as flake, infra, real-break, dep, or needs_agent and emit a read-only routing packet.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - ci
    - triage
    - incident-response
links:
  source: https://github.com/jaasieldelgado131/runx
---

# CI Failure Triage

## What this skill does

This skill reads a bounded CI failure snapshot and emits a typed
`runx.ci.triage.v1` packet. It classifies the failure as `flake`, `infra`,
`real-break`, `dep`, or `unknown`, attaches cited evidence from the supplied
logs, and returns exactly one read-only consequence when the evidence is strong
enough:

- a read-only rerun verdict for a flake,
- a read-only operator page note for infrastructure failure, or
- a routing decision for `issue-to-pr` when the failure is a real break or
  dependency break.

The skill never opens an issue, reruns CI, pages an operator, mints authority,
or claims that a downstream lane has consumed its output. A downstream
`issue-intake`, `issue-to-pr`, or `pr-review-note` run is the separate governed
step that may act on the packet.

## When to use this skill

Use it at the first decision point after a CI job fails and before opening a
tracking item. It is intended for public CI logs or explicitly authorized
operator logs where a reviewer needs a quick, bounded classification with
evidence citations and a conservative escalation path.

## When not to use this skill

Do not use it to mutate repository state, retry CI, page a human, open a bug,
or infer root cause from thin logs. Do not feed it private secrets, tokens,
customer data, or logs that are not authorized for the reviewer. If logs are
truncated, contradictory, or below the configured confidence threshold, the
skill returns `needs_agent` without a routing decision.

## Inputs

- `ci_failure`: object with `logs`, `commit`, and `repo_state`.
- `repo_config`: optional repository context such as default branch and test
  command.
- `escalation_policy`: optional object with `min_confidence` for emitting a
  routing decision.
- `output_dir`: optional directory inside the skill directory for
  `triage-packet.json` and `report.md`.

## Procedure

1. Normalize the CI failure, repository config, and escalation policy.
2. Extract short evidence references from the supplied log lines.
3. Score visible signals for `real-break`, `dep`, `infra`, and `flake`.
4. Refuse to route when logs are absent, truncated, contradictory, or below
   `min_confidence`.
5. Emit the read-only triage packet with cited evidence and one bounded
   consequence when confidence clears the threshold.
6. Optionally write the packet and a Markdown report under `output_dir`.

## Stop conditions

- Missing or very short logs return `needs_agent`.
- Truncated logs return `needs_agent`.
- Tied evidence between failure classes returns `needs_agent`.
- Confidence below `escalation_policy.min_confidence` returns `needs_agent`.
- No visible evidence for the selected class returns `needs_agent`.

## Output

The primary output is `triage_packet`:

```json
{
  "schema": "runx.ci.triage.v1",
  "status": "sealed",
  "classification": {
    "verdict": "real-break",
    "confidence": 0.85,
    "evidence_refs": []
  },
  "triage_packet": {
    "routing_decision": {
      "recommended_lane": "issue-to-pr",
      "rationale": "clear code/test failure visible in logs"
    }
  }
}
```

For ambiguous failures, `status` is `needs_agent` and
`routing_decision` is `null`.

## Harness cases

- `real_break_clear_logs`: clear test failure logs produce
  `classification.verdict=real-break` and `recommended_lane=issue-to-pr`.
- `ambiguous_truncated_logs`: truncated logs stop with `needs_agent` and no
  routing decision.
