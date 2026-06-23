---
name: contract-review
version: 0.1.0
description: Extract contract clauses, compare them only with a supplied terms playbook, and produce cited redlines plus a human-gated risk summary.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/luismireles12/runx/tree/feat/contract-review/skills/contract-review
runx:
  category: legal
---

# Contract Review

`contract-review` performs a deterministic, read-only comparison between a
contract and a supplied acceptable-terms playbook. It extracts only clauses
present in the input, cites the exact playbook rule behind every redline, and
returns an analysis artifact for a human reviewer.

It never signs, accepts, rejects, sends, files, or negotiates a contract and
does not provide a final legal conclusion.

## Inputs

- `contract`: an object containing `id` plus either structured `clauses` or
  labelled contract `text`.
- `playbook`: an object containing `id` and a non-empty `rules` array.

Structured clauses should contain `id`, `type`, `title`, and `text`. Rules may
contain:

- `id` and `clause_type`
- `requirement`
- `severity`
- `max_days`
- `forbidden_terms`
- `required_terms`
- `require_cap`
- `required`
- `proposed_text`

## Outputs

- `clauses[]`: only clauses traceable to the contract input.
- `redlines[]`: each item cites its clause and supplied playbook rule, explains
  the detected variance, and includes proposed text only when the playbook
  supplied it.
- `risk_summary`: counts, severity, input references, and explicit read-only
  constraints.

## Guardrails

- Refuse non-contract or unparseable input.
- Refuse a playbook without rules.
- Never create clause text that is absent from the contract.
- Never create a policy requirement or proposed replacement that is absent
  from the playbook.
- Redact obvious credentials and payment-card numbers from quoted evidence.
- Emit no effects. A human decides whether to accept, negotiate, or escalate.

## Review procedure

1. Validate both input objects and the supplied playbook rules.
2. Extract structured clauses or labelled sections from contract text.
3. Reject the run if the input cannot be identified as a contract.
4. Match each rule to a clause by normalized type or supplied keywords.
5. Record missing required clauses without inventing clause text.
6. Evaluate only explicitly encoded rule conditions.
7. Return risk ordered from high to low with exact source citations.

## Example

If a termination clause requires 90 days while the supplied rule caps notice
at 30 days, the redline cites the 90-day clause, cites the 30-day playbook
requirement, and uses replacement text only if `proposed_text` was supplied.

This artifact is suitable for a first-pass commercial review, not a substitute
for advice from qualified counsel.
