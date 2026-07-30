---
name: bookkeeper
description: Categorize transaction lines into a supplied chart of accounts, flag anomalies, and emit a read-only reconciliation without guessing or mutating a ledger.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  transactions:
    type: json
    required: true
    description: Transaction lines with a description and finite numeric amount.
  chart_of_accounts:
    type: json
    required: true
    description: Existing GL accounts with stable ids, names, types, and optional keywords.
  prior_period:
    type: json
    required: true
    description: Prior-period transaction evidence for repeat matches and anomaly baselines.
runx:
  category: finance-ops
  input_resolution:
    required:
      - transactions
      - chart_of_accounts
      - prior_period
---

# Bookkeeper

Turn a batch of transaction lines into a reviewable, read-only bookkeeping
artifact. The skill categorizes each unambiguous line to an account that already
exists in `chart_of_accounts`, flags anomalies, and reports how many lines were
matched or left for review. It never posts entries or changes a live ledger.

## When to use this skill

- Clean up exported bank or card transaction lines before human review.
- Apply a known chart of accounts consistently to a bounded transaction batch.
- Detect duplicates, zero-value lines, unusual amounts, and ambiguous account
  choices before an import.
- Produce a deterministic reconciliation packet that can be independently
  replayed from the same three inputs.
- Categorize current public Frantic funding receipts directly from their
  machine-readable receipt URLs with the `frantic-public-receipts` runner.

## When not to use this skill

- Do not use it to post journal entries, move money, reconcile a live bank
  connection, or call an accounting API.
- Do not use it when the chart of accounts is missing or untrusted.
- Do not treat `ready` as approval to import. The output is a review artifact,
  not an authorization or ledger mutation.
- Do not force a category when two accounts have the same best evidence. Such a
  line belongs in `needs_review`.

## Inputs

`transactions` is an array. Each line requires `description` and a finite
numeric `amount`; `id`, `date`, and `currency` are retained when present.

`chart_of_accounts` is an array. Every account requires a stable `id` (or
`account_id`/`code`) and `name`. `type` and `keywords` improve matching. The
runner can only emit ids from this array and never invents a GL account.

`prior_period` is an object with an optional `transactions` array. A prior line
may carry `description`, `amount`, and `account_id`. Exact description-and-amount
matches are strong evidence only when the referenced account still exists.

The optional `frantic-public-receipts` runner replaces `transactions` with
`receipt_urls`. Each URL must use the exact
`https://gofrantic.com/v1/receipts/<id>` endpoint. The runner fetches each public
`posting.funded` receipt at execution time and derives one worker-liability
transaction plus one posting-fee transaction from its cents-denominated
effect. `chart_of_accounts` and `prior_period` remain required.

## Procedure

1. Validate all three inputs and normalize the supplied account ids, names,
   types, and keywords.
2. Reject no line silently. Invalid lines are retained as anomalies and placed
   in `needs_review`.
3. Honor an explicit `account_id` on a transaction only when that id exists in
   the supplied chart.
4. Look for an exact prior-period description-and-amount match bound to an
   existing account.
5. Score lexical evidence from account keywords and meaningful name tokens.
   A keyword phrase is stronger than an isolated token.
6. Use transaction direction only as supporting evidence: positive amounts
   support revenue/income accounts and negative amounts support expense/cost
   accounts. Direction alone can never choose an account.
7. Categorize only when the best account has lexical or prior-period evidence
   and is strictly better than the runner-up. Emit the selected account id,
   confidence, and a concrete reason.
8. Flag duplicate lines, zero amounts, missing dates, and amounts that exceed
   three times the prior-period median absolute amount.
9. Emit `decision: ready` only when every valid transaction is categorized.
   Otherwise emit `decision: needs_review` with each unresolved line and reason.

## Stop conditions

- Missing or malformed top-level inputs fail closed instead of producing a
  partial result.
- A transaction with no usable description or amount is not categorized.
- An explicit account id that is absent from the chart is an anomaly and does
  not authorize a new account.
- A tied best score, weak lexical evidence, or conflicting prior-period match
  returns `needs_review`.
- When any line needs review, the runner still prints the complete result packet
  but exits with status 2. Runx records the case as a failed/refused execution
  instead of sealing an ambiguous classification as successful.
- The default runner performs no network requests. The
  `frantic-public-receipts` runner can only read the exact allowlisted public
  receipt endpoint, rejects cross-origin redirects, caps responses at 100 KB,
  and writes no files.

## Output

```json
{
  "source": {
    "kind": "supplied_transactions | frantic_public_funding_receipts",
    "receipts": []
  },
  "decision": "ready | needs_review",
  "categorized": [
    {
      "transaction_id": "txn-001",
      "account_id": "4000",
      "confidence": 0.95,
      "reason": "matched keywords: client, invoice, payment; positive amount supports revenue"
    }
  ],
  "anomalies": [],
  "reconciliation": {
    "matched": 1,
    "unmatched": 0,
    "total": 1,
    "debits": 0,
    "credits": 1200,
    "net": 1200,
    "prior_period_matches": 0
  },
  "needs_review": []
}
```

`categorized[]` contains only existing `chart_of_accounts` ids. Every item has
a numeric `confidence` and an evidence-based `reason`. `anomalies[]` describes
data-quality and amount checks. `reconciliation.matched` plus
`reconciliation.unmatched` always equals `reconciliation.total`.
For the public-receipt runner, `source.receipts[]` records each URL, Frantic
receipt reference, posting id, publication time, and SHA-256 digest of the
fetched response.

## Local verification

```bash
runx harness ./skills/bookkeeper --json
runx skill ./skills/bookkeeper \
  --input transactions='[{"id":"txn-1","description":"ACME invoice payment","amount":1200}]' \
  --input chart-of-accounts='[{"id":"4000","name":"Service revenue","type":"revenue","keywords":["invoice","payment"]}]' \
  --input prior-period='{"transactions":[]}' \
  --json

runx skill ./skills/bookkeeper frantic-public-receipts \
  --input-json receipt_urls='["https://gofrantic.com/v1/receipts/563cefce034c"]' \
  --input-json chart_of_accounts='[{"id":"2100","name":"Funded worker liability","keywords":["worker liability"]},{"id":"6300","name":"Demand-side posting fees","type":"expense","keywords":["posting fee"]}]' \
  --input-json prior_period='{"transactions":[]}' \
  --json
```

Inspect the sealed receipt and the returned `categorized`, `anomalies`,
`reconciliation`, and `needs_review` fields before using the artifact anywhere
downstream.
