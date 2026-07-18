---
name: postmortem-maker
description: >
  Turns incident fragments into a traceable postmortem without pretending
  unknowns are facts. Reads from a real source, separates facts from
  hypotheses, produces the postmortem packet, and when publishable executes
  a digest-bound mock transport send_plan.
runx:
  category: ops
---

# Postmortem Maker

Postmortem Maker reads an incident record from a real source (a
data-store read_projection or a web-fetch of a real incident thread),
separates known facts from hypotheses, produces a postmortem packet with
action items, and when the postmortem is publishable it executes the
built-in mock transport to seal the actual comms send_plan. The read ->
reason -> publish loop is proven in one sealed dogfood run.

## What this skill does

1. Reads incident data from the configured source handle.
2. Extracts timeline entries, each citing source evidence.
3. Determines root cause status (known, suspected, unknown).
4. Identifies unresolved unknowns.
5. Produces action items with owners and deadlines.
6. When evidence is consistent and sufficient, marks the postmortem
   publishable and executes a digest-bound mock send_plan.
7. When evidence is conflicting or insufficient, emits unknowns and
   publishes nothing.
8. Leaves durable persistence to a downstream data-store lane when an
   operator needs it.

## When to use this skill

- After an incident has been resolved and fragments are available.
- When you need a structured, auditable postmortem with evidence
  citations.
- When the postmortem should be published to a comms channel.

## When not to use this skill

- When the incident is still active and unresolved.
- When no incident data is available.
- When the operator wants a draft-only review without persistence.

## Procedure

1. **Read incident**: Fetch the incident record from the source handle.
   If the handle is a URL, web-fetch it. If it is a data-store
   projection reference, read_projection.
2. **Parse evidence**: Extract timeline entries, status changes,
   error logs, and communications from the incident record.
3. **Separate facts and hypotheses**: Every timeline entry and
   root-cause claim must cite source evidence. Unresolvable items
   go to unknowns.
4. **Assess root cause**: If the evidence supports a clear root cause,
   mark it known. If partially supported, mark suspected with the
   supporting evidence. If insufficient, mark unknown.
5. **Decide publishability**: The postmortem is publishable when:
   - At least one timeline entry exists with evidence.
   - Root cause is known or suspected (not unknown), unless
     policy.allow_unknown_root_cause is true.
   - Unknown count is within policy.max_unknowns.
6. **Produce action items**: Each action item has a description,
   owner, deadline, and evidence reference.
7. **Execute publish**: When publishable, execute the mock transport
   send_plan. The send_plan binds the postmortem summary, action items,
   source evidence, and content digest.
8. **Persist later if needed**: A downstream data-store lane can append
   the postmortem packet to an incident stream, but the public runner
   does not require storage inputs.

## Edge cases and stop conditions

- **Missing or unreadable source**: Emit stop condition
  `source_unreadable`, publish nothing, persist nothing.
- **Conflicting evidence**: Emit unknowns for each conflict, mark
  postmortem as `needs_review`, do not publish.
- **Storage required by caller**: Use a downstream data-store lane with
  explicit version and idempotency controls.
- **Active unsubscribe or suppression marker**: Escalate to human
  approval, do not publish.
- **Empty incident**: Emit unknown `no_incident_data`, mark refused.

## Output schema

```yaml
postmortem:
  summary: string
  timeline:
    - timestamp: string
      event: string
      evidence_ref: string
      certainty: fact|hypothesis
  impact:
    severity: string
    affected_services: [string]
    duration_minutes: number
    users_affected: number|null
  root_cause:
    status: known|suspected|unknown
    description: string
    evidence_ref: string|null
  status: publishable|needs_review|refused
unknowns:
  - question: string
    evidence_gap: string
action_items:
  - description: string
    owner: string
    deadline: string
    evidence_ref: string
publish_result:
  decision: executed|needs_input|denied|refused|null
  send_plan: object|null
  executed_send: object|null
```

## Inputs

- **source_handle** (string, required): Incident source reference.
  URL for web-fetch, or data-store read_projection reference.
- **postmortem_policy** (object, required): Policy with
  publish_threshold, require_root_cause, max_unknowns.

## Worked example

Given an incident with a clear deployment correlation:

```json
{
  "source_handle": "https://github.com/org/repo/issues/123",
  "postmortem_policy": {
    "publish_threshold": "when_publishable",
    "require_root_cause": true,
    "max_unknowns": 3
  }
}
```

The skill fetches the issue, extracts the available timeline facts,
marks the root cause as known, suspected, or unknown based on the
evidence, produces action items, and executes a digest-bound
publish_result for the postmortem summary.
