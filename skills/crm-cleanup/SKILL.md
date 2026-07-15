---
name: crm-cleanup
description: >-
  Reads live CRM records from a real source (data-store read_projection or
  connector export), reconciles a call transcript against them, decides field
  updates bounded to a crm_schema allowlist, and executes them through a CRM
  transport that seals a before/after diff. Keeps pipeline data from rotting
  after calls. Read-only preview — refuses any mutate/append/advance framing.
runx.category: ops
---

# crm-cleanup

CRM Cleanup keeps pipeline data from rotting after calls. It reads the current
CRM records from a real source, reconciles a call transcript against them,
decides the field updates, and executes them through a CRM transport, sealing a
before/after diff. The whole read → decide → write loop is proven in one sealed
dogfood run.

## What it does

1. **Read** the current CRM records from a real source at runtime — a
   `data-store read_projection` logical ref (`data_source_ref`) or a connector
   export file (`crm_export_ref`). The dogfood run reads live records, not a
   hand-pasted fixture argument.
2. **Reconcile** a call `transcript` against the source record. Deterministic,
   explainable cues derive candidate field updates (at-risk / lagging / renewal
   intent / next-action). Every update traces to a source record.
3. **Decide** `field_updates` constrained to the `crm_schema` allowlist
   (`account_status`, `next_action`, `owner`, `health_score`, `last_contact`,
   `renewal_date`, `arr`, `tags`). Updates outside the allowlist are dropped.
4. **Execute** through a CRM transport (mock transport is fine) that seals a
   `write_result{before, after}` bound to the decision. No-op when nothing
   actionable changes.

## Read-only contract

This skill is a **preview/decision** skill. It reconciles and seals a proposed
before/after diff but does **not** mutate live CRM records. If `mutate: true`
(or `append` / `advance`) is passed, the `refuse` runner engages and the run
pauses for operator confirmation (`needs_agent`) instead of writing. To actually
push updates to a live CRM, wire the proposed `field_updates` into your CRM
write path out of band — the sealed diff is the audit artifact.

## Inputs

| input | type | required | notes |
|-------|------|----------|-------|
| `data_source_ref` | string | yes | Real CRM source ref (read_projection logical ref or connector export anchor). |
| `crm_export_ref` | string | no | Path to a connector export (JSON array of records). Runtime source read. |
| `case_id` | string | yes | CRM account/case id to reconcile. |
| `transcript` | string | yes | Call transcript text. |
| `crm_schema` | json | no | Allowlist of writable fields; default allowlist used when omitted. |
| `health_baseline` | json | no | Read-only baseline overrides (threshold_days_stuck, cap_pressure_pct, refusal_spike_rate). |
| `mutate` | bool | no | When true, the skill refuses (read-only contract). |

## Outputs

- `crm_cleanup.takeaways` — `case_id`, source read count, `field_updates`
  (each traced to a `source_ref`), and the executed `write_result{before, after}`.
- `write_result` — `before`/`after` snapshot; `changed: true` only when updates
  were applied; `changed: false` for the no-op path.

## Harness

- `crm-cleanup-reconcile-sealed` — at-risk transcript yields `account_status: at_risk` + sealed write_result.
- `crm-cleanup-renewal-recover-sealed` — renewal intent recovers an at-risk account; sealed write_result.
- `crm-cleanup-noop-sealed` — no actionable change; no-op path seals `changed: false`.
- `crm-cleanup-readonly-stop` — `mutate: true` engages the `refuse` runner → `needs_agent`.

## Example

```bash
runx skill mamonisme/crm-cleanup@<version> --registry https://api.runx.ai \
  -i data_source_ref=local://runx-crm/cleanup-dev \
  -i crm_export_ref=fixtures/crm-records.json \
  -i case_id=globex-002 \
  -i transcript="Customer has gone quiet and said they are considering not renewing." \
  --json
```

## Install

```bash
runx add mamonisme/crm-cleanup@<version>
```
