# missing-context — Insufficient context fixture

Only a calendar_event with no attendee_notes, thread_snippets, or public_links.

## Input

```json
{
  "calendar_event": {
    "title": "Standup",
    "time": "2026-06-22T09:00:00Z",
    "description": "Daily standup"
  },
  "attendee_notes": [],
  "thread_snippets": [],
  "public_links": []
}
```

## Expected Behavior

The skill must stop and return an error: "Insufficient context: only calendar_event provided without attendee_notes, thread_snippets, or public_links. Cannot prepare meeting brief without additional context."

No prep brief is generated. All arrays (agenda, decisions, risks, questions, follow_ups, citations) are empty.
