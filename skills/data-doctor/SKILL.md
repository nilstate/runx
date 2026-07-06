---
name: data-doctor
version: 0.1.0
description: Compute grounded missingness, uniqueness, type-drift, and range checks for a bounded dataset without mutating its rows.
links:
  source: https://github.com/runxhq/runx/tree/main/skills/data-doctor
runx:
  category: data
  input_resolution:
    required:
      - dataset
      - schema
      - quality_rules
---

## What this skill does

`data-doctor` evaluates a bounded JSON dataset against an explicit schema and
quality rules. It computes row counts, per-column missingness, uniqueness,
type drift, and configured numeric ranges. It returns findings,
recommendations, and a read-only report.

The skill never edits rows, invents columns, guesses anomaly causes, or writes
to an external data system.

## Inputs

- `dataset`: an array of JSON objects.
- `schema`: `{fields:{name:{type,required,unique}}}` where type is `string`,
  `number`, `boolean`, or `object`.
- `quality_rules`: optional `{max_missing_rate, ranges}` thresholds.

## Outputs

- `metrics`: row count and per-field missing, unique, and type-drift metrics.
- `findings[]`: grounded checks with field, rule, observed value, and severity.
- `recommendations[]`: bounded remediation suggestions tied to findings.
- `report`: overall status plus check counts.

Malformed rows or a missing schema return `status: refused` with no invented
metrics. Valid empty datasets are allowed and report zero rows.

## Example

```bash
runx skill ./skills/data-doctor \
  --input-json dataset='[{"id":"a1","amount":10}]' \
  --input-json schema='{"fields":{"id":{"type":"string","required":true,"unique":true},"amount":{"type":"number"}}}' \
  --input-json quality_rules='{"max_missing_rate":0.1,"ranges":{"amount":{"min":0,"max":100}}}' \
  --json
```

Verify the receipt with `runx verify --receipt <receipt.json> --json`.

