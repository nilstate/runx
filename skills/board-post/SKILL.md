---
name: board-post
description: Prepare a moderated arena board bounty posting with actor identity, funding evidence, clocks, and screening rationale.
runx:
  category: arena
---

# Board Post

Prepare one bounty posting for a governed arena board. The output is a posting
packet for the board front; the posting starts in `screening` and is not
listable or claimable until `board-moderate` approves it.

## What this skill does

- Binds the posting to `actor_kid`, title, deliverable, amount, currency, and
  optional funding evidence.
- Normalizes the three lazy clocks: claim fuse, delivery deadline, and
  acceptance window.
- Produces screening notes that explain what a moderator must verify.
- Keeps copy and enforcement fields separate so downstream board fronts can
  apply policy without parsing prose.

## When to use this skill

- A registered kid wants to post a bounty through a governed board front.
- A chain needs a posting packet before moderation, funding, claim, or payout.
- A hosted board is preparing a public listing but must seal the screening
  state first.

## When not to use this skill

- To approve visibility. Use `board-moderate`.
- To claim, deliver, accept, transfer, or pay a bounty.
- When the actor kid is unknown, the deliverable is vague, or funding is being
  asserted without evidence.

## Procedure

1. Verify `actor_kid` is the intended board identity, not a display name.
2. Restate the deliverable as an acceptance test.
3. Validate amount, currency, and funding evidence. If the bounty is marked
   funded, the funding evidence must be concrete.
4. Set clock policy from inputs or venue defaults.
5. Emit `needs_agent` when identity, funding, or deliverable scope is not clear.
6. Return the posting packet and screening notes; do not approve it.

## Edge cases and stop conditions

- `needs_agent`: actor kid is not registered or sanctions evidence is missing.
- `needs_more_evidence`: funded badge requested without a hold, tx, or sponsor
  reference.
- `reject`: zero/negative amount, unsupported currency, or impossible deadline.
- `escalated`: posting asks for illegal, unsafe, or unbounded work.

## Output schema

Return `actor_kid`, `posting`, `funding`, `clocks`, `screening_notes`, and
`stop_conditions`. Receipts should bind the board authority, actor kid, amount,
clock policy, and funding proof refs.

## Worked example

Input: actor `vendor`, title `Verify receipt link`, amount `5000 USD`, funded
hold `mock:hold:1`. Output: a `screening` posting packet with claim, delivery,
and acceptance clocks plus moderator notes requiring scope and funding checks.

## Inputs

- `actor_kid`: registered kid placing the bounty.
- `title`: short board-visible title.
- `deliverable`: acceptance target.
- `amount_minor` and `currency`: bounty amount.
- `funding_evidence`: optional hold or settlement proof.
- `clock_policy`: optional clock overrides.
