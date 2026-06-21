---
name: standup-digest
description: Summarize bounded work events into a source-mapped standup digest with shipped work, blockers, risks, and next actions.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
---

# Standup Digest

Summarize bounded work events into a source-mapped standup digest.

Daily standups are useful only when the digest says what it read. This skill
consumes caller-supplied GitHub, issue, build, and note events and returns a
compact digest with shipped work, blockers, risks, and next actions. Every item
maps back to input event ids and preserves source timestamps or links when they
were supplied.

## What this skill does

1. Reads a bounded `work_events` array.
2. Deduplicates repeated events by id, URL, external ref, or title/kind/status.
3. Classifies events into shipped work, blockers, risks, and next actions.
4. Preserves a `source_map` for every digest item.
5. Emits evidence and a Markdown report when `output_dir` is provided.

## When to use this skill

Use it before a daily team update, async standup, handoff, or project review
when the caller already has a bounded packet of work events. It fits workflows
that need an evidence-backed summary without granting the run authority to read
private systems or post notifications.

## When not to use this skill

Do not use it to fetch issues, builds, or chat logs. Pair it with a separate
sync skill when data collection is needed. Do not use it to send Slack, email,
or issue comments; notification belongs behind a separate approval gate. If the
event packet is missing or empty, the skill returns `needs_more_evidence`
instead of creating a generic standup.

## Procedure

1. Parse `work_events` as an array of event objects.
2. Stop with `needs_more_evidence` when no events are supplied.
3. Deduplicate events using the first available stable key: `id`, `url`,
   `external_ref`, then a normalized title/kind/status key.
4. Classify merged events using explicit status, kind, labels, and text.
5. Build digest items with `summary`, `event_ids`, `timestamps`, and `links`.
6. Build `source_map` entries for every source event id.
7. Render `evidence.json` and `report.md` inside `output_dir` when requested.

## Edge cases and stop conditions

- **Empty packet:** return `needs_more_evidence`; do not invent team activity.
- **No event id:** synthesize a local `event-<n>` id and record that it came
  from the supplied packet.
- **Duplicate events:** collapse them and keep all source ids in the source map.
- **No source URL or timestamp:** keep the item, but record missing source
  fields in `missing_evidence`.
- **No clear category:** put the event in `next_actions` only when it names a
  pending action; otherwise keep it in `unclassified_events`.

## Output schema

```yaml
schema: runx.standup_digest.v1
decision: ready | needs_more_evidence
team: string
window: string
shipped:
  - summary: string
    event_ids: [string]
    timestamps: [string]
    links: [string]
blockers: []
risks: []
next_actions: []
source_map:
  - item: string
    event_ids: [string]
    evidence: string
missing_evidence:
  - event_id: string
    field: string
    reason: string
dedupe:
  input_events: number
  unique_events: number
```

The same object is returned as `evidence_json`. `report_md` is a human-readable
version with the same sections.

## Worked example

```bash
runx skill "$PWD/skills/standup-digest" \
  --input work_events='[
    {"id":"pr-12","kind":"pull_request","title":"Merge billing retry fix","status":"merged","timestamp":"2026-06-21T09:00:00Z","url":"https://github.com/acme/app/pull/12"},
    {"id":"ci-9","kind":"build","title":"Release candidate build failed on migration test","status":"failed","timestamp":"2026-06-21T09:20:00Z","url":"https://ci.example/build/9"}
  ]' \
  --input team="Payments" \
  --input window="2026-06-21" \
  --json
```

The output lists the merged PR under `shipped`, the failed build under
`blockers`, and maps both items back to their input event ids and URLs.

## Inputs

- `work_events`: required array of bounded event objects.
- `team`: optional team or project label.
- `window`: optional digest window.
- `output_dir`: optional package-local artifact output directory.

## Outputs

- `standup_digest`: complete source-mapped digest.
- `evidence_json`: same digest as machine-checkable JSON.
- `report_md`: concise Markdown report.
