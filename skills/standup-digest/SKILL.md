# Standup Digest

`standup-digest` turns a bounded set of work events into a deterministic,
receipt-verifiable standup packet. It does not fetch data or send messages.
Every digest item points back to one or more input event IDs and preserves the
source timestamps and links.

## Input

Pass `work_events` as an object:

```json
{
  "team": "runx",
  "window": {
    "start": "2026-06-20T00:00:00Z",
    "end": "2026-06-21T00:00:00Z"
  },
  "events": [
    {
      "id": "evt-pr-42",
      "type": "pull_request",
      "title": "Ship deterministic receipt verifier",
      "status": "merged",
      "timestamp": "2026-06-20T16:10:00Z",
      "url": "https://github.com/runxhq/runx/pull/42",
      "labels": ["release"],
      "owner": "ada"
    }
  ]
}
```

An optional `policy` object may override classification values:

- `shipped_statuses`
- `blocker_statuses`
- `blocker_labels`
- `risk_labels`
- `next_action_labels`

## Output contract

The skill emits:

- `shipped`
- `blockers`
- `risks`
- `next_actions`
- `source_map`
- `digest_meta`

Each digest item includes `source_event_ids`, `timestamps`, and `links`.
`source_map` provides the reverse lookup from each digest item to its source
events. `digest_meta` reports input, accepted, deduplicated, and ignored event
counts plus the applied blocker criteria.

## Determinism and safety

Events without an ID or without a title/body are ignored and reported in
`digest_meta`. Duplicate IDs and duplicate source URLs are collapsed while
retaining all traceable source IDs, timestamps, and links. Sorting uses the
event timestamp and then the event ID. The runner performs no network calls,
writes no files, and has no side effects.

## Composition

- Use `github-sync` before this skill to produce bounded GitHub events.
- Use `issue-triage` before this skill when raw issues need labels or priority.
- Use `slack-notify` after this skill to deliver the resulting packet.

This separation keeps collection, classification, digest generation, and
delivery independently governed and independently receipted.

