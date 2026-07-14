---
name: bookkeeper
description: "Read one batch of transactions plus a chart_of_accounts and prior_period, categorize every transaction to an existing GL account with confidence and reason, flag anomalies (duplicates, out-of-period, unknown payee, amount outliers, missing memo), and emit a read-only reconciliation artifact {matched, unmatched}. Refuses to invent a GL account the chart does not expose, refuses to book anything to a live ledger, and never mutates state."
runx:
  category: ops
---

# Bookkeeper

Bookkeeper turns a batch of messy transaction lines into clean books without
guessing. It reads `transactions[]`, `chart_of_accounts`, and an optional
`prior_period` and emits a typed categorization, anomaly flags, and a
read-only reconciliation.

The skill is read-only end to end. It writes nothing to a live ledger,
issues no rail run, and consumes no effect. Every categorized line binds to
an account that already exists in `chart_of_accounts`, and the skill refuses
to invent a GL account that is not in the chart.

## When to use this skill

- A batch of transactions needs to be categorized to a known chart of
  accounts, the chart is supplied as input, and the operator wants a clean
  categorized[]/anomalies[]/reconciliation artifact for review.
- The reviewer needs to know how many lines were matched, how many were
  flagged, what the unmatched totals are, and which lines need human review.
- The pipeline ahead needs a typed packet to feed a downstream skill (for
  example a journal-poster, a controller-review, or a period-close skill),
  and the upstream skill must not mutate state.

## When not to use this skill

- Anything that would write to a live ledger, post a journal entry, or
  trigger a payout. The reconciliation is a read-only artifact; the
  downstream poster skill owns the mutation.
- Inventing a GL account, renaming a chart line, or merging accounts. The
  skill refuses to categorize a transaction against an account the chart
  does not expose.
- Free-form natural-language expense reports that have not yet been split
  into typed transaction lines.

## Procedure

1. Read the `chart_of_accounts`. Every account used in `categorized[]` must
   appear in the chart with the same `code`. The skill refuses to emit a
   category code that is not in the chart.
2. Read `prior_period` when supplied. The skill uses it to (a) carry forward
   vendor/category memory for matching, (b) detect duplicate invoices
   (same vendor + same amount + same memo fingerprint already booked in
   the prior period), and (c) compute an opening balance for the
   reconciliation.
3. For each transaction in `transactions[]`:
   - Determine the account code by deterministic rule application: explicit
     `suggested_account` if the chart exposes it; else vendor memory from
     `prior_period.vendor_map`; else keyword match against the memo +
     payee against the chart's `keywords[]`. If none match, route to
     `needs_review` and increment `unmatched` totals.
   - Compute a `confidence` in [0.0, 1.0]. Explicit match = 1.0; vendor
     memory match = 0.85; keyword match = 0.6; ambiguous (multiple keyword
     candidates) = needs_review and never gets a category emitted.
   - Detect anomalies: duplicate (same vendor+amount+memo-fingerprint in
     `prior_period`), out-of-period (date outside the supplied `period`),
     unknown payee (no vendor memory and no keyword match), amount outlier
     (amount > 5x the vendor's median amount in `prior_period` when
     prior_period is present), missing memo.
4. Emit `reconciliation{matched, unmatched, opening_balance, closing_balance}`.
   The closing balance equals opening balance plus sum of categorized lines
   minus sum of refunds (negative amounts) only when the chart exposes a
   single cash-equivalent account. When the chart has multiple cash
   accounts, the skill emits per-account totals and the overall
   `closing_balance` is null with a refusal of `when: ambiguous_cash_set`.
5. Seal the verdict. The skill never invents an account code, never
   invents a date, and never invents a prior-period record.

## Inputs

- `transactions` (required array): typed transaction lines. Each line has:
  - `id` (required string): stable id within the batch.
  - `date` (required ISO date): transaction date.
  - `amount` (required number): signed (negative = refund/credit).
  - `currency` (required string): ISO 4217 currency code.
  - `payee` (required string): free-text payee/vendor.
  - `memo` (optional string): free-text memo.
  - `suggested_account` (optional string): explicit chart code the operator
    suggests.
