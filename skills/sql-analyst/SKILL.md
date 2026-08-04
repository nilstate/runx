---
name: sql-analyst
description: Produce a schema-validated, read-only SQL analysis plan and explicit governed execution handoff without running raw SQL.
runx:
  category: data
---

# SQL Analyst

Use this skill to turn a bounded data question into a reviewable read-only query
plan.

The schema and optional sample snapshot must carry stable upstream SHA-256
digests and observation times. Runx treats them as caller-supplied provenance,
not provider verification. Deterministic admission rejects stale or malformed
sources, write intent, invalid identifiers or dialects, unknown allowed tables,
and unbounded row requests before the model runs. The model designs a plan
against a normalized table/field index. A deterministic finalizer then rejects
invented tables and fields, untyped joins, unstructured filters, literal filter
values, invalid limits, incomplete interpretation, and write tokens.

This skill never emits or executes raw SQL. Without an execution context, a
ready plan is `planned_only`. With a validated `execution_context`, it emits an
exact handoff to `data-store.read_projection`, `read_events`, or
`list_stream_heads`. That handoff reads only a declared bounded resource; it
does not translate model-authored prose into arbitrary SQL.

## Inputs

- `question`: bounded analysis question.
- `schema_summary`: source-bound available tables and fields.
- `dialect`: `postgres`, `sqlite`, or `mysql`.
- `as_of` and `max_schema_age_days`: deterministic source-freshness boundary.
- `sample_rows`: optional source-bound snapshot containing at most 20
  non-sensitive rows.
- `constraints`: allowed tables, maximum rows, and privacy limits.
- `execution_context`: optional exact governed data-store read runner and
  bounded resource inputs.

## Output

A `runx.data.sql_analysis_plan.v1` packet with a validated query plan,
interpretation checks, residual risks, and an explicit non-executed handoff.

## Agent task contracts

### `sql-plan`

Produce sql_plan_draft using only analysis_context tables and qualified fields. Return decision,
query_plan, validation_checks, interpretation, and residual_risks. The plan is read-only and
does not execute. Use the declared dialect and bounded limit. Do not invent schema, request
credentials, expose PII, or emit write SQL.
