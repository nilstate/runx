---
name: postmortem-maker
description: Turn bounded incident evidence into a traceable postmortem packet with action items and a gated publish proposal.
runx:
  category: operations
---

# Postmortem Maker

Postmortem Maker converts incident fragments into a postmortem packet without
pretending unknowns are facts. It accepts bounded incident timeline events,
alerts, deploy events, chat notes, and a postmortem policy. It separates known
facts from hypotheses, cites the input evidence behind every timeline and
root-cause claim, and emits action items plus a publish proposal only when the
policy allows publication.

The skill does not post, assign work, page people, mutate incidents, or send
communications. The publish proposal is a gated handoff for a downstream
send-as or document-publisher executor.

## Inputs

- `incident_timeline` (required array): timestamped incident observations.
- `alerts` (optional array): alert events with source, severity, and message.
- `deploy_events` (optional array): deploys or config changes near the incident.
- `chat_notes` (optional array): bounded chat excerpts or operator notes.
- `postmortem_policy` (required object): publication rules, evidence bar, and
  action-item requirements.

## Output

- `postmortem`: object containing `summary`, `timeline`, `impact`,
  `root_cause`, and `status`.
- `unknowns`: unresolved or contradictory facts that must not be asserted.
- `action_items`: concrete follow-ups with owners or owner placeholders.
- `publish_proposal`: present only when the policy allows publication and the
  evidence bar is met.

## Rules

- Cite input evidence for each timeline entry and root-cause claim.
- Keep unresolved facts in `unknowns` instead of inventing a cause.
- Refuse publication when evidence conflicts, required policy fields are
  missing, or the incident timeline is too thin to support a postmortem.
- Preserve uncertainty explicitly: root cause may be `unknown`, `hypothesis`, or
  `confirmed`.
- Do not include secrets, customer data, private chat dumps, or private incident
  identifiers in public-facing summaries.
