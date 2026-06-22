---
name: receipt-evidence-bundle
version: 0.1.0
description: Turn verified runx receipt results and optional public artifact links into a reviewer-safe evidence bundle with lineage, authority, gaps, actions, and redaction notes.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/zdfgu113/runx/tree/codex/receipt-evidence-bundle/skills/receipt-evidence-bundle
runx:
  category: authoring
  input_resolution:
    required:
      - receipt_refs
      - verification_results
---

# Receipt Evidence Bundle

Build a reviewer-safe packet from one or more runx receipt references. The
caller verifies each receipt with `runx verify --receipt <file> --json` and
passes the resulting verdict and receipt shape in `verification_results`.
This skill checks that every requested reference has a valid verification
result, extracts checkable lineage and authority facts, records bounded
inferences and missing evidence, and recursively redacts secret-bearing fields.

## When to use this skill

Use it during payout, merge, incident, or compliance review when a human needs
one compact packet explaining what receipts prove and what still needs manual
inspection. Optional `artifact_links` can bind source, report, PR, registry, or
other public evidence to the same review.

## When not to use this skill

Do not use it to mint, repair, sign, or reinterpret a receipt. It does not make
an invalid receipt valid, fetch private payloads, assume authority from prose,
or replace `runx verify`. It has no network or mutation authority.

## Procedure

1. Require at least one receipt reference in `receipt_refs`.
2. Accept only `runx:receipt:<id>` or `sha256:<64 lowercase-or-uppercase hex>`
   reference shapes.
3. Require one verification result per reference.
4. Refuse the run if any result is missing, unverifiable, invalid, or does not
   expose `schema: runx.receipt.v1`.
5. Redact sensitive keys and token/private-key patterns before deriving facts.
6. Extract receipt id, state, disposition, lineage, authority identity, grant
   digest, and admitted scopes when those fields are present.
7. Separate direct facts from bounded lineage inferences.
8. List missing evidence instead of filling gaps with assumptions.
9. Return explicit reviewer actions, including replayable verify commands.

## Redaction contract

Fields whose names contain password, secret, token, authorization, cookie,
private key, seed phrase, or credential are replaced with `[REDACTED]`.
Bearer tokens, common provider token prefixes, and PEM private keys are also
removed from free text. Optional `redaction_terms` add caller-supplied literal
values to remove. The output records the redacted JSON path and reason but never
copies the removed value.

## Refusal and stop conditions

- Missing or empty receipt references: fail.
- Malformed receipt reference: fail.
- Missing verification result: fail.
- Verification verdict other than valid: fail.
- Receipt schema other than `runx.receipt.v1`: fail.
- Incomplete but valid receipt: succeed while naming the gap in
  `missing_evidence`.

## Output

The runner emits `runx.receipt_evidence_bundle.v1` with:

- `summary`: human-readable bundle result.
- `verdict`: `verified` after every receipt passes the verification gate.
- `receipt_count`: number of verified receipts.
- `verified_facts`: facts copied from sanitized verified receipts.
- `inferred_facts`: bounded relationships derived from supplied facts.
- `missing_evidence`: gaps a reviewer must not assume away.
- `reviewer_actions`: replayable verification and inspection steps.
- `redactions`: paths and reasons for removed sensitive material.
- `artifact_links`: sanitized optional public evidence supplied by the caller.

## Example

```bash
runx skill ./skills/receipt-evidence-bundle \
  --input-json receipt_refs='["runx:receipt:parent","runx:receipt:child"]' \
  --input-json verification_results='[{"receipt_ref":"runx:receipt:parent","verdict":"valid","receipt":{"schema":"runx.receipt.v1","id":"runx:receipt:parent","state":"sealed"}},{"receipt_ref":"runx:receipt:child","verdict":"valid","receipt":{"schema":"runx.receipt.v1","id":"runx:receipt:child","state":"sealed","parent_receipt_id":"runx:receipt:parent"}}]' \
  --json
```

## Inputs

- `receipt_refs` (required): JSON array of runx receipt references, or one
  receipt reference string.
- `verification_results` (required): JSON array or object containing a valid
  verification verdict and receipt body for every reference.
- `artifact_links` (optional): public evidence links keyed by purpose, or an
  array of links.
- `redaction_terms` (optional): literal sensitive values to remove in addition
  to the built-in redaction rules.
