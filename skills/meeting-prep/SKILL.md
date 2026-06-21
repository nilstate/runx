---
name: meeting-prep
description: Prepare a meeting briefing from bounded context — calendar event, attendee notes, thread snippets, and optional public links.
runx:
  category: productivity
---

# Meeting Prep

## What this skill does

Turns a typed `meeting_context` packet into a compact prep brief. The skill works only with provided context — it does not claim access to calendars, mail, or attendee profiles it was not given.

## Procedure

1. Receive a `meeting_context` packet with:
   - `calendar_event` — event title, time, description
   - `attendee_notes` — per-attendee notes, if provided
   - `thread_snippets` — prior discussion snippets, if provided
   - `public_links` — optional public URLs to read
2. If only `calendar_event` is provided with no notes, snippets, or links, stop with an error: "Insufficient context. Provide attendee notes, thread snippets, or public links."
3. Synthesize the prep brief: agenda, likely decisions, risks, questions, follow-ups
4. Cite only provided snippets or public links that were actually read
5. Mark missing attendee context instead of inventing it

## Inputs

- `meeting_context` (required): Object with:
  - `calendar_event` — event title, time, description
  - `attendee_notes` — per-attendee notes
  - `thread_snippets` — prior discussion snippets
  - `public_links` — optional public URLs

## Outputs

- `prep_brief` — Object with:
  - `agenda` — Proposed agenda items
  - `decisions` — Likely decisions to make
  - `risks` — Risks to discuss
  - `questions` — Questions for attendees
  - `follow_ups` — Action items
  - `citations` — Sources cited

## Quality Profile

| Dimension | Assessment |
|-----------|------------|
| Honesty | Refuses to invent context it was not given |
| Scoping | Works only within provided bounded context |
| Composability | Designed to be composed with calendar, mail, research skills |
| Safety | No network access except to public_links provided |
| Determinism | Structured output from same input produces same brief structure |
