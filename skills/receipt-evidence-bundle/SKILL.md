---
name: receipt-evidence-bundle
description: Convert receipt refs, verify output, and artifacts into a reviewer-safe evidence bundle.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: security
---

# Receipt Evidence Bundle

Prepare a compact evidence bundle for review from receipt refs, supplied verify
results, sanitized receipt summaries, and public artifact links.

The skill separates verified facts from inferred facts and lists missing
evidence. It redacts email-like or token-like material from summaries.

## Procedure

1. Require at least one receipt ref or sanitized receipt summary.
2. Refuse malformed receipt refs.
3. Consume supplied `runx verify` output when available.
4. Summarize public artifact links.
5. Emit reviewer actions for missing verification.

## Inputs

- `receipt_refs`: runx receipt references.
- `receipt_summaries`: sanitized receipt summaries.
- `verify_results`: supplied runx verify outputs.
- `artifact_links`: public links to bind to the evidence bundle.

## Outputs

- `verified_facts`, `inferred_facts`, `missing_evidence`.
- `reviewer_actions` and `redactions`.
- `evidence`: count and verification status.

