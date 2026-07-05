---
name: meeting-followup
description: Parse meeting transcript or notes into structured action items with owners, due dates, and priorities. Reads meeting text and emits a bounded action_items payload — it never schedules, sends, or assigns tasks in any external system.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
  input_resolution:
    required:
      - meeting
---

## What this skill does

Parse one meeting transcript or set of notes and extract structured action
items from it. Each action item has:

- **owner**: the person responsible (extracted from the text, or `unassigned`
  when no owner is identifiable).
- **due_date**: an ISO 8601 date the action is due, resolved against the
  meeting date (or today) when relative phrases like "next Friday" or "by EOW"
  appear. `null` when no due date is stated.
- **priority**: `high`, `medium`, or `low`, derived from explicit priority
  language ("urgent", "P0", "high priority") and deadlines that fall within
  48 hours.
- **description**: a short summary of the action.

The skill also returns a `summary` of the meeting and the count of action
items found. It never writes to a task tracker, calendar, or messaging tool.
It produces the structured payload that a separate governed skill can review,
approve, and deliver.

## When to use this skill

Use this skill when an agent has meeting notes or a transcript and needs a
safe first pass at turning the discussion into actionable, owned, dated work:

- Extract action items from a standup, sync, or planning meeting.
- Identify owners and due dates mentioned in the text.
- Assign a priority to each action based on stated urgency and deadline.

## When not to use this skill

Do not use this skill as a task tracker, calendar writer, reminder sender, or
notification dispatcher. Do not use it to modify account state, create tickets,
or message attendees unless that consequence has its own governed send skill.

If the meeting notes contain action items that require legal, billing, or
access-control changes, this skill must not assert a definitive assignment. It
should return a stop and let a stronger authority gate handle the consequence.

## Procedure

1. Require `meeting` to contain `notes` (the transcript or notes text) and
   `meeting_date` (ISO 8601 date used as the reference for relative due-date
   phrases). If `notes` is empty or `meeting_date` is missing/invalid, stop.
2. Normalize the notes text and split it into candidate action-item sentences.
3. For each candidate, detect an owner via assignment verbs ("will", "to own",
   "@mention", "ACTION:", "follow up") and a name pattern.
4. For each candidate, detect a due date — absolute ("by 2026-07-12", "July 12")
   or relative ("by Friday", "next week", "EOW", "tomorrow") — and resolve it
   against `meeting_date`.
5. Assign priority: `high` when the text contains urgent language ("urgent",
   "P0", "ASAP", "critical", "high priority") or the resolved due date is
   within 48 hours; `low` when the text contains deferral language ("low
   priority", "backlog", "when time permits") and no near deadline; otherwise
   `medium`.
6. Emit an `action_items` array sorted by priority (high → medium → low) then
   by due date (earliest first, undated last). Include a `summary` and
   `action_item_count`.
7. If no action items can be extracted from a non-empty meeting, return a stop
   so the notes can go to manual review rather than producing an empty,
   misleadingly "successful" result.

## Edge cases and stop conditions

Return a stop (exit non-zero) when:

- `meeting.notes` is empty, missing, or not a string.
- `meeting.meeting_date` is missing or not a valid ISO 8601 date.
- The notes contain no recognizable action items at all (ambiguous/empty
  extraction). An empty action_items list from non-trivial notes is a stop,
  not a success, so the output is never a misleadingly empty success.
- A candidate action item names an owner but the owner field is a sensitive
  principal form (e.g. `principal:*`) that this skill is not authorized to
  assign against — stop and defer to a stronger authority gate.

The authority scope is parsing, owner/date/priority extraction, and payload
preparation only. The proof surface is the sealed receipt containing the
meeting summary, action item count, and the action_items array. Any live
task creation, calendar write, or attendee notification requires a separate
receipt.

## Output schema

### Sealed (action items extracted)

```json
{
  "summary": "Weekly product sync. Discussed roadmap and assigned follow-ups for the launch.",
  "action_item_count": 2,
  "action_items": [
    {
      "description": "Send the updated roadmap draft to the team",
      "owner": "Alice",
      "due_date": "2026-07-11",
      "priority": "high"
    },
    {
      "description": "Schedule a design review for the onboarding flow",
      "owner": "Bob",
      "due_date": null,
      "priority": "medium"
    }
  ]
}
```

## Worked example

```bash
runx skill "$PWD" \
  --input-json meeting='{
    "meeting_date": "2026-07-09",
    "notes": "Alice will send the updated roadmap draft to the team by Friday. It is urgent. Bob to own scheduling a design review for the onboarding flow."
  }' \
  --json
```

Expected result: `action_item_count = 2`, the first action item owned by Alice
with `priority = high` and a due date resolved to the next Friday on or after
the meeting date, the second owned by Bob with `priority = medium` and a null
due date. The run does not create any task, calendar entry, or message.

## Inputs

- `meeting`: object with `notes` (string, the transcript or notes) and
  `meeting_date` (ISO 8601 date string, e.g. `2026-07-09`; used as the
  reference date for resolving relative due-date phrases).
- `priority_policy`: optional object with `urgent_signals` (array of strings,
  default includes "urgent", "asap", "p0", "critical", "high priority"),
  `defer_signals` (array of strings, default includes "low priority",
  "backlog", "when time permits"), and `near_deadline_hours` (number, default
  48 — due dates within this window force `high` priority).
