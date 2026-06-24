---
name: meeting-prep
version: 0.1.0
description: Build a source-cited meeting preparation brief from bounded event context, supplied notes, thread snippets, and public link notes without inventing private history.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/luismireles12/runx/tree/feat/meeting-prep/skills/meeting-prep
runx:
  category: productivity
---

# Meeting Prep

`meeting-prep` turns explicitly supplied context into a concise operator brief.
It accepts a calendar event, attendee notes, prior thread snippets, and optional
public-link notes. It cites only those bounded inputs and marks missing/private
context instead of implying access to mail, calendar, CRM, or attendee history.

## Inputs

- `event`: meeting title, time, organizer, attendees, purpose, and optional
  agenda items.
- `attendee_notes[]`: supplied notes about attendees or organizations.
- `thread_snippets[]`: supplied prior conversation snippets with source labels.
- `public_links[]`: optional public links or already-read public notes.
- `prep_goal`: optional focus for the brief, such as decision, kickoff, renewal,
  or escalation.

## Outputs

- `agenda`: ordered discussion plan grounded in the meeting purpose and inputs.
- `decisions`: decisions likely needed in the meeting, with citations.
- `risks`: missing context, unresolved blockers, or disagreement signals.
- `questions`: high-leverage questions to ask.
- `follow_ups`: proposed follow-up actions after the meeting.
- `citations`: every source ID used by the brief.

## Guardrails

- Use only the provided event, snippets, notes, and public-link summaries.
- Cite each material claim with source IDs from the input.
- Mark absent calendar/mail/private history as missing context.
- Refuse to create a full brief when the event or supporting context is too thin.
- Do not claim to have contacted attendees, opened private links, or read inboxes.
- Keep outputs advisory: no external messages, scheduling changes, or CRM writes.

This skill is meant to compose cleanly with calendar, mail, and research scopes:
those systems can gather bounded inputs first, then this skill prepares the brief
from that explicit bundle.
