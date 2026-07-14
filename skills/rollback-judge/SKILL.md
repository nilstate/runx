---
name: rollback-judge
description: Judge a deploy signal and produce a bounded rollback, roll-forward, or escalation decision without performing the release action.
runx:
  category: ops
---

# Rollback Judge

Rollback Judge is a thin review skill for deploy incidents. Its default runner
reads a supplied deploy signal, current version, prior version, and any
forward-fix evidence, then emits one decision packet for a downstream release
lane in one sealed run.

The skill does not deploy, roll back, publish, mint authority, or call provider
APIs. Its only job is to record a review decision from caller-supplied evidence
and, when rollback is justified, shape that decision as the agent answer for the
existing `release.publish.approval` gate.

## What This Skill Does

1. **Read the deploy signal.** Use only `deploy_signal.severity`,
   `deploy_signal.kind`, and `deploy_signal.evidence` supplied by the caller.
2. **Check rollback eligibility.** A rollback decision requires a failing deploy
   signal and a concrete `prior_version`.
3. **Check roll-forward eligibility.** A roll-forward decision requires complete
   `forward_fix_evidence.test_runs` and `forward_fix_evidence.review_signoff`.
4. **Emit a review packet.** The packet contains `decision`, `escalation`,
   `release_publish_approval`, `review_record`, and receipt binding fields that
   name the decision, reason, and judged target recorded on the sealed receipt.
5. **Hand off by naming.** The packet names the downstream `release` skill and
   the `release.publish.approval` gate. The release graph owns the actual
   publish, rollback, or deployment consequence.

## Contract Boundaries

- **Typed inputs are required.**
  - `deploy_signal`: `{ severity, kind, evidence }`
  - `current_version`: deployed version being judged.
  - `prior_version`: rollback target candidate.
  - `forward_fix_evidence`: `{ test_runs, review_signoff }`
- **Typed output is bounded.**
  - `decision`: `{ action, reason, version_target }`
  - `escalation`: why the judge stopped instead of approving a release action.
- **No invented facts.** The judge never invents a prior version, fix evidence,
  test results, or review signoff.
- **No universal proposal envelope.** The output is a single review decision
  over supplied evidence, not a general action proposal or authority grant.
- **No minted authority.** Approval data is an agent answer for
  `release.publish.approval`; it is not a deployment credential or capability.
- **Receipt bindings are explicit.** The review act records `act_reason` as the
  sealed reason summary, `act_decision` as the decision binding, and
  `act_target_ref` as the judged release target reference. The default runner is
  one-pass so these trusted bindings are present when the receipt is sealed.

## Decision Rules

- Return rollback only when the deploy signal is failing or critical and the
  prior version is supplied.
- Return roll-forward only when the deploy signal is failing and the supplied
  fix evidence includes passing test runs plus review signoff.
- Return escalation when the signal is contradictory, thin, nonfailing, missing
  evidence, or when neither rollback nor roll-forward has enough supplied proof.
- Refuse rollback without a failing deploy signal.
- Refuse roll-forward with incomplete or untested fix evidence.
- Never target a version that was not supplied in `prior_version`,
  `current_version`, or `forward_fix_evidence`.

## Output Schema

```yaml
act_decision: approve | defer
act_reason: string
act_target_ref: string
decision:
  action: rollback | roll_forward | hold
  reason: string
  version_target: object | null
escalation:
  required: boolean
  reason: string | null
  missing_evidence:
    - string
release_publish_approval:
  gate_id: release.publish.approval
  approved: boolean
  reason: string
  dispatch:
    skill: release
    answer_key: release.publish.approval
review_record:
  form: review
  signal:
    severity: string
    kind: string
  evidence_used:
    - string
  refused:
    reason: string | null
```

## Inputs

- `deploy_signal` (required): caller-supplied deploy health or incident signal.
- `current_version` (required): current deployed version metadata.
- `prior_version` (optional): supplied candidate rollback target.
- `forward_fix_evidence` (optional): supplied fix, test, and review evidence.
- `act_decision` (optional): trusted receipt decision binding, usually
  `approve` for a sealed rollback approval and `defer` for holds.
- `act_target_ref` (optional): trusted receipt target reference, for example
  `runx:release:checkout@2026.07.12.2`.
