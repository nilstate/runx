---
name: incident-commander
description: Coordinate one incident agency turn from monitor-backed case state, roster approval, and dispatch-by-naming to governed outbound communications.
runx:
  category: ops
---

# Incident Commander

Incident Commander is a thin review skill over the shipped agency spine. It
does not reimplement durable state, mint authority, post messages, or call a
provider. It reads the folded incident case state produced by the agency turn,
requires that state to carry a real source alert or monitor event, checks the
fixed incident roster, and emits one typed `incident_turn` decision.

Comms are dispatch-by-naming. A status update names the governed outbound lane
that will perform the send, with the principal, audience, channel, content
digest, and source alert bound as data. The first comms turn stays
`awaiting_approval`. A later advance may mark it `delivered` only when the input
contains both a roster-matched approval and a `member_result.receipt_ref` from
the downstream governed send run.

## What This Skill Does

1. **Review monitor-backed case state.** `case_state.source_alert` must name the
   monitor or alert event that opened or updated the incident.
2. **Check the incident roster.** Every commander, responder, comms, approval,
   and send principal must match a role in the folded case roster.
3. **Coordinate comms safely.** A send objective returns a named
   `governed-outbound` or `slack-notify` run and stops at approval until a
   matching approval arrives.
4. **Link delivery proof.** Delivered status requires a downstream send receipt
   in `member_result.receipt_ref`.
5. **Refuse unsafe moves.** Missing roster owners, missing source alerts,
   unmatched approvals, missing send receipts, and resolution without evidence
   all stop with `needs_agent` or `awaiting_approval`.

## Contract Boundaries

- **Typed inputs are required.**
  - `case_id`
  - `driver_id`
  - `incident_objective`: `begin`, `assign`, `send`, `resolve`, or
    `postmortem`
  - `case_state`: folded state from the agency turn, including
    `source_alert`
  - `roster`: fixed incident roster from the agency case
- **Optional inputs.**
  - `approval`: `{ principal, reason }`
  - `member_result`: `{ outcome, receipt_ref }`
- **Typed output is one incident turn.**
  - `incident_turn`: `{ status, case_id, turn, dispatch, escalation,
    named_run, reason }`
- **No provider effects.** This skill never sends a Slack message, email, or
  customer notification. It names the governed outbound lane and requires that
  lane's receipt before delivery is acknowledged.
- **No data-store composition in graph.** The agency spine owns fold and CAS
  append. This skill receives the folded projection as input and records the
  decision as a sealed review act.

## Decision Rules

- `send`: if approval is absent, return `awaiting_approval` with a named
  governed outbound run. If approval matches a roster principal and
  `member_result.receipt_ref` is present, return `delivered` and link the send
  receipt. If approval is present but no send receipt is linked, remain
  `awaiting_approval`.
- `assign`: require `case_state.assign_to` or `case_state.requested_owner` to
  match a roster role. Missing owners return `needs_agent` with no named run.
- `resolve`: require `member_result.receipt_ref` or
  `case_state.resolution_evidence`. Without evidence, return `needs_agent`.
- Never invent a commander, responder, comms lead, approval, source alert,
  receipt, or resolution.

## Output Shape

```yaml
incident_turn:
  status: awaiting_approval | advanced | delivered | resolved | needs_agent
  case_id: string
  turn: number
  dispatch: object | null
  escalation: object | null
  named_run: object | null
  reason: string
  source_alert: object
  approval: object | null
  member_result: object | null
```

## Inputs

- `case_id` (required): incident case id.
- `driver_id` (required): agency driver id; participates in the agency
  contention lease outside this skill.
- `incident_objective` (required): `begin`, `assign`, `send`, `resolve`, or
  `postmortem`.
- `case_state` (required): folded state from the agency turn.
- `roster` (required): fixed incident roster.
- `approval` (optional): roster principal approval for a consequential turn.
- `member_result` (optional): downstream lane result, including receipt refs.
