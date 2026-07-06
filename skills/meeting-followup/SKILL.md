---
name: meeting-followup
description: Turn a bounded meeting transcript into decisions, owned action items, and gated task proposals without inventing unstated owners or due dates.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 15
inputs:
  transcript:
    type: string
    required: true
    description: Meeting transcript with speaker labels or bounded notes.
  attendees:
    type: json
    required: true
    description: Array of attendee names or attendee objects with name fields.
runx:
  category: ops
  input_resolution:
    required:
      - transcript
      - attendees
  artifacts:
    named_emits:
      summary: runx.meeting_followup.summary.v1
      decisions: runx.meeting_followup.decisions.v1
      action_items: runx.meeting_followup.action_items.v1
      task_proposals: runx.meeting_followup.task_proposals.v1
---

# Meeting Followup

`meeting-followup` converts a bounded meeting transcript into follow-up output a
human or workflow can review. It extracts a concise summary, decisions, action
items, and gated task proposals for an `n8n-handoff` style downstream workflow.

The skill does not create live tasks. It only proposes tasks when the transcript
contains enough evidence for an attendee owner and an explicit due date.

## Use This Skill When

- A meeting transcript needs a receipt-backed follow-up packet.
- A workflow needs decisions and action items without creating tasks directly.
- An operator wants unclear owners or due dates marked for human assignment.

## Do Not Use This Skill For

- Creating live tasks, calendar events, tickets, or messages.
- Guessing owners, due dates, or decisions that are not present in the transcript.
- Summarizing private meetings without a bounded transcript supplied by the caller.

## Inputs

- `transcript`: speaker-labeled transcript text or bounded meeting notes.
- `attendees`: array of attendee names, or objects with a `name` field.

## Outputs

- `summary`: concise meeting summary with evidence line count and attendee count.
- `decisions`: extracted decision statements with source line references.
- `action_items`: extracted action items with owner, due date, confidence, and
  missing-field markers.
- `task_proposals`: gated task proposals only for action items that have a
  named attendee owner and explicit due date.

## Procedure

1. Normalize attendee names from the supplied attendee list.
2. Split the transcript into non-empty source lines.
3. Extract decisions only from explicit decision language such as `decided`,
   `decision`, `agreed`, or `we will`.
4. Extract action items from explicit commitment language such as `I will`,
   `owner will`, `please`, `take`, `send`, or `prepare`.
5. Resolve owners only when the owner is a named attendee or the speaker is a
   named attendee making an explicit `I will` commitment.
6. Resolve due dates only when an explicit date or date phrase is present.
7. Emit task proposals only when owner and due date are both present.

## Refusal Conditions

- `attendees` is empty or malformed.
- The transcript contains no explicit decisions, action items, or task proposals.
- A line has an unclear owner or date; the item is preserved but marked
  `needs_human_assignment` instead of being promoted to a task proposal.

## Input Failure Conditions

- `transcript` is empty or not a string.
