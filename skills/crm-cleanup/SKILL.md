---
name: crm-cleanup
description: Read current CRM records from a public connector export, reconcile explicit transcript updates against a typed CRM schema, and execute changed fields through a receipt-backed mock CRM transport.
---

# CRM Cleanup

Turn post-call notes into a bounded CRM update without trusting stale pasted
records or claiming a write that never happened. This package reads the current
record during the run with native `web.fetch`, accepts only explicit update
directives for fields declared in `crm_schema`, and passes the validated update
map to an in-memory mock CRM transport. The receipt seals the source digest and
the transport's exact before/after records.

The mock transport is deliberate: it demonstrates the complete read/write
control loop without possessing credentials or mutating a production CRM.

## Inputs

- `source_handle`: a typed connector-export handle with `url`, `allowlist`, and
  the `record_id` to reconcile. The URL must return JSON containing either a
  top-level record array or `{ "records": [...] }`.
- `transcript`: call notes or transcript text. Put each update on its own line
  as `CRM update: field=value`. Optional `Takeaway: ...` lines become the
  `takeaways` output.
- `crm_schema`: the record ID field plus an object of writable field
  definitions. Supported value types are `string`, `number`, and `boolean`;
  definitions may also constrain enum values, lengths, or numeric ranges.

## Procedure

1. Digest the transcript and CRM schema with native `data.digest`.
2. Fetch `source_handle.url` with native `web.fetch`, enforcing the supplied
   host allowlist and a bounded response size.
3. Refuse unsuccessful or truncated reads, malformed JSON, a missing target
   record, duplicate directives, undeclared fields, and values that do not
   satisfy the field definition. A refusal performs no write.
4. Build `field_updates` as an object keyed by the corresponding
   `crm_schema.fields` key. Each changed field carries its prior value, new
   typed value, and the exact directive line as evidence.
5. A separate `write-through-transport` graph step consumes that same field
   map through the transport export in `crm-cleanup.mjs`. If any value changed,
   it applies all changes atomically and reports `executed: true`. If no
   directive changed current state, it reports `executed: false`, with
   identical before and after records.
6. A final verifier checks the transport result against the reconciliation
   plan, then seals `takeaways`, `field_updates`, `write_result`, source
   provenance, input digests, and validation findings in the typed
   `crm_cleanup_result` output.

## Output

`crm_cleanup_result` contains:

- `decision`: `updated`, `no_action`, or `refused`;
- `takeaways`: normalized transcript takeaways;
- `field_updates`: a schema-keyed object of evidence-backed changes;
- `write_result`: mock transport name, execution status, record ID, applied
  fields, and exact `before`/`after` records;
- `source_read`: connector kind, target record, allowlist, requested/final URL,
  HTTP status, source digest, fetch timestamp, and byte count;
- transcript/schema digests and deterministic validation findings.

## Stop conditions

- Do not accept records directly from the caller; the runtime source read is
  the current-state authority.
- Do not infer an update from conversational prose. Only explicit
  `CRM update: field=value` lines can write.
- Do not partially apply a transcript. Any malformed, duplicated,
  out-of-schema, or type-invalid directive refuses the whole write.
- Do not describe the mock transport as a production CRM mutation.
- Never put credentials, customer data, or a private URL in a public fixture.

## Worked example

With a source record whose `account_status` is `healthy`, this transcript:

```text
Takeaway: Rollout is blocked pending an executive review.
CRM update: account_status=at_risk
CRM update: next_action=send the Q3 usage report by Friday
```

produces two schema-keyed updates and a mock-transport result whose before
record remains `healthy` and whose after record is `at_risk`. Re-running with
`CRM update: account_status=healthy` against the same source seals `no_action`;
the transport executes no write and before equals after.
