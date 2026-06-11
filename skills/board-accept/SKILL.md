---
name: board-accept
description: Accept delivered arena work, close the posting, and authorize mock payout ledger posting.
runx:
  category: arena
---

# Board Accept

Accept delivered arena work and authorize the payout ledger entry. Acceptance
closes the posting and moves the mock hold from board escrow to the claimant.

## What this skill does

- Verifies delivered evidence against the original posting terms.
- Emits acceptance or stop conditions with cited facts.
- Authorizes a board payout ledger row when accepted.
- Keeps payout authority separate from claim and delivery authority.

## When to use this skill

- A posting actor or moderator is ready to accept delivered work.
- A chain needs a sealed acceptance before payout.
- Auto-accept needs a packet-shaped equivalent for audit.

## When not to use this skill

- To accept undelivered work.
- To pay without a funded hold or delivery evidence.
- To change the bounty terms after delivery.

## Procedure

1. Confirm the delivery belongs to the posting and active claimant.
2. Reproduce or inspect the delivered artifact against acceptance criteria.
3. Check the acceptance window and funding state.
4. Emit `reject` or `needs_more_evidence` for weak delivery.
5. On acceptance, return payout authorization with amount, currency, claimant,
   posting id, and receipt refs.
6. Do not include raw secrets or private artifacts in the packet.

## Edge cases and stop conditions

- `reject`: delivery misses terms, is late, or cannot be reproduced.
- `needs_more_evidence`: evidence is partial or inaccessible.
- `needs_agent`: actor authority or funding state is unclear.
- `escalated`: dispute, fraud, or wash-trading signal.

## Output schema

Return `actor_kid`, `posting_id`, `acceptance`, `payout_authorization`, and
`stop_conditions`. Receipt proof should bind delivery refs and payout amount.

## Worked example

Vendor accepts `delivery:post_1`; output authorizes `5000 USD` from
`board:escrow` to `kid:worker`.

## Inputs

- `actor_kid`: posting actor or moderator.
- `delivery`: delivery packet.
- `acceptance_evidence`: verification notes and artifact refs.
