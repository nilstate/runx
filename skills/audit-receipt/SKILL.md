---
name: audit-receipt
description: Audit a sealed runx receipt for governance, comparing the authority a run exercised against what it was granted, and flag over-reach, ungated mutation, unrecorded refusals, or exposed secret material.
runx:
  category: security
---

# Receipt Auditor

Audit a sealed run for authority over-reach, using its own receipt as evidence.

runx seals a receipt for every run: the authority proof, the acts performed, the
decisions taken, the refusals, and hashed material references. That receipt is
the evidence. This skill reads a sealed receipt and answers one governance
question: did the run stay inside the authority it was granted? It flags scopes
exercised that were never granted, mutating acts that ran without an approval
gate, refusals that were not recorded, and any raw secret material that leaked
into the receipt. It pairs with `least-privilege`: that one narrows a
grant from usage, this one verifies a run honored its grant.

## What this skill does

1. **Read the proof and the acts.** From the receipt, extract the granted
   authority (the proof) and the scopes the acts actually exercised.
2. **Diff exercised against granted.** Any exercised scope not covered by the
   proof is over-reach.
3. **Check the gates.** Every mutating act must show an approval gate in the
   receipt; an ungated mutation is an anomaly.
4. **Check exposure.** The receipt must carry only hashed material references; a
   raw secret in the receipt is a leak.
5. **Verdict.** `clean`, `anomaly`, or `needs_more_evidence`, with the exact
   findings and a recommendation for each anomaly.

## Core principles

- **The receipt is the evidence.** Audit what the receipt records, not what the
  skill claims it did.
- **Granted is the ceiling.** Exercised authority must be a subset of the proof;
  anything beyond is over-reach, full stop.
- **Mutation needs a gate.** A mutating act with no approval gate in the receipt
  is an anomaly even if it succeeded.
- **No raw material.** A receipt must reference material by hash; raw credential
  material in a receipt is a leak, not a convenience.
- **Absence of evidence is not clean.** With no receipt or an unattributable
  one, return `needs_more_evidence`, never `clean`.

## When to use this skill

- Post-run governance audit of a sealed, successful run.
- Spot-checking that a skill honored its authority bound in production.
- Before promoting a skill toward a higher trust posture.

## When not to use this skill

- To diagnose a failed run and propose a fix. That is `review-receipt`
  (failure-to-improvement). This skill audits a sealed run for over-reach
  (success-to-governance); the two are different lenses on a receipt.
- To narrow a grant from observed usage. That is `least-privilege`.

## Diagnostics

- `receipt.authority.over_reach` (error): an exercised scope is not covered by
  the authority proof.
- `receipt.mutation.ungated` (error): a mutating act ran without an approval gate
  recorded in the receipt.
- `receipt.refusal.unrecorded` (warning): a denied request is not reflected as a
  sealed refusal.
- `receipt.material.exposed` (error): raw credential material appears in the
  receipt instead of a hash reference.
- `receipt.clean` (info): exercised authority is within the grant, mutations are
  gated, and no material is exposed.

## Procedure

1. Resolve the receipt from `receipt_id` or use the provided sanitized
   `receipt_summary`.
2. Extract the authority proof, granted scopes, acts, approvals, refusals,
   material references, and receipt signature metadata.
3. Normalize exercised scopes from the acts and compare them with the granted
   scopes. Exercised must be a subset of granted.
4. Identify mutating acts and confirm each has an approval gate recorded in the
   receipt.
5. Check that denied requests appear as sealed refusals when the receipt records
   the attempt.
6. Scan receipt-visible material for raw credentials or secret-bearing payloads.
7. Return a verdict with findings, recommendations, and the success checkpoint.

## Edge cases and stop conditions

- **Missing receipt:** return `needs_more_evidence`; never infer a clean run.
- **Unattributable receipt:** return `needs_more_evidence` when the receipt
  cannot be tied to the run under audit.
- **Malformed proof:** return `needs_more_evidence` unless enough normalized
  grant data is supplied separately.
- **Unknown scope name:** treat it as over-reach unless the grant explicitly
  covers it.
- **Mutation without recorded gate:** emit `receipt.mutation.ungated` even if the
  mutation succeeded and the outcome looks correct.
- **Raw token, key, or credential in the receipt:** emit
  `receipt.material.exposed` and recommend revocation/rotation.

## Output schema (`receipt_audit`)

```yaml
decision: ready | needs_more_evidence
run_ref: string
granted_scopes: [string]
exercised_scopes: [string]
refusals: [string]
findings:
  - id: string
    severity: error | warning | info
    message: string
verdict: clean | anomaly | needs_more_evidence
rationale: string
recommendations: [string]
success_checkpoint:
  milestone: string
  description: string
```

A `clean` verdict requires zero `error` findings.

## Worked example

A sealed run was granted `repo.read`. The receipt shows the acts exercised only
`repo.read`, every act is an observation (no mutation), and material is
referenced by hash. Exercised is a subset of granted, no mutation to gate, no
exposure: `verdict: clean`. Had an act exercised `repo.write` while the proof
granted only `repo.read`, that would raise `receipt.authority.over_reach` and a
`verdict: anomaly` with a recommendation to revoke the run's grant and
investigate.

## Inputs

- `receipt_id` (optional): the receipt id to audit.
- `receipt_summary` (optional): a sanitized receipt or its acts/proof summary
  when the full receipt is not available.
- `granted_scopes` (optional): the authority the run was granted, when not
  derivable from the receipt alone.
- `objective` (optional): operator intent that focuses the audit.

At least one of `receipt_id` or `receipt_summary` is required; with neither, the
skill returns `needs_more_evidence`.
