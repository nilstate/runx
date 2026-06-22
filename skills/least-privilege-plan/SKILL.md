---
name: least-privilege-plan
description: Produce a read-only least-privilege grant plan from bounded run history and a declared policy.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  input_mode: stdin
  cwd: .
  timeout_seconds: 30
inputs:
  run_history_packet:
    type: json
    required: true
    description: Bounded run history containing grants, observed effects, receipt refs, and missing-evidence notes.
  policy:
    type: json
    required: true
    description: Declared least-privilege policy with grant metadata, reserved scopes, and review rules.
  objective:
    type: string
    required: false
    description: Optional operator intent for the plan.
runx:
  category: security
  input_resolution:
    required:
      - run_history_packet
      - policy
---

# least-privilege-plan

Use this skill when an operator needs a read-only plan for narrowing granted
authority after one or more runs. The skill compares a bounded run history
packet against a declared policy and emits keep, reduce, revoke, and
needs_human_review recommendations with cited evidence.

The skill does not mutate grants, write credentials, call provider APIs, or infer
authority from broad task success. Every recommendation cites exact observed
effects, policy inputs, unused scopes, or missing evidence so a reviewer can
apply the plan separately.

## Inputs

- `run_history_packet`: bounded JSON with `subject`, `policy_id`, `grants`,
  `observed_effects`, `receipt_refs`, and optional `missing_evidence`.
- `policy`: declared JSON policy with grant metadata, reserved scopes, wildcard
  rules, and review thresholds.
- `objective`: optional operator intent.

## Output

The runner returns JSON with:

- `plan`: the typed least-privilege plan.
- `recommendations`: one recommendation per grant.
- `evidence_json`: a compact evidence object suitable for external review.
- `report`: a human-readable summary.

Recommendation actions are exactly `keep`, `reduce`, `revoke`, and
`needs_human_review`.
