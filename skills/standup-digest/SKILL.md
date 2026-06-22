---
name: standup-digest
version: 0.1.0
description: Produce a source-mapped daily standup digest from bounded work events without reading private systems or posting updates.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/runxhq/runx/tree/main/skills/standup-digest
runx:
  category: ops
  input_resolution:
    required:
      - work_events
---

## What this skill does

Create a daily standup digest from a bounded packet of GitHub, issue, build, and
note events. The runner emits shipped work, blockers, risks, next actions, and a
source map so every digest item can be traced back to the exact event ids it
read.

This skill does not fetch live repositories, read private inboxes, post to chat,
edit issues, trigger builds, or mutate project state. It only summarizes the
events supplied by the caller.

## When to use this skill

Use this skill when an operator or graph already has a bounded set of work
events and needs a trustworthy daily standup packet. It fits after collection
skills such as `github-sync` or issue triage, and before notification skills
such as `slack-notify` or `send-as`.

## When not to use this skill

Do not use it as a project crawler, team surveillance tool, chat sender, build
system controller, or source of truth for work it was not given. If the packet
does not contain enough events to support a digest, the output should identify
the missing evidence instead of inventing status.

## Procedure

1. Require `work_events` to contain an `events` array.
2. Normalize each event into an id, type, timestamp, title, body, url, actor,
   labels, and status.
3. Drop exact duplicate event ids and near-duplicate event fingerprints.
4. Classify events into shipped work, blockers, risks, and next actions.
5. Preserve timestamps and links whenever the event includes them.
6. Emit a `source_map` where every digest item id maps to one or more source
   event ids.
7. Include digest metadata for event counts, duplicate handling, blocker
   criteria, reporting window, and skipped noisy inputs.
8. Stop with an empty but valid digest when no useful events remain after
   dedupe.

## Edge cases and stop conditions

Return a validation error when `work_events` is missing or `events` is not an
array. Treat missing event ids as noisy input and skip those records. Treat
duplicate ids or duplicate fingerprints as duplicates and report their ids in
`digest_meta.duplicates`.

If an event claims a blocker or risk without a useful title or body, include it
only in `digest_meta.skipped_events`; do not create an uncited digest item. A
future sender must use a separate governed skill, because this skill never posts
or sends the digest.

## Output schema

The runner emits `runx.ops.standup_digest.v1`:

```json
{
  "shipped": [
    {
      "id": "shipped-1",
      "summary": "Merged checkout retry fix",
      "source_event_ids": ["gh-101"],
      "timestamp": "2026-06-21T09:20:00Z",
      "link": "https://github.com/example/app/pull/101"
    }
  ],
  "blockers": [
    {
      "id": "blocker-1",
      "summary": "Deploy blocked by missing staging token",
      "source_event_ids": ["build-77"],
      "criteria": ["failed_build", "blocked_label"],
      "timestamp": "2026-06-21T10:02:00Z",
      "link": "https://ci.example.test/build/77"
    }
  ],
  "risks": [
    {
      "id": "risk-1",
      "summary": "Payment migration lacks rollback owner",
      "source_event_ids": ["note-9"],
      "timestamp": "2026-06-21T11:30:00Z",
      "link": null
    }
  ],
  "next_actions": [
    {
      "id": "next-1",
      "summary": "Assign staging token owner",
      "owner": "ops",
      "source_event_ids": ["build-77"],
      "timestamp": "2026-06-21T10:02:00Z",
      "link": "https://ci.example.test/build/77"
    }
  ],
  "source_map": {
    "shipped-1": ["gh-101"],
    "blocker-1": ["build-77"],
    "risk-1": ["note-9"],
    "next-1": ["build-77"]
  },
  "digest_meta": {
    "team": "Example Team",
    "window": "2026-06-21",
    "input_event_count": 4,
    "used_event_count": 3,
    "duplicate_count": 1,
    "duplicates": ["gh-101-copy"],
    "skipped_events": [],
    "blocker_criteria": ["blocked label", "failed build", "explicit blocker text"],
    "side_effects": "none"
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --runner digest \
  --input-json work_events='{
    "events": [
      {
        "id": "gh-101",
        "type": "pull_request",
        "status": "merged",
        "title": "Checkout retry fix merged",
        "timestamp": "2026-06-21T09:20:00Z",
        "url": "https://github.com/example/app/pull/101"
      }
    ]
  }' \
  --input-json policy='{ "team": "Example Team", "window": "2026-06-21" }' \
  --json
```

Expected result: `shipped` contains the merged pull request, every digest item
has `source_event_ids`, and `digest_meta.side_effects = none`.

## Inputs

- `work_events`: object with an `events` array. Each event should include `id`,
  `type`, `title` or `body`, and may include `status`, `timestamp`, `url`,
  `actor`, `labels`, and `owner`.
- `policy`: optional object with `team`, `window`, `blocker_labels`, and
  `risk_labels`.

## Outputs

- `shipped`: completed or merged work items.
- `blockers`: items that block progress.
- `risks`: non-blocking concerns that may threaten delivery.
- `next_actions`: concrete follow-ups inferred from blocker/action signals.
- `source_map`: digest item id to source event ids.
- `digest_meta`: counts, duplicate/noise handling, blocker criteria, and
  side-effect posture.
