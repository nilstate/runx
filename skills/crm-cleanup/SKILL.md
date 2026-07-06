---
name: crm-cleanup
version: "0.2.0"
description: Read an interaction transcript and a CRM schema, extract grounded takeaways, map them to allowed CRM fields, and emit a gated write_proposal. Performs no live CRM write.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
  input_resolution:
    required:
      - transcript
      - crm_schema
---

## What this skill does

CRM Cleanup keeps pipeline data from rotting after calls. It reads an
interaction `transcript` and a `crm_schema`, extracts grounded takeaways from
the transcript, maps those takeaways to the CRM fields allowed by
`crm_schema`, and emits a gated `write_proposal` that an operator can review
before any write is performed.

**This skill performs no live CRM write.** The `write_proposal` is gated: it
carries a `gate` field set to `"proposed"` and never executes against a real
connector. It is advisory only.

For each run the skill produces:

- **takeaways** — factual statements grounded in the transcript, each with the
  source quote it was derived from.
- **field_updates** — proposed updates to CRM fields, where every update traces
  to a takeaway and targets only fields declared in `crm_schema`.
- **write_proposal** — a gated proposal object summarizing the field_updates,
  with `gate: "proposed"` and `performed_write: false`.

## When to use this skill

Use this skill when an agent or operator needs a safe, first-pass mapping from
a call/meeting transcript into structured CRM field updates:

- After a sales call, extracting takeaways and proposing CRM field updates.
- After a support interaction, mapping resolution notes to CRM fields.
- Auditing whether a transcript yields actionable CRM updates before a human
  commits them.
- Producing a reviewable, gated proposal so no unreviewed write hits the CRM.

## When not to use this skill

Do not use this skill as a CRM writer or connector. It does not perform any
live write, API call, or data mutation. Do not use it to:

- Actually update, create, or delete CRM records.
- Call a CRM connector (Salesforce, HubSpot, etc.).
- Enrich records from external data providers.
- Merge or deduplicate contacts.

If the caller needs to act on the proposal, a separate governed skill with
write authority must perform the changes under its own receipt.

## Procedure

1. Require `transcript` to be a non-empty string and `crm_schema` to be an
   object with a `fields` array. If either is missing or malformed, stop with
   an error.
2. Parse the `crm_schema.fields` array. Each field has a `name` and a `type`
   (e.g. `string`, `enum`, `date`). Only fields listed here may be targeted by
   `field_updates`.
3. Scan the `transcript` for grounded takeaways — factual statements about the
   contact/company/deal that can be mapped to a CRM field. Each takeaway must
   include the source `quote` from the transcript.
4. For each takeaway that maps to an allowed CRM field, emit a `field_update`
   keyed to that field name. Every `field_update` traces to a takeaway via
   `takeaway_id` and targets only fields allowed by `crm_schema`.
5. If no actionable takeaways map to allowed fields, produce an empty
   `field_updates` array — this is the no-op path.
6. Build a `write_proposal` object with `gate: "proposed"`,
   `performed_write: false`, and the list of proposed `field_updates`. This
   proposal is gated and never executes.
7. Return a JSON object with `takeaways`, `field_updates`, and
   `write_proposal`. The run does not modify any data.

## Edge cases and stop conditions

Return a stop (exit non-zero) when:

- `transcript` is missing, not a string, or an empty/whitespace-only string.
- `crm_schema` is missing, not an object, or lacks a `fields` array.
- `crm_schema.fields` is empty or contains entries without a `name`.

A transcript that yields no mappable takeaways is not an error — it produces
an empty `field_updates` array (the no-op path) with `write_proposal.gate`
still set to `"proposed"` and `performed_write: false`.

The authority scope is read-only analysis and gated proposal emission. The
proof surface is the sealed receipt containing takeaways, field_updates, and
the gated write_proposal. Any actual CRM write requires a separate governed
skill.

## Output schema

```json
{
  "takeaways": [
    {
      "id": "tk1",
      "text": "The contact is the VP of Engineering.",
      "quote": "I'm the VP of Engineering here at Acme."
    }
  ],
  "field_updates": [
    {
      "field": "title",
      "value": "VP of Engineering",
      "takeaway_id": "tk1",
      "source_quote": "I'm the VP of Engineering here at Acme."
    }
  ],
  "write_proposal": {
    "gate": "proposed",
    "performed_write": false,
    "field_updates": [
      {
        "field": "title",
        "value": "VP of Engineering",
        "takeaway_id": "tk1"
      }
    ],
    "note": "Gated proposal — no live CRM write performed. Review before applying."
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --input-json transcript='Sarah Chen called in from Acme Corp. She said "I am the VP of Engineering here." She asked about the enterprise plan and mentioned a budget of $50k for Q3.' \
  --input-json crm_schema='{"fields":[{"name":"title","type":"string"},{"name":"company","type":"string"},{"name":"deal_value","type":"number"},{"name":"stage","type":"enum","options":["lead","qualified","closed"]}]}' \
  --json
```

Expected result: takeaways include the title (VP of Engineering), company
(Acme Corp), and deal value ($50k). `field_updates` maps `title`, `company`,
and `deal_value`. `write_proposal.gate` is `"proposed"` and
`performed_write` is `false`. The run does not modify any data.

## Inputs

- `transcript`: string. The interaction transcript (call/meeting notes). Must
  be non-empty.
- `crm_schema`: object with a `fields` array. Each field has `name` (string)
  and `type` (`string`, `enum`, `number`, `date`, `boolean`). Optional
  `options` for enum fields. Only fields in this schema may be targeted by
  `field_updates`.
