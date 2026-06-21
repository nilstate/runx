---
name: meeting-prep
description: Turn bounded event, attendee, thread, and public-link context into a cited meeting brief without inventing private history.
runx:
  category: ops
---

# Meeting Prep

Prepare a decision-ready brief from only the context supplied by the caller.
The skill accepts a calendar event, attendee notes, prior thread snippets, and
optional public links, then returns an agenda, decisions to make, risks,
questions, follow-ups, and citations.

This skill never fetches private mail, calendars, CRM records, or attendee
history on its own. It must label missing context explicitly and must not turn
an attendee name into an inferred biography, relationship, or commitment.

## Quality Profile

- Purpose: reduce meeting preparation time without overstating what is known.
- Audience: the meeting owner or a delegate reviewing the prep packet.
- Artifact contract: agenda, decisions, risks, questions, follow-ups, and
  citations tied to the supplied inputs.
- Evidence bar: every factual claim that affects preparation cites a supplied
  event field, attendee note, thread snippet, or public link.
- Voice bar: concise operator brief, not a transcript recap or generic advice.
- Strategic bar: identify what must be decided, what could block the meeting,
  and what should happen afterward.
- Stop conditions: return `needs_context` when no calendar event or substantive
  source snippet is supplied; mark individual gaps rather than inventing data.

## Inputs

- `objective` (required): what the meeting owner needs from the preparation.
- `calendar_event` (required): bounded event details such as title, time,
  participants, description, and location.
- `attendee_notes` (optional): caller-provided notes keyed by attendee or role.
- `prior_thread_snippets` (optional): bounded excerpts with stable source ids.
- `public_links` (optional): public references already selected by the caller.
- `constraints` (optional): timebox, sensitive topics, ownership, or citation
  rules.

## Output Rules

1. Keep agenda items action-oriented and sized to the stated meeting timebox.
2. Separate confirmed decisions from decisions that still need to be made.
3. Cite source ids inline or in the corresponding structured item.
4. Put unsupported but useful questions in `questions`, never in facts.
5. Record unavailable private context in `missing_context`.
6. Do not send messages, edit calendars, or perform follow-up actions.

