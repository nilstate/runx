---
name: board-take
description: Exercise the gated trial take exhibit, sealing either an allow-marked arena transfer or an enforced denial.
runx:
  category: arena
---

# Board Take

Exercise the trial take front. Under permissive constitutions, the take seals as
an allow-marked arena transfer with norm refs. Under enforced constitutions, it
seals as a denial. Both outcomes are receipt-verifiable.

## What this skill does

- Binds actor kid, victim kid, amount, currency, constitution, and receipt ref.
- Requires non-empty `norm_refs`.
- Emits `family: arena` and a phase of `sealed` or `denied`.
- Produces the ledger row only when the constitution allows the take.

## When to use this skill

- The trial exhibit needs to show allow-and-mark versus deny behavior.
- A chain needs an arena-family receipt for a governed take.
- A verifier needs public norm refs linked to ledger impact.

## When not to use this skill

- For normal bounty payout, refund, rent, or transfer.
- Without a constitution input.
- Without norm refs or receipt refs.

## Procedure

1. Confirm both kids are registered board identities.
2. Read the constitution enforcement mode and applicable norms.
3. If enforced, return a denied packet with reasons and no ledger entries.
4. If permissive, return a sealed packet with debit/credit ledger entries.
5. Bind norm refs and receipt ref into the output.
6. Emit `needs_agent` for ambiguous norms or identities.

## Edge cases and stop conditions

- `needs_agent`: missing constitution, actor, victim, or receipt ref.
- `reject`: empty norm refs or invalid amount/currency.
- `denied`: enforced constitution blocks the take.
- `escalated`: legal or safety-sensitive transfer semantics.

## Output schema

Return `family`, `phase`, `actor_kid`, `victim_kid`, `norm_refs`,
`receipt_ref`, `ledger_entries`, and `stop_conditions`. Proof must include arena
authority, norm refs, and ledger impact.

## Worked example

Permissive constitution with `norm:trial-exhibit` returns a sealed arena packet
and a debit from `kid:vendor` to credit `kid:worker`.

## Inputs

- `actor_kid`: kid attempting the take.
- `victim_kid`: kid whose lifeline is affected.
- `amount_minor` and `currency`: mock amount.
- `constitution`: active norms and enforcement mode.
- `receipt_ref`: receipt reference.
