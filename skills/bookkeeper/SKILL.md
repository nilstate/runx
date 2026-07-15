---
name: bookkeeper
description: Reconcile sourced transaction batches against an existing chart of accounts with deterministic account binding, anomaly evidence, and a read-only consumer-verified artifact.
---

# Bookkeeper — read-only reconciliation

Use `bookkeeper` to turn a sourced transaction batch into a reviewable,
read-only accounting artifact. The skill validates every source line, binds each
line to exactly one account that already exists in the supplied chart, and then
passes those bindings to an independent reconciliation step. It never posts to
a ledger, invents an account, or resolves an ambiguous line by guessing.

## Inputs

- `transactions[]`: statement lines with `id`, `date`, `description`, signed
  integer `amount_minor`, `currency`, `counterparty`, and `source_ref`.
- `chart_of_accounts`: existing accounts with `code`, `name`, `type`, and a
  `match` policy. A policy declares `direction` plus bounded
  `description_contains` and/or `counterparty_exact` evidence.
- `prior_period`: the statement currency, opening balance, expected ending
  balance, prior transaction IDs, known counterparties, and an optional prior
  average absolute amount.

Positive amounts are inflows and negative amounts are outflows. Amounts are
integers in minor currency units so reconciliation does not depend on floating
point arithmetic.

## Runtime pipeline

1. `admit-source` validates source provenance, input shape, account rules,
   transaction uniqueness, prior-period bindings, and unique account matches.
2. `categorize-lines` recomputes the input digests and materializes every
   proposed binding against the existing chart. Each line carries confidence,
   reason, matched evidence, and its source reference.
3. `reconcile-readonly` is a real downstream consumer. It independently checks
   account membership and line coverage, recomputes the statement movement and
   ending balance, and emits `reconciliation{matched,unmatched}`.
4. `emit-readonly-artifact` runs only when the consumer found no unmatched
   evidence. It emits the typed `categorized[]`, `anomalies[]`, and
   `reconciliation` result plus a digest of the consumed reconciliation.

Graph guards stop downstream work when admission returns `needs_review` or the
consumer finds a balance mismatch. A refused run emits no final bookkeeping
artifact.

## Matching contract

An account is eligible only when its declared direction matches the signed
transaction amount and at least one declared evidence item matches. Exact
counterparty evidence scores higher than a bounded description phrase. The top
score must be unique. A tie or no match returns `needs_review`, including the
candidate account codes and reason.

Every categorized entry contains:

- the original transaction ID, date, description, amount, currency, and
  `source_ref`;
- an `account_code` and `account_name` copied from `chart_of_accounts`;
- a numeric confidence score and a human-readable reason;
- the exact matched counterparty or description evidence; and
- `read_only: true`.

## Anomalies and reconciliation

The skill flags prior-period duplicate IDs, unfamiliar counterparties, currency
conflicts, and amount outliers. A duplicate, malformed line, unsupported
currency, ambiguous match, or ending-balance mismatch prevents the final
artifact. Informational anomalies such as a new counterparty or a large but
otherwise well-bound amount remain visible for human review.

`reconciliation.matched` lists every accepted statement line and its existing
account binding. `reconciliation.unmatched` lists consumer-level failures such
as missing line coverage or a statement-balance difference. The consumer also
records the opening balance, net movement, calculated ending balance, expected
ending balance, and the digest of the categorized batch it consumed.

## Non-authority

This skill has no credential input, network permission, or ledger-write tool.
It produces evidence for a bookkeeper; it does not create journal entries,
change a chart of accounts, approve a close, or send data anywhere. A separate
governed workflow must review and post any resulting entry.
