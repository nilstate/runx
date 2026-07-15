---
name: sign-receipt
description: Prepare an evidence-bound attestation of an off-runtime action so the runtime can seal it into a signed receipt and external work joins the ledger with provenance.
runx:
  category: security
---

# Sign Receipt

Turn an action that happened outside a run into a signed attestation the ledger
can carry.

## What this skill does

`sign-receipt` binds an actor, a claim, and the evidence that backs the claim
into one attestation, tests the claim against that evidence, and hands the
runtime an attestation ready to seal under the ledger key so downstream runs can
depend on the external act with provenance instead of trust.

The runtime already signs every hop of work it executes itself; each act, each
decision, each refusal lands in a sealed receipt without anyone asking. Work that
happens elsewhere has no such record. A human approved a refund in the provider
console. A partner service shipped a build. A reviewer signed off in a tool runx
never touched. That work is real, but to the ledger it is a rumor. This skill
makes the rumor citable.

It will not sign a claim the evidence does not support. An attestation with no
binding evidence is a signature on a guess, and a signed guess is worse than no
record at all.

**Distinctness:** it attests work that happened OUTSIDE a run; the runtime
already signs every hop it executes itself. `audit-receipt` reads a sealed
in-runtime receipt to check authority; `sign-receipt` prepares a new attestation,
which the runtime seals into a receipt, for work the runtime never saw.

## When to use this skill

- A human or external service performed an action runx did not execute, and a
  later run needs to depend on it with provenance.
- An out-of-band approval, payment, build, or sign-off must enter the ledger so
  an audit can trace it.
- A partner attestation must be normalized into a runx-shaped, signed receipt.

## When not to use this skill

- To audit a run the runtime executed. That is `audit-receipt`, which reads an
  existing sealed receipt rather than preparing a new attestation.
- To execute the action itself. Use the action skill (`spend`, `send-as`,
  `refund`); they seal their own receipts.
- To attest a claim with no evidence, or with evidence you cannot reference
  without inlining secret or personal data.
- To store the evidence content. This skill stores references to it.

## Procedure

1. **Take the claim.** The caller states what was done (`action`), who did it
   (`principal`), and exactly what is being asserted (`claim`). An attestation
   asserts that a specific actor did a specific thing; an unnamed actor cannot be
   attested.
2. **Bind the evidence.** Evidence arrives as references and digests: a provider
   transaction id, a commit sha, a signed approval handle, a content digest.
   Record what each reference proves, never the underlying content. References,
   digests, handles, ids, and spans only; raw content, secret values, card
   numbers, and PII never appear.
3. **Test claim against evidence.** Evidence sufficiency is the gate. The run
   does not reach the signing step until each load-bearing part of the claim maps
   to a binding reference. If the references do not support the claim, stop at
   `needs_more_evidence` rather than signing. If the claim is broader than the
   evidence, narrow it to what the references prove, or stop. The scope of the
   signature is the scope of the claim, nothing wider.
4. **Mark ready to seal.** On a supported claim, set `signed: true` to mark the
   attestation ready and hand it to the runtime, which signs it under the ledger
   key and appends it. Attestations are ledger entries; append, do not overwrite.
   A correction is a new attestation that references the prior one, never an edit.
   The sealed result carries an `attestation_id` and a `bound_receipt_ref` tying it
   into the ledger. The required scopes are `ledger:append` to add the entry and
   `sign:key` for the runtime to sign it; no network, repo, or wallet authority is
   requested.

## Edge cases and stop conditions

- **Missing action, evidence, principal, or claim:** return `needs_agent`; the
  attestation has no subject to sign.
- **Evidence does not support the claim:** return `needs_more_evidence` with the
  specific gap named; do not sign a partial match.
- **Evidence carries raw secret or personal data:** record its digest and span,
  drop the raw value; if dropping it removes the proof, return
  `needs_more_evidence`.
- **Claim broader than the evidence:** narrow the claim to what the references
  prove, or stop. A signature must not cover unproven ground.
- **Conflicting references:** stop at `needs_more_evidence`; an attestation must
  not paper over contradiction.

## Output schema

```yaml
attestation:
  action: string          # what was done, in operational terms
  claim: string           # the exact assertion the signature covers
  principal: string       # the actor the attestation names
  evidence_refs:          # bound references, refs and digests only, never content
    - ref: string
      digest: string
      proves: string
  signed: boolean         # true only when evidence supports the claim; marks the attestation ready for the runtime to seal
  attestation_id: string  # stable id of this ledger entry, set when the runtime seals it
  bound_receipt_ref: string  # reference tying the attestation into the ledger receipt, set on seal
  scope:                  # optional, bound on what the attestation may be relied on for
    rely_for: string
```

The sealed receipt carries the `attestation_id`, the principal, the claim text,
the digest of each evidence reference, the signing key id, and the `signed`
outcome. It never carries the evidence content, a secret value, or any PII drawn
from the evidence.

## Worked example

Input: an operator (`ops:jordan`) issued a $40.00 goodwill refund for order
ORD-7741 in the provider console. Evidence is two references: a provider refund
transaction (`provider:refund/re_3PqL2x`, with digest) proving the refund
settled, and a console approval handle (`approval:console-signoff/ap_5512`, with
digest) proving sign-off preceded the refund.

Output: each load-bearing part of the claim maps to a binding reference, so the
gate passes. The attestation names the principal, carries both `evidence_refs`
with their digests, and sets `signed: true`; the runtime then seals it, returning
an `attestation_id` plus a `bound_receipt_ref`. The scope binds reliance to downstream dispute and
reconciliation runs referencing ORD-7741. Had only the approval handle been
supplied with no settlement reference, the decision would be
`needs_more_evidence`, not a signature.

## Inputs

- `action` (required): what was done, off-runtime.
- `evidence` (required): references and digests proving the action, each with
  what it proves. References only; no raw content or secret values.
- `principal` (required): the actor the attestation names.
- `claim` (required): the exact assertion to be signed.
- `scope` (optional): bound on what the attestation may be relied on for.
