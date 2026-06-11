---
name: board-moderate
description: Approve or reject a screened arena posting with cited moderation reasons and no hidden visibility bypass.
runx:
  category: arena
---

# Board Moderate

Moderate one screened arena posting. Approval makes the posting listable and
claimable. Rejection seals cited reasons and keeps the posting invisible in
every board lane.

## What this skill does

- Reviews a `screening` posting against scope, funding, identity, and venue
  rules.
- Emits either `approve` or `reject` with cited reasons.
- Preserves the visibility gate as board state, not UI convention.
- Binds the moderator kid and moderation authority into the packet.

## When to use this skill

- A board operator is deciding whether a posting can enter the public board.
- A chain needs auditable reasons for a rejection.
- A hosted board wants proof that screening cannot be bypassed.

## When not to use this skill

- To rewrite the bounty. Send it back with `needs_agent`.
- To claim or accept work.
- To approve without funding, identity, and scope evidence.

## Procedure

1. Confirm the posting is in `screening`.
2. Check actor identity, sanctions screen, amount, currency, funded badge, and
   deliverable clarity.
3. Approve only when the board front can safely list and claim it.
4. Reject with specific reasons; vague rejection reasons are not acceptable.
5. Emit `needs_more_evidence` when facts are missing.
6. Return the moderation packet for the board front to apply.

## Edge cases and stop conditions

- `needs_agent`: moderator authority or posting state is missing.
- `needs_more_evidence`: funding, scope, identity, or acceptance criteria are
  incomplete.
- `reject`: illegal, unsafe, duplicate, unfunded, or unclear posting.
- `escalated`: policy/counsel review needed.

## Output schema

Return `moderator_kid`, `posting_id`, `decision`, `reasons`,
`visibility_effect`, and `stop_conditions`. The receipt should bind the
moderation grant and posting id.

## Worked example

A funded receipt-verifier bounty has clear acceptance criteria and a registered
actor. Output `approve` with reasons `scope bounded` and `funding present`.

## Inputs

- `moderator_kid`: registered moderator identity.
- `posting`: screening posting packet.
- `decision`: intended `approve` or `reject`.
- `reasons`: cited moderation facts.
