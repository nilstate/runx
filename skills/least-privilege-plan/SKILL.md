---
name: least-privilege-plan
description: Recommend narrower grants from bounded run history and declared policy without mutating authority.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: security
---

# Least Privilege Plan

Recommend narrower grants from bounded run history and declared policy.

This skill reads a policy packet and run history, compares granted scopes with
observed effects, and emits `keep`, `reduce`, `revoke`, and
`needs_human_review` recommendations. It is read-only. It never mutates grants
or treats a recommendation as approval.

## What this skill does

1. Reads declared policy and bounded run history.
2. Compares each granted scope with observed effects.
3. Keeps scopes that are required by policy and observed.
4. Reduces broader scopes to narrower observed scopes when possible.
5. Revokes unused optional scopes.
6. Escalates ambiguous or high-risk grants to human review.

## When to use this skill

Use it before renewing a grant, promoting a skill to a higher trust tier, or
reviewing whether a worker still needs broad authority. It is useful when the
caller can provide receipt-derived effects and the declared policy that governed
the run history.

## When not to use this skill

Do not use it to mutate grants, inspect live secrets, or override policy. Do
not use it when no policy or run history is available; the skill returns
`needs_more_evidence` rather than inventing recommendations.

## Procedure

1. Parse `policy` and `run_history`.
2. Stop when either input is missing.
3. Normalize granted scopes, required scopes, and observed effects.
4. For each grant, emit `keep`, `reduce`, `revoke`, or `needs_human_review`.
5. Cite exact observed effects, policy requirements, unused scopes, or missing
   evidence for every recommendation.
6. Write `evidence.json` and `report.md` under `output_dir` when requested.

## Edge cases and stop conditions

- **Missing policy or history:** return `needs_more_evidence`.
- **Required scope with no observations:** emit `needs_human_review`, not
  `revoke`, because the policy says the scope may be necessary.
- **Observed narrower use:** emit `reduce` from broad write/spend/send scopes to
  read/quote/draft equivalents when the effect history supports it.
- **Unused optional scope:** emit `revoke`.
- **Unknown scope family:** emit `needs_human_review`.

## Output schema

```yaml
schema: runx.least_privilege_plan.v1
decision: ready | needs_more_evidence
policy_id: string
keep: []
reduce: []
revoke: []
needs_human_review: []
evidence:
  observed_effects: []
  unused_scopes: []
  missing_evidence: []
read_only: true
```

The same object is returned as `evidence_json`; `report_md` renders the plan for
review.

## Worked example

```bash
runx skill "$PWD/skills/least-privilege-plan" \
  --input policy='{"policy_id":"campaign-send-v1","required_scopes":["email:send"],"optional_scopes":["repo:write","payment:spend"]}' \
  --input run_history='[{"grant_id":"grant-1","granted_scopes":["email:send","repo:write","payment:spend"],"observed_effects":[{"scope":"email:send","operation":"send"},{"scope":"repo:read","operation":"read"}]}]' \
  --json
```

The output keeps `email:send`, reduces `repo:write` to `repo:read`, and revokes
unused `payment:spend`, with evidence for each recommendation.

## Inputs

- `policy`: required declared policy object.
- `run_history`: required bounded run records.
- `output_dir`: optional package-local artifact output directory.

## Outputs

- `least_privilege_plan`: complete recommendation packet.
- `evidence_json`: same packet as machine-checkable JSON.
- `report_md`: concise Markdown report.
