---
name: contract-drafter
version: 0.1.0
description: Assemble a reviewable contract draft from a supplied template, parties, and deal terms while surfacing every deviation from the template baseline and emitting only a gated send-as proposal.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/iwannabefree00/runx/tree/frantic-86-contract-drafter/skills/contract-drafter
runx:
  category: business-ops
  tags:
    - contracts
    - drafting
    - governance
---

# Contract Drafter

`contract-drafter` turns an explicit contract template, explicit parties, and
explicit deal terms into a reviewable draft packet. It is intentionally narrow:
the skill assembles a draft, lists every departure from the supplied template
baseline, and prepares a gated `send_proposal` object for a later send-as run.
It never sends the draft, never executes a signature workflow, and never invents
missing parties, clauses, or deal terms.

## Inputs

- `template`: object containing `template_id`, `baseline`, `required_terms`, and
  `clauses`.
- `parties`: object containing the explicit contracting parties. The default
  runner expects `provider.legal_name` and `customer.legal_name`.
- `terms`: object containing the deal-specific values to merge into the
  template.

## Outputs

- `draft_doc`: a structured Markdown draft with clause sections and source
  provenance for each term.
- `deviations[]`: every baseline departure, with `clause`, `baseline`, and
  `proposed_change`.
- `send_proposal`: a gated send-as proposal that references the draft and
  requires human approval and preflight before any downstream send can occur.

When a required term is missing, the runner refuses. The refusal emits no
`draft_doc` and no `send_proposal`, so incomplete contract material cannot leak
into a proposal path.

## Safety model

1. Validate the template, parties, and terms before drafting.
2. Refuse if any required template term is missing from `terms`.
3. Refuse if either party legal name is missing.
4. Use only supplied template clauses and supplied deal terms.
5. Compare every supplied term that has a template baseline and record all
   differences in `deviations[]`.
6. Emit a `send_proposal` only as a gated, not-sent packet for a separate
   `send-as` step.

## Procedure

1. Read the template, parties, and terms from runx inputs.
2. Normalize the template baseline and required terms.
3. Validate that all required terms are present and non-empty.
4. Render a review draft from template clauses and supplied terms.
5. Record deviations against the template baseline by clause id.
6. Emit the draft packet and a gated `send_proposal` that names its audience,
   subject, draft reference, and approval requirements.

## Example behavior

If the template baseline says `payment_terms: Net 30` and the deal terms say
`payment_terms: Net 45`, the output includes:

```json
{
  "clause": "payment_terms",
  "baseline": "Net 30",
  "proposed_change": "Net 45"
}
```

If `payment_terms` is required but omitted, the runner refuses and returns a
missing-term reason without a draft or send proposal.