- `chart_of_accounts` (required array): the chart. Each entry has:
  - `code` (required string): stable code used in `categorized[]`.
  - `name` (required string): human-readable name.
  - `type` (required string): one of `asset`, `liability`, `equity`,
    `revenue`, `expense`, `cash_equivalent`.
  - `keywords` (optional array of strings): memo/payee keywords that map
    to this account.
- `prior_period` (optional object):
  - `vendor_map` (optional object): `{ "<payee>": "<chart_code>" }` memory.
  - `vendor_median_amount` (optional object): `{ "<payee>": <number> }`.
  - `period` (optional object): `{ since, until }` ISO dates bounding the
    prior period.
  - `booked_fingerprints` (optional array of strings): memo-fingerprints
    already booked in the prior period; used for duplicate detection.
  - `opening_balances` (optional object): `{ "<chart_code>": <number> }`.
- `period` (optional object): `{ since, until }` ISO dates bounding the
  current period. Defaults to spanning the earliest to latest transaction
  date when omitted.

## Output schema

```yaml
bookkeeping:
  schema: runx.bookkeeping.v1
  decision: ready | needs_review | needs_more_evidence | needs_human
  categorized:
    - transaction_id: string
      account_code: string
      confidence: number
      reason: explicit | vendor_memory | keyword_match | needs_review
      amount: number
      currency: string
  anomalies:
    - transaction_id: string
      kind: duplicate | out_of_period | unknown_payee | amount_outlier | missing_memo
      detail: string
  reconciliation:
    matched: number
    unmatched: number
    opening_balance: number | null
    closing_balance: number | null
    per_account:
      - account_code: string
        net: number
  refusals:
    - when: ambiguous_cash_set | chart_missing_account | invalid_currency
      reason: string
      transaction_id: string | null
  observations:
    categorized_count: number
    anomaly_count: number
    unmatched_count: number
    needs_review_count: number
    period: { since: string, until: string }
    chart_size: number
```

## Refusals

- The skill refuses to categorize a transaction against an account code the
  chart does not expose. The transaction is recorded in `refusals` with
  `when: chart_missing_account`.
- The skill refuses to emit a `closing_balance` when the chart has zero or
  more than one `cash_equivalent` account. It emits per-account totals and
  sets `closing_balance: null` with `when: ambiguous_cash_set`.
- The skill refuses to mix currencies within a single reconciliation. A
  single `currency` outside the supplied chart's `base_currency` triggers
  `when: invalid_currency` and that transaction is parked in
  `needs_review`.
- When no transactions are supplied, the verdict is `needs_more_evidence`,
  `categorized[]` and `anomalies[]` are empty, and the reconciliation is
  all zeros.

## Quality bar

- Every categorized line binds to an account in the supplied chart; never
  invent a GL code.
- Never write to a live ledger; the reconciliation is a read-only artifact.
- Be deterministic: the same inputs must produce the same categorized[],
  anomalies[], reconciliation, and observation counts.
- Never reorder transactions; preserve the input `id` order in
  `categorized[]`.
- Stop cleanly with `needs_review`, `needs_more_evidence`, or `needs_human`; never fake a
  `ready` decision.

## Worked example

Open the chart for an indie SaaS with one cash-equivalent (`1010 Checking`)
and three expense accounts (`6010 Hosting`, `6020 SaaS Subscriptions`,
`6030 Contractors`). Read six transactions: two hosting charges, one SaaS
subscription, two contractor invoices (one already booked in the prior
period → duplicate anomaly), and one unknown payee. Categorize four, flag
the duplicate, route the unknown payee to `needs_review`. Reconciliation:
`matched=4, unmatched=2 (1 duplicate, 1 needs_review)`,
`closing_balance=null` because the chart exposes one cash account but the
duplicate and unknown payee are not booked; per-account net is emitted for
each categorized line.
