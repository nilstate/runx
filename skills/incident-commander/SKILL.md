---
name: incident-commander
version: 0.1.0
description: Turn a noisy incident report into a bounded command packet. Reads signals[], timeline[], services[], and severity_hint, decides the command posture (ack_only, investigate, mitigate, escalate), and emits a typed commander packet with role assignments, comms plan, decision checkpoints, and stop conditions. Sends nothing, posts nothing, mutes nothing.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
links:
  source: https://github.com/runxhq/runx/tree/main/skills/incident-commander
runx:
  category: ops
  input_resolution:
    required:
      - signals
---

## What this skill does

Produce a bounded incident command packet from a bounded incident report.
The runner emits `runx.incident.commander.v1` with a `command_posture`,
`severity_assessment`, `roles[]`, `comms_plan[]`, `decision_checkpoints[]`,
`stop_conditions[]`, and `handoff` envelope. It is a deterministic local
composer; it never pages anyone, opens Slack channels, creates tickets, or
writes to live status pages.

This skill never executes mitigations. It proposes; a separate governed
action skill can review, approve, and emit authority grants before any
external side effect runs.

## When to use this skill

Use this skill when an agent has an in-flight incident with a defined
signal stream and timeline, and needs a calm, structured first-pass command
plan. It is useful in on-call rotations, post-mortem retros, and war-room
simulations where the same bounded inputs need a bounded output every time.

It is intentionally read-only by design. It emits decisions; it never
enforces them.

## When not to use this skill

Do not use this skill to page on-call, send Slack messages, open incidents
in PagerDuty / Opsgenie, push status-page updates, mutate ticketing
systems, or rotate credentials. Do not use it as an automatic rerouter of
traffic or a circuit-breaker. Do not use it to override human command
decisions or to bypass a customer's own incident process.

If `signals[]` is empty or `severity_hint` is missing, the skill refuses
with `needs_input`. If `signals[]` carries private customer data that has
not been summarized, the skill refuses with `refused` rather than risk a
leak through its output.

## Procedure

1. Require `signals[]` to be a non-empty array of bounded signal objects
   with at least `{source, summary, observed_at}`.
2. Accept optional `timeline[]` (sorted events), `services[]` (impacted
   service identifiers), and `severity_hint` (`sev1`..`sev4` or empty).
3. Normalize each signal: cap `summary` length, drop empty entries, dedupe
   by `(source, summary)` fingerprint.
4. Compute `severity_assessment` from the highest-impact signal + `severity_hint`
   only; never invent an impact that was not supplied.
5. Decide `command_posture` from severity_assessment: `sev1` -> `mitigate`,
   `sev2` -> `investigate`, `sev3` -> `ack_only`, `sev4` -> `ack_only`.
6. Compose `roles[]` (incident_commander, comms_lead, scribe, mitigation_lead),
   `comms_plan[]` (initial ack within 5/15/30 minutes by severity),
   `decision_checkpoints[]` (every 15/30/60 minutes by severity),
   `stop_conditions[]` (when to escalate, when to declare resolved).
7. Emit `runx.incident.commander.v1` packet and summary block.

## Edge cases and stop conditions

Return `needs_input` when `signals[]` is empty or `severity_hint` is
ambiguous. Return `refused` when signals carry private customer data not
previously summarized. Never invent services or assign mitigation steps
that were not in the input. Never escalate above the highest severity
present in the input.

Authority scope is command packet composition only. The proof surface is
the sealed packet with severity_assessment, command_posture, roles,
comms_plan, decision_checkpoints, stop_conditions, and handoff envelope.
Any live paging, ticket creation, or status-page write requires a
separate governed outbound skill.

## Output schema

The runner emits `runx.incident.commander.v1`:

```json
{
  "severity_assessment": "sev1 | sev2 | sev3 | sev4",
  "command_posture": "ack_only | investigate | mitigate | escalate",
  "roles": [
    { "role": "incident_commander", "owner": "unassigned", "ready": false },
    { "role": "comms_lead", "owner": "unassigned", "ready": false },
    { "role": "scribe", "owner": "unassigned", "ready": false },
    { "role": "mitigation_lead", "owner": "unassigned", "ready": false }
  ],
  "comms_plan": [
    { "checkpoint": "initial_ack", "within_minutes": 5, "channel": "status_page_draft" },
    { "checkpoint": "first_update", "within_minutes": 15, "channel": "internal_war_room" }
  ],
  "decision_checkpoints": [
    { "at_minutes": 30, "decision": "reassess_or_escalate" },
    { "at_minutes": 60, "decision": "declare_resolved_or_open_p2" }
  ],
  "stop_conditions": [
    "service_impact_unresolved_at_60m",
    "customer_facing_data_exposure_detected"
  ],
  "handoff": {
    "next_skill": "governed-outbound",
    "requires_human_approval": true
  }
}
```

## Worked example

```bash
runx skill "$PWD" \
  --runner command \
  --input-json signals='[
    {"source":"monitor","summary":"5xx rate spiked to 12%","observed_at":"2026-07-24T08:00:00Z"},
    {"source":"pager","summary":"checkout 5xx for 4 minutes","observed_at":"2026-07-24T08:01:00Z"}
  ]' \
  --input-json services='["checkout","payments"]' \
  --input-json severity_hint="sev2" \
  --json
```

Expected result: `severity_assessment = sev2`, `command_posture =
investigate`, `comms_plan.initial_ack.within_minutes = 15`,
`decision_checkpoints[0].at_minutes = 30`, `handoff.next_skill =
governed-outbound`. The run does not page, post, or open any ticket.

## Inputs

- `signals`: array of `{source, summary, observed_at}` records.
- `timeline`: optional array of pre-sorted incident events.
- `services`: optional array of impacted service identifiers.
- `severity_hint`: optional `sev1`..`sev4` hint; never overridden upward.

## Outputs

- `severity_assessment`: final severity chosen from inputs.
- `command_posture`: bounded first-pass action posture.
- `roles`: bounded role assignments, all unassigned by default.
- `comms_plan`: bounded communication checkpoint cadence.
- `decision_checkpoints`: bounded reassessment cadence.
- `stop_conditions`: bounded list of escalation triggers.
- `handoff`: pointer to the next governed skill, requires human approval.