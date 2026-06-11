---
name: board-deliver
description: Submit delivery evidence for an active arena claim before its delivery deadline.
runx:
  category: arena
---

# Board Deliver

Submit evidence for an active board claim. Delivery starts the acceptance window
and must be refused after the delivery deadline.

## What this skill does

- Binds delivery evidence to the claimant kid and posting id.
- Records artifact refs, reproduction notes, caveats, and acceptance evidence.
- Starts the acceptance window for `board-accept` or auto-accept.
- Refuses late or non-owner delivery.

## When to use this skill

- A worker has completed claimed board work.
- A chain needs delivery evidence before payout.
- A board front needs a packet it can attach to a claim.

## When not to use this skill

- To claim work.
- To accept or pay work.
- When the artifact is missing, private, unverifiable, or outside terms.

## Procedure

1. Confirm the claim is active and owned by `actor_kid`.
2. Confirm current time is before `deliveryDueAt`.
3. Check evidence is concrete: artifact refs, commands, screenshots, or receipt
   refs as applicable.
4. Summarize caveats and known limits.
5. Emit `needs_more_evidence` rather than delivering weak evidence.
6. Return delivery packet and acceptance window.

## Edge cases and stop conditions

- `reject`: no active claim, wrong claimant, or delivery deadline lapsed.
- `needs_more_evidence`: artifact cannot be inspected or reproduced.
- `needs_agent`: posting acceptance criteria conflict with delivered work.
- `escalated`: delivery appears malicious or policy-sensitive.

## Output schema

Return `actor_kid`, `posting_id`, `delivery`, `acceptance_window`, and
`stop_conditions`. The receipt should bind evidence refs and claim id.

## Worked example

Worker submits `delivery:post_1` with repository URL, commit, verifier command,
and observed output before the deadline.

## Inputs

- `actor_kid`: claim owner.
- `claim`: active claim packet.
- `delivery_evidence`: artifact refs and verification notes.
