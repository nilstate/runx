# Contract Review verification report

- Built and tested with `runx-cli 0.6.13`.
- `runx doctor skills/contract-review --json` reports zero errors or warnings.
- Local harness passes `cited-redlines` and `refuse-non-contract`.
- Typed inputs are `contract` and `playbook`.
- Typed outputs are `clauses`, `redlines`, and `risk_summary`.
- Every redline cites the exact input clause and supplied playbook rule.
- Replacement language appears only when supplied as `proposed_text`.
- Non-contract input fails rather than producing invented clauses.
- Missing playbook rules fail rather than applying hidden legal standards.
- The runner performs no network calls, writes, or external effects.
- Obvious credentials and payment-card numbers are redacted from quoted text.
- A human reviewer remains responsible for acceptance, negotiation, or escalation.

The skill gives legal and commercial operators a reproducible first-pass review
packet. A new user can install the published package, pass a bounded contract
and playbook, inspect cited redlines, and independently verify the resulting
receipt without access to private context.

