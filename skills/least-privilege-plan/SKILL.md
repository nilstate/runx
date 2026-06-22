---
name: least-privilege-plan
description: Generate a least-privilege grant plan that compares declared grants against receipt-derived run history and produces the narrowest set of permissions that still covers real usage.
runx:
  category: security
---

# Least-Privilege Grant Plan

Produce a reviewable, evidence-grounded plan that narrows a set of declared
grants to the minimum permissions required by observed usage.

This skill reads a set of declared or proposed grants and compares them against
bounded, receipt-derived run history. It classifies each grant as `keep`,
`reduce`, `revoke`, or `needs_human_review`, then emits a structured plan with
evidence, rationale, and operational risk for every decision. The output is a
plan for a human reviewer — it never applies changes automatically.

## What this skill does

1. Accept declared grants and receipt-backed usage evidence.
2. Compare each declared grant against observed usage from receipts.
3. Classify every grant into one of four actions:
   - `keep` — observed usage requires the grant exactly as declared.
   - `reduce` — observed usage fits a strictly narrower permission.
   - `revoke` — no observed usage supports the grant.
   - `needs_human_review` — evidence is ambiguous, conflicting, or the grant
     carries policy or compliance constraints that require human judgment.
4. Produce a structured plan with per-grant evidence, rationale, and risk.
5. State residual risk after the proposed plan is applied.
6. Emit receipt expectations so downstream verification can confirm the plan.

## When to use this skill

- Before granting authority to a skill, principal, or service account, to
  verify that requested permissions are the minimum necessary.
- During periodic privilege review, to identify grants that can be safely
  narrowed or revoked based on actual usage patterns.
- After an incident, to produce an actionable remediation plan that removes
  unnecessary authority without breaking observed behavior.
- Before publishing or promoting a skill to wider distribution, to prove that
  its grant surface is minimal.

## When not to use this skill

- To expand or add new authority. This skill only narrows; widening is a human
  decision routed through the appropriate approval flow.
- When no receipt evidence exists. The skill returns `needs_more_evidence`
  rather than guessing grants down to nothing.
- For secret material handling or credential rotation. Use the appropriate
  secret-management or vault flow instead.
- When the operator wants automatic permission changes applied. This skill
  produces a plan and stops; a separate approved delivery lane must apply it.

## Procedure

1. Scope the plan target.
   - Identify `subject`, the grant source, the receipt window or receipt ids,
     and whether receipts are from the same principal or skill version.
   - Gate: if the subject, grant list, or usage source is ambiguous, stop with
     `needs_input`.

2. Normalize declared grants.
   - Parse each grant into action, resource, path or namespace, conditions, and
     wildcard breadth.
   - Preserve original grant strings. Do not rewrite policy syntax.
   - Gate: if a grant cannot be parsed, classify it as `needs_human_review` and
     request the missing policy semantics.

3. Build the usage model from receipts.
   - Extract actual exercised actions and resources from receipt steps, tool
     calls, policy checks, and completion status.
   - Count successful use separately from denied or dry-run checks.
   - Do not infer grant usage from a successful high-level task alone; cite the
     receipt step or policy check that exercised the authority.

4. Classify every declared grant.
   - `keep`: at least one observed successful use requires the grant as
     declared, or a reserved / break-glass policy explicitly requires it.
   - `reduce`: all observed uses fit a strictly smaller action, resource,
     namespace, condition, or path.
   - `revoke`: no observed use, denied check, or documented reserved purpose
     supports the grant.
   - `needs_human_review`: evidence is conflicting, receipt attribution is
     weak, or policy semantics are unknown.

5. Produce the grant plan.
   - For each grant, emit the proposed action, the evidence that supports it,
     the rationale, and the operational risk if the action is applied.
   - Aggregate into a planned grant set (the minimal set after applying all
     proposed actions).

6. State residual risk and reviewer action.
   - Name what the planned grant set can still do.
   - Name any broad grant kept despite thin evidence and why.
   - Separate `apply_now` from `needs_policy_decision`.

7. Emit receipt expectations.
   - A valid receipt for this skill should record input grant count, receipt
     sources, classification counts, proposed changes, stop status, and
     unresolved questions.

## Edge cases and stop conditions

- Empty or unattributable usage evidence: return `needs_more_evidence`; do not
  revoke all grants by default.
- Missing declared grants: return `needs_input`; there is no baseline to plan
  against.
- Receipt subject mismatch: return `needs_input` with the mismatched subject or
  version.
