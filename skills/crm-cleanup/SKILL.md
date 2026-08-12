---
name: crm-cleanup
description: Reconcile a call transcript against a fetched CRM export and execute only high-confidence, allowlisted field updates through a bounded CRM transport.
---

# CRM Cleanup

Keep customer records useful after calls without letting an agent write on
vibes. The skill reads a declared CRM export at run time, reconciles it with a
transcript, requires verbatim evidence and confidence of at least `0.8`, then
executes only allowlisted changes through the bounded CRM transport. An
uncertain, unsupported, or stale proposal becomes `needs_review` and performs
no write. A transcript with no actionable change produces a sealed no-op.

## Procedure

1. Fetch the exact allowlisted CRM export through `web-fetch`; the source URL,
   HTTP status, body digest, and fetch time are retained in the result.
2. Reconcile the fetched records and transcript. Each proposed update must
   name an existing record, an allowlisted field, a non-empty value, a verbatim
   transcript quote, and a confidence score.
3. Apply the confidence gate. Any score below `0.8`, invented quote, unknown
   record, or field outside `crm_schema.allowed_fields` routes the entire
   decision to human review without a write.
4. Execute accepted updates through the bounded CRM transport and seal the
   before/after records in `write_result`. The transport is deliberately
   bounded and mockable for local dogfood; it never reaches an unscoped CRM.
5. Return the source evidence, transcript digest, field updates, write result,
   no-op status, and confidence-gate outcome in one receipt-safe packet.

## Inputs

- `source_url` and `source_allowlist`: the public connector export to fetch.
- `transcript`: the call transcript used as the only change evidence.
- `crm_schema.allowed_fields`: the update authority.

## Output

`crm_cleanup_result` (`runx.crm_cleanup.v1`) contains `decision` (`updated`,
`no_action`, or `needs_review`), source read evidence, transcript-bound field
updates, `write_result{before,after}`, and the confidence gate. The output never
contains credentials or raw secrets.

## Agent task contract

### `crm-cleanup-reconcile`

Read the fetched `source_records`, transcript, and allowlist. Return
`update_draft.updates`, each with `record_id`, `field`, `to`, an exact
`evidence_quote`, and a numeric `confidence` from 0 to 1. Return an empty array
when no supported change exists. Use confidence below `0.8` when the transcript
is hedged or ambiguous so the deterministic gate routes it to review. Never
invent a record, quote, or value.
