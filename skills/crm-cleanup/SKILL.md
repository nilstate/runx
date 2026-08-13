---
name: crm-cleanup
description: Read one current CRM record from a bounded runtime source, derive allowlisted transcript-supported changes, write exactly one idempotent CRM mutation event, and verify it by provider readback.
---

# CRM Cleanup

Turn call notes into a verified CRM write without letting an agent mutate
arbitrary fields on vibes. The default runner first fetches the current record
from an operator-selected public JSON source, then reconciles the transcript,
enforces field-level authority deterministically, and commits at most one
idempotent update event through an operator-bound data-store transport. A
successful result is sealed only after the runtime reads the exact event back.

The SQLite data adapter is a safe mock CRM transport for harnesses and local
dogfood. Production operators bind the same `data_source_ref` contract to their
governed CRM event transport; the skill never receives provider credentials.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `data-store#append_event`
- `data-store#read_events`

## Procedure

1. Native `http.read` performs the source-of-truth web fetch using the caller's
   exact URL and host allowlist. The response must be a complete HTTP 200 JSON document
   shaped as `{ "records": [...] }` and contain exactly one `record_id` match.
   Hand-pasted `crm_records` are not accepted.
2. Native `data.digest` binds the exact transcript. The reviewer agent sees
   only the fetched record, transcript, and field allowlist, and returns
   candidate updates with verbatim evidence quotes.
3. Deterministic code requires the fetched record id, an allowlisted field, a
   non-empty value, and a quote that occurs verbatim in the transcript. An
   unknown record, invented quote, or empty value refuses the run. Fields
   outside the allowlist are explicitly rejected and never written.
4. When valid updates exist, the skill creates one
   `runx.crm_cleanup.write_event.v1` containing the sealed before and after
   records and calls `data-store#append_event` with the caller's expected
   version and idempotency key.
5. The skill calls `data-store#read_events` in the same run and verifies the
   exact event body, digest, event ref, and idempotency key. Only that matched
   provider readback may produce `decision: updated`.
6. `no_action` and `refused` terminate before the append step. Their
   `write_result.performed` is false, so a no-op harness proves that no write
   occurred instead of merely claiming it.

## Output

`crm_cleanup_result` (`runx.crm_cleanup_result.v1`) includes:

- `decision`: `updated`, `no_action`, or `refused`;
- concise `takeaways` and transcript-traced `field_updates`;
- source URL, fetch digest, and record id;
- `write_result` with the actual transport status, versions, idempotency key,
  event ref/digest, sealed `before` and `after` records, provider evidence, and
  `readback_verified`;
- deterministic validation findings and rejected out-of-authority fields.

## Inputs and authority

- `crm_source_url`, `source_allowlist`, and `record_id` identify the bounded
  runtime read.
- `transcript` is the only semantic evidence for a field change.
- `crm_schema.allowed_fields` is the complete update authority.
- `data_source_ref`, `resource`, and `aggregate_id` select the governed CRM
  mutation transport.
- `expected_version` prevents stale writes; `idempotency_key` prevents duplicate
  effects on retry.

The operator must bind `RUNX_DATA_SOURCES` (or the hosted equivalent) to the
selected transport. Do not place secrets, auth headers, cookies, or private CRM
exports in skill inputs or receipts.

## Agent task contract

### `crm-cleanup-reconcile`

Read `transcript`, the runtime-fetched `crm_record`, and `crm_schema`. Return
`update_draft.updates`, each containing `record_id`, `field`, `to`, and
`evidence_quote`. Quote the transcript verbatim, target only the fetched record
and allowed fields, and return an empty array when nothing changed. Never
invent records, quotes, values, or write authority.
