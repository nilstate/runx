# Bookkeeper fixtures

The harness cases live in `X.yaml`. Each case uses a commit-pinned public Gist
URL and the real canonical `web-fetch` child, so the receipt proves the same
allowlisted network-read graph used in production:

- `sourced-clean-batch-reconciles` fetches three uniquely matchable rows and
  seals an exact statement-balance reconciliation.
- `ambiguous-account-binding-needs-review` fetches one row for which two
  existing accounts tie. Admission returns `needs_review`, and graph policy
  refuses downstream categorization.
- `statement-balance-mismatch-needs-review` fetches one uniquely matchable row
  but differs from the source statement ending balance by one minor unit. The
  reconciliation consumer returns `needs_review`, and policy prevents the final
  artifact.
- `direct-transaction-input-is-refused` fetches the clean source but also
  supplies a caller-owned transaction row. Preflight rejects the run before
  the network step, proving fetched statement bytes are the only accepted
  transaction source.
- `wildcard-source-allowlist-is-refused` proves broad wildcard network
  authority is blocked before `web-fetch`.
- `lossy-text-extraction-is-refused` fetches an older pretty-printed statement
  whose readable extraction no longer matches the fetched-body digest.
  Admission refuses it instead of parsing transformed bytes.
- `invalid-calendar-date-is-refused` fetches a compact statement containing
  `2026-02-31`; admission rejects the rollover date before categorization.

The older `*-input.json` files are data-shape samples only; the production
runner refuses direct `transactions` input.

`dogfood-public-input.json` contains no transaction rows. It names an
allowlisted public JSON statement, and the live `web-fetch` step retrieves those
rows during the same run before admission, categorization, and reconciliation.
All success-path source files are compact UTF-8 JSON so admission can prove the
extracted bytes exactly match the fetch receipt's byte count and SHA-256 digest.
