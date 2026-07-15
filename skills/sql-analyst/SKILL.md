---
name: sql-analyst
description: Turn a bounded data question, schema summary, and sample rows into a reviewable SQL analysis plan.
runx:
  category: data
---

# SQL Analyst

Produce a safe, reviewable SQL analysis plan from a bounded question and enough
schema context to avoid guessing.

This skill is for read-only analysis. It should help an operator decide what to
query, how to validate it, and how to interpret the result. It does not execute
SQL, mutate data, or assume access to live databases. A consuming product or
front supplies schema summaries, sampled rows, and credentialed execution.

Tie every selected table and field to the supplied schema, state the validation
checks that would catch a misleading result, and keep interpretation separate
from observed data. Return `needs_schema` when required tables or fields are
unknown. Return `unsafe_request` for writes, deletes, unbounded export, or broad
PII access rather than translating them into SQL.

## Output

- `query_plan`: bounded read-only query shape, tables, fields, joins, and limits.
- `validation_checks`: tests for completeness, duplication, and interpretation errors.
- `interpretation_guidance`: how to read the result and what it cannot prove.
- `residual_risks`: schema gaps, privacy concerns, and unresolved assumptions.

## Inputs

- `question` (required): the business or product question.
- `schema_summary` (required): table and field summaries available to query.
- `sample_rows` (optional): representative non-sensitive rows.
- `constraints` (optional): limits, privacy rules, or allowed tables.
