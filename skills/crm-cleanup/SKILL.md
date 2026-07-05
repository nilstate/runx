---
name: crm-cleanup
description: Analyze a list of CRM contacts/records to identify duplicates, missing fields, stale entries, and suggest merge/cleanup actions. Never modifies any data — only produces a read-only cleanup report.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
  input_resolution:
    required:
      - contacts
---

## What this skill does

Takes a list of CRM contacts/records and produces a **read-only cleanup report**.
It identifies four classes of data-quality issues and suggests remediation actions,
but it never creates, updates, deletes, or merges any records. All suggestions are
advisory.

For each batch of contacts the skill detects:

- **Duplicates** — records that appear to represent the same person or company,
  matched on normalized email, normalized phone, or a fuzzy name+company key.
- **Missing fields** — records missing required fields (`name`, `email`, or
  `company`) or that have empty/whitespace-only values.
- **Stale entries** — records whose `last_contacted_at` is older than the
  configured staleness threshold (default 365 days), or that have no
  `last_contacted_at` at all.
- **Suggested actions** — for each issue, a non-destructive recommendation such
  as `merge_suggestion`, `fill_missing_field`, `archive_stale`, or
  `review_duplicate`. None of these actions are executed.

The output is a structured JSON report intended for human or agent review before
any cleanup is performed.

## When to use this skill

Use this skill when an agent or operator needs a safe, first-pass assessment of
CRM data quality:

- Auditing a contact list for duplicates before a dedupe operation.
- Finding records with missing required fields before an import or export.
- Identifying stale contacts that may warrant archival.
- Producing a merge/cleanup worklist for a human to act on.

## When not to use this skill

Do not use this skill as a data writer, dedupe executor, or migration tool. It
does not modify, delete, merge, or move any records. Do not use it to:

- Actually merge or delete duplicate contacts.
- Enrich records by calling external data providers.
- Send re-engagement emails to stale contacts.
- Fix or auto-fill missing fields in the source system.

If the caller needs to act on the report, a separate governed skill with write
authority must perform the changes under its own receipt.

## Procedure

1. Require `contacts` to be a non-empty array of contact objects. Each contact
   must have at least an `id` field. If `contacts` is empty or not an array,
   stop with an error.
2. Read optional `cleanup_policy` for thresholds:
   - `staleness_days` (default 365) — contacts older than this are stale.
   - `required_fields` (default `["name", "email", "company"]`).
3. For each contact, normalize email (lowercase, trim), phone (digits only), and
   name (lowercase, collapse whitespace) for matching.
4. Detect duplicates by grouping on normalized email, normalized phone, and a
   fuzzy name+company key. Any group with more than one distinct `id` is a
   duplicate set.
5. Detect missing fields by checking each required field for absence or
   empty/whitespace value.
6. Detect stale entries by comparing `last_contacted_at` (ISO 8601) against the
   staleness threshold. Records with no `last_contacted_at` are flagged as
   stale with reason `no_contact_date`.
7. For each issue, emit a suggested action. Suggestions are advisory only and
   carry no authority to modify data.
8. Return a JSON report with `summary` counts and `issues` arrays. The run does
   not modify any data.

## Edge cases and stop conditions

Return a stop (exit non-zero) when:

- `contacts` is missing, not an array, or an empty array.
- A contact is missing its `id` field (cannot be uniquely referenced).
- `staleness_days` is provided but is not a positive number.
- `required_fields` is provided but is not an array of strings.

A contact with no `last_contacted_at` is not an error — it is reported as stale
with reason `no_contact_date`. A contact with an unparseable `last_contacted_at`
is reported as stale with reason `unparseable_date` but does not stop the run.

The authority scope is read-only analysis and reporting. The proof surface is
the sealed receipt containing the cleanup report summary and issue list. Any
actual merge, delete, or update requires a separate governed skill.

## Output schema

```json
{
  "summary": {
    "total_contacts": 5,
    "duplicate_sets": 1,
    "duplicates_count": 2,
    "missing_fields_count": 1,
    "stale_count": 1,
    "total_issues": 4
  },
  "duplicates": [
    {
      "match_key": "email",
      "match_value": "alice@example.com",
      "contact_ids": ["c1", "c3"],
      "suggested_action": "merge_suggestion",
      "note": "Possible duplicate based on matching email. Review before merging."
    }
  ],
  "missing_fields": [
    {
      "contact_id": "c2",
      "missing": ["email"],
      "suggested_action": "fill_missing_field",
      "note": "Contact is missing required field(s). No data modified."
    }
  ],
  "stale_entries": [
    {
      "contact_id": "c4",
      "last_contacted_at": "2024-01-15T00:00:00Z",
      "days_since_contact": 537,
      "reason": "exceeds_threshold",
      "suggested_action": "archive_stale",
      "note": "Contact is stale. Consider archiving after review."
    }
  ],
  "actions": [
    {
      "type": "merge_suggestion",
      "contact_ids": ["c1", "c3"],
      "priority": "high"
    }
  ]
}
```

## Worked example

```bash
runx skill "$PWD" \
  --input-json contacts='[
    {"id":"c1","name":"Alice Smith","email":"alice@example.com","company":"Acme","last_contacted_at":"2026-06-01T10:00:00Z"},
    {"id":"c2","name":"Bob Jones","company":"Globex","last_contacted_at":"2026-05-01T10:00:00Z"},
    {"id":"c3","name":"Alice S.","email":"alice@example.com","company":"Acme Inc","last_contacted_at":"2026-06-02T10:00:00Z"}
  ]' \
  --input-json cleanup_policy='{"staleness_days":365,"required_fields":["name","email","company"]}' \
  --json
```

Expected result: `summary.total_contacts = 3`, one duplicate set matching
`c1` and `c3` on email `alice@example.com`, and one missing-field issue on `c2`
(missing `email`). The run does not modify any data.

## Inputs

- `contacts`: array of contact objects. Each object must have an `id` (string).
  Optional fields: `name` (string), `email` (string), `phone` (string),
  `company` (string), `last_contacted_at` (ISO 8601 string).
- `cleanup_policy`: optional object with `staleness_days` (positive number,
  default 365) and `required_fields` (array of strings, default
  `["name", "email", "company"]`).
