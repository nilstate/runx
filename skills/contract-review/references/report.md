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
- Published registry ref: `luismireles12/contract-review@sha-2a3aa46f2351`.
- Public adoption page: https://runx.ai/x/luismireles12/contract-review@sha-2a3aa46f2351.
- A clean `runx add` installation resolved the same package and profile digests.
- The post-publish dogfood run produced receipt `sha256:35b48f3bb480b8445f1b98ccf9c7866bf71ebcad83245d2e5edc9457584835f0`.
- `runx verify` returned `valid: true` with no findings.

The skill gives legal and commercial operators a reproducible first-pass review
packet. A new user can install the published package, pass a bounded contract
and playbook, inspect cited redlines, and independently verify the resulting
receipt without access to private context.
