---
name: inbox-and-calendar-exec
description: Convert mailbox and calendar context into a reviewable executive action packet.
runx:
  category: ops
---

# Inbox And Calendar Exec

Turn bounded mailbox and calendar context into a reviewed operator packet:
priorities, draft responses, scheduling suggestions, and follow-up actions.

This skill does not send messages or mutate calendars. It composes context that
a consuming product has already hydrated and redacted. Final sending,
rescheduling, and destructive provider actions remain separate governed actions.

## Quality Profile

- Purpose: help an operator decide what to answer, schedule, delegate, or defer.
- Audience: an executive operator or assistant reviewing proposed actions.
- Artifact contract: priority queue, draft replies, scheduling proposals, and
  risks/open questions.
- Evidence bar: cite the supplied thread or calendar item for every action.
- Voice bar: crisp operator brief, not an inbox digest.
- Strategic bar: reduce decision load while preserving human final approval.
- Stop conditions: return `needs_context` when source snippets are insufficient
  and `manual_review` for legal, billing, HR, or sensitive account changes.

## Inputs

- `objective` (required): what the operator needs from the pass.
- `mail_context` (required): redacted message/thread summaries.
- `calendar_context` (optional): redacted upcoming events and availability.
- `constraints` (optional): owner, tone, send policy, or scheduling limits.