- Conflicting receipts: classify affected grants as `needs_human_review` and
  return `needs_human` if the conflict changes the plan.
- Wildcard grants: reduce only to observed resource prefixes when receipt
  coverage is representative; otherwise keep and flag residual risk.
- Reserved, compliance, or break-glass grants: keep unless the operator provides
  explicit policy authority to revoke them.
- Dry-run-only use: do not count as successful exercised authority unless the
  grant exists solely for validation.
- Grant already matches usage: return `no_change` with the evidence summary.
- User asks to hide or omit unused authority: refuse that part and report the
  complete grant diff.

## Output schema

Return a structured report with these fields:

```yaml
status: plan_proposed | no_change | needs_more_evidence | needs_input | needs_human | refused
subject: string
evidence:
  receipt_ids: [string]
  receipt_window: string | null
  grant_source: string | null
  limitations: [string]
grant_plan:
  - declared_grant: string
    normalized:
      action: string | null
      resource: string | null
      conditions: object | null
    observed_use:
      count: number
      actions: [string]
      resources: [string]
      receipt_refs: [string]
    classification: keep | reduce | revoke | needs_human_review
    proposed_grant: string | null
    rationale: string
    operational_risk: string
planned_grant_set: [string]
revoked_grants: [string]
reduced_grants:
  - from: string
    to: string
kept_grants: [string]
deferred_grants: [string]
residual_risk: [string]
reviewer_action: apply_now | needs_policy_decision | gather_more_receipts | none
receipt_expectations:
  classification_counts: object
  stop_status: string
  unresolved_questions: [string]
```

## Worked example

Input:

```yaml
subject: ops/deploy-pipeline
grants:
  - cluster:deploy:production
  - cluster:deploy:staging
  - secrets:read:*
  - secrets:write:*
  - logs:read:*
run_history:
  receipt_ids: [rx_201, rx_202, rx_203]
  observed:
    - grant: cluster:deploy:staging
      count: 12
      refs: [rx_201:step_2, rx_202:step_2, rx_203:step_2]
    - grant: secrets:read:deploy-keys
      count: 12
      refs: [rx_201:step_1, rx_202:step_1, rx_203:step_1]
    - grant: logs:read:deploy-*
      count: 8
      refs: [rx_201:step_4, rx_203:step_4]
```

Output:

```yaml
status: plan_proposed
subject: ops/deploy-pipeline
grant_plan:
  - declared_grant: cluster:deploy:production
    classification: revoke
    rationale: No receipt exercised production deploy authority across 3 observed runs.
    operational_risk: "Low — a future production deploy would re-request the grant."
  - declared_grant: cluster:deploy:staging
    classification: keep
    rationale: All 12 observed deploys targeted staging; grant is exercised as declared.
    operational_risk: None.
  - declared_grant: "secrets:read:*"
    classification: reduce
    proposed_grant: secrets:read:deploy-keys
    rationale: All 12 observed reads targeted deploy-keys only; wildcard is over-broad.
    operational_risk: "Low — a new secret path would re-request the broader grant."
  - declared_grant: "secrets:write:*"
    classification: revoke
    rationale: No receipt exercised secrets write authority.
    operational_risk: "Low — removal cannot break observed behavior."
  - declared_grant: "logs:read:*"
    classification: reduce
    proposed_grant: "logs:read:deploy-*"
    rationale: All 8 observed reads matched the deploy-* prefix.
    operational_risk: "Low — reading other log namespaces would re-request the broader grant."
planned_grant_set:
  - cluster:deploy:staging
  - secrets:read:deploy-keys
  - "logs:read:deploy-*"
revoked_grants:
  - cluster:deploy:production
  - "secrets:write:*"
reduced_grants:
  - from: "secrets:read:*"
    to: secrets:read:deploy-keys
  - from: "logs:read:*"
    to: "logs:read:deploy-*"
residual_risk:
  - The pipeline can still deploy to staging and read deploy-key secrets.
reviewer_action: apply_now
```

## Inputs

- `subject` (optional): skill id, grant id, principal, or other label for what
  is being planned.
- `grants` (required): the current or proposed grants to evaluate,
  preferably in canonical policy syntax.
- `run_history` (required): receipt-derived usage history. Include receipt ids,
  step refs, observed actions, resources, success or denial status, and the
  time window when available.
- `policy_constraints` (optional): reserved grants, compliance constraints, or
  human-approved exceptions that affect revocation decisions.
- `objective` (optional): operator intent that focuses the plan, such as
  "prepare for production hardening" or "post-incident least-privilege review".
