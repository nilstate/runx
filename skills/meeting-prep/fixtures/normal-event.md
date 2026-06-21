# normal-event — Full meeting context fixture

Calendar event with attendee notes, thread snippets, and an empty public_links array.

## Input

```json
{
  "calendar_event": {
    "title": "Sprint Review",
    "time": "2026-06-22T10:00:00Z",
    "description": "Weekly sprint review with frontend and backend teams"
  },
  "attendee_notes": [
    {
      "attendee": "Alice",
      "notes": "Frontend PRs ready for review"
    },
    {
      "attendee": "Bob",
      "notes": "Backend deployment blocked on DB migration"
    }
  ],
  "thread_snippets": [
    {
      "source": "slack-thread-123",
      "snippet": "DB migration script has a foreign key conflict with users table"
    }
  ],
  "public_links": []
}
```

## Expected Output

A structured prep_brief with agenda, decisions, risks, questions, follow_ups, and citations.

- Agenda: demos (Alice's PRs), blockers (Bob's migration), rollback plan
- Decisions: PR merge order, migration rollback strategy
- Risks: foreign key conflict blocks deployment, rollback may lose changes
- Questions: rollback strategy, hotfix vs wait
- Follow-ups: Alice creates review tickets, Bob documents options, team schedules spike
- Citations: slack-thread-123
