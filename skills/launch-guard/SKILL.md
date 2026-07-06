---
name: launch-guard
description: Gate a release candidate with grounded go/no-go readiness evidence.
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
  release_candidate:
    type: json
    required: true
    description: Version, diff ref, test results, rollback plan, observability plan, changelog, and open risks.
  launch_policy:
    type: json
    required: true
    description: Required checks, maximum open risk count, and whether rollback evidence is required.
runx:
  category: release
  input_resolution:
    required:
      - release_candidate
      - launch_policy
---

# launch-guard

`launch-guard` turns supplied release evidence into a deterministic
`runx.launch_guard.v1` readiness packet. It does not deploy, tag, publish,
announce, mutate a repository, call the `release` skill, or use a data store.
Its only job is to decide whether a release candidate is ready and, when it is,
emit a gated `release_proposal` for a separate human or governed release runner.

## When To Use

Use this skill after a release owner has gathered the release candidate,
required test results, rollback plan, observability plan, changelog, and launch
policy. The caller supplies:

- `release_candidate`: `version`, `diff_ref`, `test_results`,
  `rollback_plan`, `observability_plan`, `changelog`, and optional `risks`.
- `launch_policy`: `required_checks`, `max_open_risk`, and
  `rollback_required`.

The guard checks each policy requirement against concrete input evidence. A
`go` decision includes a readiness report and a gated proposal for the separate
release lane. A `no_go` decision includes exact blockers and no proposal.

## Refusal Conditions

The guard refuses to emit a `release_proposal` when:

- any required test check is missing or not passing;
- rollback evidence is required but missing or untested;
- observability evidence is missing required dashboards or alerts;
- the changelog is empty;
- open risk count exceeds `max_open_risk`.

No-go results still seal a receipt for review, but the runner exits as a
controlled refusal so harness and dogfood evidence can distinguish it from a
go result.

## Output

The runner writes one JSON packet:

```json
{
  "schema": "runx.launch_guard.v1",
  "decision": {
    "status": "go",
    "confidence": 0.9,
    "reason": "All required launch checks passed with one open risk within policy."
  },
  "readiness_report": {
    "checks": [],
    "risks": [],
    "blockers": []
  },
  "release_proposal": {
    "version": "2.4.0",
    "diff_ref": "compare/main...release-2.4.0",
    "consumed_by": "release",
    "gated": true
  }
}
```

`release_proposal` is `null` whenever the decision is `no_go`. Every readiness
check cites either a supplied test result or a policy requirement.
