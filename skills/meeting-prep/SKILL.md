---
name: meeting-prep
description: Prepare a source-cited meeting brief from bounded event, note, thread, and public-link context.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  category: ops
---

# Meeting Prep

Prepare a meeting brief from only the supplied context. The skill does not
claim private history, read calendars, or fetch links. It cites the provided
source ids for every agenda item, risk, decision, and follow-up.

## Procedure

1. Require an event title and at least one bounded source.
2. Normalize attendee notes, thread snippets, and public links.
3. Draft agenda items from explicit evidence.
4. Extract decisions, risks, questions, and follow-ups.
5. Stop with `needs_more_context` instead of inventing missing context.

## Inputs

- `event`: calendar event title and timing.
- `attendee_notes`: bounded notes.
- `thread_snippets`: bounded prior discussion snippets.
- `public_links`: public links already approved for use.
- `constraints`: optional operator preferences.

## Outputs

- `agenda`, `decisions`, `risks`, `questions`, `follow_ups`.
- `citations`: source ids backing the brief.
- `evidence`: event title, bounded source count, and privacy proof.

