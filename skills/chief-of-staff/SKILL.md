---
name: chief-of-staff
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

Every queued action or draft must identify the source thread or calendar item
that justifies it. Lead with decisions and risks rather than summarizing the
whole inbox. Return `needs_context` when the redacted snippets cannot support a
safe recommendation, and force `manual_review` for legal, billing, HR, or
sensitive account changes.

## Output

- `priority_queue`: ranked actions with source refs and rationale.
- `draft_replies`: unsent replies bound to their threads.
- `scheduling_proposals`: proposed calendar changes, never mutations.
- `risks_and_questions`: missing context and mandatory review flags.

## Inputs

- `objective` (required): what the operator needs from the pass.
- `mail_context` (required): redacted message/thread summaries.
- `calendar_context` (optional): redacted upcoming events and availability.
- `constraints` (optional): owner, tone, send policy, or scheduling limits.
