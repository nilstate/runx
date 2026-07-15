# Bookkeeper fixtures

- `clean-input.json` exercises three uniquely sourced account bindings and an
  exact statement-balance reconciliation.
- `ambiguous-input.json` gives two existing accounts the same top score. The
  admission step returns `needs_review`, and graph policy refuses downstream
  categorization.
- `statement-mismatch-input.json` reaches the independent reconciliation
  consumer but differs from the expected ending balance by one minor unit. The
  consumer returns `needs_review`, and policy prevents the final artifact.

The post-publish dogfood input is deliberately different from every harness
fixture. Its `source_ref` values point to a separately published, public input
artifact, and the reconciliation step consumes the resulting categorizations.
