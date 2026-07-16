---
name: bookkeeper
description: Fetch an allowlisted JSON statement and reconcile its transaction rows against an existing chart of accounts with deterministic bindings and a read-only consumer-verified artifact.
---

# Bookkeeper — allowlisted source reconciliation

Use `bookkeeper` to fetch a public JSON statement from an explicitly allowed
host and turn its transaction rows into a reviewable, read-only accounting
artifact. The skill validates every fetched source line, binds each line to
exactly one account that already exists in the supplied chart, and passes those
bindings to an independent reconciliation step. It never posts to a ledger,
invents an account, or resolves an ambiguous line by guessing.

## Inputs

- `source_url`: public HTTP(S) JSON statement fetched during the governed run.
  The document contains `currency`, `opening_balance_minor`,
  `expected_ending_balance_minor`, and `transactions[]`.
- `source_allowlist`: exact hosts that the canonical `web-fetch` step may
  contact, including any permitted redirect host. Wildcards, trailing dots,
  credentials, and hosts absent from this list are refused before network
  access.
- `chart_of_accounts`: existing accounts with `code`, `name`, `type`, and a
  `match` policy. A policy declares `direction` plus bounded
  `description_contains` and/or `counterparty_exact` evidence.
- `prior_period`: the statement currency, opening balance, expected ending
  balance, prior transaction IDs, known counterparties, and an optional prior
  average absolute amount.
- `transactions` remains declared as an optional typed contract field for the
  bounty interface, but production admission refuses it. Rows must come from
  the fetched `source_url`, not from caller-pasted JSON.

Positive amounts are inflows and negative amounts are outflows. Amounts are
integers in minor currency units so reconciliation does not depend on floating
point arithmetic.

## Runtime pipeline

1. `validate-source-request` rejects direct transaction rows and validates an
   exact-host source authority before any network step can run.
2. `fetch-source` composes the canonical `web-fetch` skill. It fetches exactly
   one URL within `source_allowlist` and emits final URL, HTTP status, byte
   count, content digest, redirects, and extracted text in the run receipt.
3. `admit-source` first requires the UTF-8 bytes of `extracted` to reproduce the
   fetch receipt's byte count and SHA-256 digest exactly. It then parses those
   exact bytes as JSON, verifies source statement currency and balances against
   `prior_period`, derives each line's `source_ref` from the fetched final URL,
   and prepares unique existing-account bindings.
4. `categorize-lines` consumes only the normalized rows and chart carried by
   the admission packet. It recomputes their digests and materializes every
   proposed binding. Each line carries confidence, reason, matched evidence,
   and its fetched source reference.
5. `reconcile-readonly` consumes the categorized batch and admission-owned
   prior-period controls. It independently checks account membership and line
   coverage, recomputes the statement movement and ending balance, and emits
   `reconciliation{matched,unmatched}`.
6. `emit-readonly-artifact` runs only when the consumer found no unmatched
   evidence. It emits the typed `categorized[]`, `anomalies[]`, and
   `reconciliation` result plus fetched-source evidence and a digest of the
   consumed reconciliation.

The emitted `source` evidence includes the validated HTTP status, exact host
allowlist, final URL, fetched byte count, body digest, and
`exact_bytes_verified:true`. Final controls carry both
`source_fetch_performed:true` and `source_bytes_verified:true`.

Graph guards stop downstream work when the fetch is not ready, admission
returns `needs_review`, or the consumer finds a balance mismatch. A refused run
emits no final bookkeeping artifact.

## Source contract

The fetched document must be a JSON object with:

- `currency`: a three-letter currency matching `prior_period.currency`;
- `opening_balance_minor` and `expected_ending_balance_minor`: safe integers
  matching the supplied statement controls; and
- `transactions[]`: one to one hundred rows with `id`, `date`, `description`,
  signed integer `amount_minor`, and `counterparty`.

`web-fetch` must report a ready 2xx response, an allowlist decision of
`allowed`, a non-truncated text extraction, a final URL, and a SHA-256 content
digest. Because canonical `web-fetch` text extraction is intentionally
human-readable, the source document must be compact UTF-8 JSON whose extracted
string has the same byte count and SHA-256 digest as the fetched body. Pretty
printed JSON or content changed by text extraction is refused rather than
silently reconciled. Admission derives `source_ref` as
`<final_url>#transactions[<index>]`; the caller cannot substitute a different
source label.

## Matching contract

An account is eligible only when its declared direction matches the signed
transaction amount and at least one declared evidence item matches. Exact
counterparty evidence scores higher than a bounded description phrase. The top
score must be unique. A tie or no match returns `needs_review`, including the
candidate account codes and reason.

Every categorized entry contains:

- the fetched transaction ID, date, description, amount, currency, and a
  `source_ref` bound to the final fetched URL and array index;
- an `account_code` and `account_name` copied from `chart_of_accounts`;
- a numeric confidence score and a human-readable reason;
- the exact matched counterparty or description evidence; and
- `read_only: true`.

## Anomalies and reconciliation

The skill flags prior-period duplicate IDs, unfamiliar counterparties, currency
conflicts, and amount outliers. A duplicate, malformed line, unsupported
currency, ambiguous match, truncated fetch, or ending-balance mismatch prevents
the final artifact. Informational anomalies such as a new counterparty or a
large but otherwise well-bound amount remain visible for human review.

`reconciliation.matched` lists every accepted statement line and its existing
account binding. `reconciliation.unmatched` lists consumer-level failures such
as missing line coverage or a statement-balance difference. The consumer also
records the opening balance, net movement, calculated ending balance, expected
ending balance, and the digest of the categorized batch it consumed.

## Non-authority

This skill has one bounded network authority: the canonical `web-fetch` child
may read one URL whose host is in `source_allowlist`. It has no credential
input, provider-write permission, or ledger-write tool. It produces evidence
for a bookkeeper; it does not create journal entries, change a chart of
accounts, approve a close, or send data anywhere. A separate governed workflow
must review and post any resulting entry.
