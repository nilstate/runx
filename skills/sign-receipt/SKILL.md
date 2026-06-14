---
name: sign-receipt
description: Seal an off-runtime action into a signed attestation receipt so external work joins the ledger with provenance.
runx:
  category: security
---

# Sign Receipt

Turn an action that happened outside a run into a signed attestation the ledger
can carry.

The runtime already signs every hop of work it executes itself; each act, each
decision, each refusal lands in a sealed receipt without anyone asking. Work
that happens elsewhere has no such record. A human approved a refund in the
provider console. A partner service shipped a build. A reviewer signed off in a
tool runx never touched. That work is real, but to the ledger it is a rumor.
This skill makes the rumor citable: it binds an actor, a claim, and the evidence
that backs the claim into one attestation, signs it, and appends a reference to
the ledger so downstream runs can depend on the external act with provenance
instead of trust.

It will not sign a claim the evidence does not support. An attestation with no
binding evidence is a signature on a guess, and a signed guess is worse than no
record at all.

**Distinctness:** it attests work that happened OUTSIDE a run; the runtime
already signs every hop of work it executes itself. `receipt-auditor` reads a
sealed in-runtime receipt to check authority; `sign-receipt` mints a new receipt
for work the runtime never saw.

## What this skill does

1. **Take the claim.** The caller states what was done (`action`), who did it
   (`principal`), and exactly what is being asserted (`claim`).
2. **Bind the evidence.** Evidence arrives as references and digests: a provider
   transaction id, a commit sha, a signed approval handle, a content digest.
   The skill records what each reference proves, never the underlying content.
3. **Test claim against evidence.** If the references do not actually support
   the claim, the skill stops at `needs_more_evidence` rather than signing.
4. **Sign and bind.** On a supported claim, the attestation is signed under the
   ledger key and appended; the result carries an `attestation_id` and a
   `bound_receipt_ref` tying it into the ledger.

## Core principles

- **No evidence, no signature.** A claim with no binding reference is not
  attestable. The skill refuses before it signs.
- **References only.** Evidence enters and leaves as digests, handles, ids, and
  spans. Raw content, secret values, card numbers, and PII never appear in the
  attestation or the receipt.
- **The principal is named.** An attestation asserts that a specific actor did a
  specific thing. An unnamed actor cannot be attested.
- **Scope of the claim is the scope of the signature.** The signature covers the
  exact claim text and the bound references, nothing wider. An optional `scope`
  narrows what the attestation may later be relied on for.
- **Append, do not overwrite.** Attestations are ledger entries. A correction is
  a new attestation that references the prior one, never an edit.

## When to use this skill

- A human or external service performed an action runx did not execute, and a
  later run needs to depend on it with provenance.
- An out-of-band approval, payment, build, or sign-off must enter the ledger so
  an audit can trace it.
- A partner attestation must be normalized into a runx-shaped, signed receipt.

## When not to use this skill

- To audit a run the runtime executed. That is `receipt-auditor`.
- To execute the action itself. Use the action skill (`spend`, `send-as`,
  `refund`); they seal their own receipts.
- To attest a claim with no evidence, or with evidence you cannot reference
  without inlining secret or personal data.
- To store the evidence content. This skill stores references to it.

## Governance

- **Scopes:** `ledger:append` to add the attestation entry, `sign:key` to sign
  it. No network, repo, or wallet authority is requested or used.
- **Gate:** evidence sufficiency is the preflight. The skill will not reach the
  signing step until each load-bearing part of the claim maps to a binding
  reference. Insufficient evidence stops the run before any signature.
- **Receipt:** the sealed receipt carries the `attestation_id`, the principal,
  the claim text, the digest of each evidence reference, the signing key id, and
  the `signed` outcome. It never carries the evidence content, a secret value,
  or any PII drawn from the evidence.

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

## Output

- `attestation.action`: what was done, in operational terms.
- `attestation.claim`: the exact assertion the signature covers.
- `attestation.principal`: the actor the attestation names.
- `attestation.evidence_refs`: array of bound references, each with a `ref`, a
  `digest`, and what it `proves`. References and digests only, never content.
- `attestation.signed`: boolean; true only when the evidence supports the claim
  and the signature was applied.
- `attestation.attestation_id`: stable id of this ledger entry.
- `attestation.bound_receipt_ref`: reference tying the attestation into the
  ledger receipt.
- `attestation.scope` (optional): bound on what the attestation may be relied on
  for downstream.

## Quality Profile

- Purpose: seal one off-runtime action into a signed attestation so external
  work enters the ledger with provenance, or stop when the evidence cannot back
  the claim.
- Audience: the operator, auditor, or follow-on skill that will rely on the
  external action and needs it citable rather than asserted.
- Artifact contract: `attestation` object carrying `action`, `claim`,
  `principal`, `evidence_refs` (refs and digests only), `signed`,
  `attestation_id`, and `bound_receipt_ref`.
- Evidence bar: every load-bearing part of the claim maps to a named reference
  with a digest; references are recorded by handle and digest, never inlined;
  a claim wider than its references is narrowed or refused.
- Voice bar: terse security-record prose. State what is attested and what backs
  it. Do not narrate the signing mechanism, hedge the assertion, or pad with
  governance adjectives.
- Strategic bar: the attestation must let a downstream run depend on the
  external act with provenance instead of trust; if it would not change what a
  downstream consumer can safely assume, it is not worth signing.
- Stop conditions: return `needs_agent` when `action`, `evidence`, `principal`,
  or `claim` is missing; return `needs_more_evidence` when the evidence does not
  support the claim or supports only a narrower one.

## Inputs

- `action` (required): what was done, off-runtime.
- `evidence` (required): references and digests proving the action, each with
  what it proves. References only; no raw content or secret values.
- `principal` (required): the actor the attestation names.
- `claim` (required): the exact assertion to be signed.
- `scope` (optional): bound on what the attestation may be relied on for.
