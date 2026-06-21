---
name: standup-digest
description: Convert bounded work events into a source-mapped standup digest.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
---

# Standup Digest

Group bounded work events into shipped work, blockers, risks, and next actions.
Every output item maps back to the event ids it came from.

This skill does not read calendars, GitHub, Slack, or inboxes directly. A caller
must provide the bounded event packet.

## Procedure

1. Require `work_events`.
2. Normalize event ids, titles, timestamps, links, and summaries.
3. Remove duplicate event ids.
4. Classify shipped items, blockers, risks, and next actions.
5. Emit a `source_map` for every digest item.

## Inputs

- `work_events`: array or object containing bounded events.
- `digest_policy`: optional period and grouping preferences.

## Outputs

- `shipped`, `blockers`, `risks`, `next_actions`.
- `source_map`: digest item to input event mapping.
- `evidence`: event counts, duplicate count, and classification rules.

