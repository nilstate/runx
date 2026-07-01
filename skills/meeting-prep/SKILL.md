---
name: meeting-prep
description: Compose a meeting-prep brief from bounded context — a calendar event, attendee notes, prior thread snippets, and optional public links — and emit a structured brief with agenda, decisions, risks, questions, follow_ups, and citations, refusing to invent attendee history.
runx:
  category: ops
---

# Meeting Prep

`meeting-prep` composes a bounded meeting-prep brief from the inputs an
operator actually hands it. It reads one calendar event, optional attendee
notes, optional prior thread snippets, and optional public links it was
given access to. It never opens new mail, scrapes a calendar it was not
shown, queries an attendee history it cannot see, or invents facts about a
person or organization.

The default `prep` runner is a graph with a thin `review` act. Its packet
step is an agent-mediated judgment, so an unattended run stops at
`needs_agent` instead of fabricating the brief. The bounded `dogfood`
runner applies the same checked contract deterministically for reproducible
post-publish evidence.

The useful output is a single `runx.meeting.brief.v1` packet bound to the
inputs the operator provided. Each section — agenda, decisions, risks,
questions, follow_ups, citations — is anchored to a snippet id, an
attendee id, or a public URL that the skill actually read. Missing or
private context is marked in `missing_context` instead of being invented.

## What This Skill Does

The skill reads four pieces of evidence:

- `event{id, title, start_at, duration_minutes, attendees[]}`
- `attendee_notes{attendee_id: notes}` keyed by attendee id from the event
- `thread_snippets[{thread_id, author, sent_at, body}]` prior conversation rows
- `public_links[{url, fetched_at, digest, excerpt}]` fetched content the
  operator explicitly chose to share

It verifies that every cited snippet, attendee note, and public link
digest actually appears in the inputs, and that no `attendee_history`,
`mail`, or `calendar` field has been supplied as private context. It
returns a brief where each item carries a `source` reference. When the
operator's input is too thin to compose a real brief — for example, an
attendee with no notes and no public context — the skill stops at
`needs_agent` and refuses to invent attendee history.

## When To Use It

- An operator has a calendar event and wants a receipt-backed brief
  before walking into the meeting.
- A workflow needs to prove which attendee notes or thread snippets
  justified a question or follow-up.
- A run should separate judgment from action, so humans can review the
  brief before sharing it externally.

## When Not To Use It

- To fetch mail, open a calendar, query an attendee history, or scrape a
  website that was not explicitly shared.
- To invent attendee titles, prior conversation history, or
  organization context that was not provided in the inputs.
- To clear an event whose inputs do not actually compose a brief
  without inventing context.
- To dispatch the brief to anyone other than the operator who ran the
  skill.

## Procedure

1. Read the event and record `id`, `title`, `start_at`, `duration_minutes`,
   and `attendees[]`.
2. Confirm every `attendee_id` referenced in the brief appears in the
   event's `attendees` list.
3. Confirm every cited snippet id appears in `thread_snippets` and every
   cited public link digest appears in `public_links`.
4. Compose the brief only from cited inputs. Mark missing context in
   `missing_context` and never substitute invented facts.
5. Emit a single `brief` and one `runx.meeting.brief.v1` packet when at
   least one input dimension is cited.
6. Stop at `needs_agent` when no input dimension is cited or when any
   `attendee_history`, `mail`, or `calendar` reference is present in the
   inputs.

## Output Contract

```yaml
brief:
  agenda: [{ item: string, source: { kind: snippet|attendee|link, ref: string } }]
  decisions: [{ item: string, source: { kind: snippet|attendee|link, ref: string } }]
  risks: [{ item: string, source: { kind: snippet|attendee|link, ref: string } }]
  questions: [{ item: string, source: { kind: snippet|attendee|link, ref: string } }]
  follow_ups: [{ item: string, source: { kind: snippet|attendee|link, ref: string } }]
  citations: [{ kind: snippet|attendee|link, ref: string, digest: string | null }]
missing_context:
  - dimension: string
    note: string
refusal:
  reason: string | null
```

`brief_packet` is emitted only when at least one section is anchored to a
cited input. Missing or private context is named in `missing_context`
rather than guessed.

## Harness Cases

The harness covers two cases:

- `meeting-prep-bounded-brief`: a calendar event with two attendees, two
  thread snippets, and one public link composes a brief with agenda,
  decisions, risks, questions, follow_ups, and citations, and seals.
- `meeting-prep-insufficient-context-needs-agent`: an event with no
  attendee notes, no thread snippets, and no public links emits no
  brief, no packet, and stops at `needs_agent` for human review.

## Evidence Requirements

Evidence should include the runx CLI version, package name and version,
registry reference, public URL, source URL, PR URL, raw `X.yaml`, raw
`SKILL.md`, harness case names, hosted harness status, dogfood command,
receipt reference, verification result, the cited snippet ids, the cited
public link digests, the missing context dimensions, and any stop reason.