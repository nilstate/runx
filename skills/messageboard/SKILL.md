---
name: messageboard
description: Govern a bounty-style messageboard from post through moderation, claim, delivery, acceptance, payout authorization, and trial take evidence.
runx:
  category: effect
---

# Messageboard

Operate a governed bounty messageboard where every consequential transition is
explicit: a posting starts in screening, moderation controls visibility, claims
are exclusive while their fuse is active, delivery starts an acceptance window,
acceptance authorizes payout, and trial take exhibits seal either an allowed
messageboard ledger transition or a denial.

Use this skill as the agent-facing context for board work. Select the runner
that matches the transition you are performing: `post`, `moderate`, `claim`,
`deliver`, `accept`, or `take`. Do not split those transitions into separate
catalog skills; they are one product capability with several governed modes.

## What this skill does

- Prepares funded bounty postings with actor identity, clocks, deliverable
  tests, and moderation notes.
- Approves or rejects screened postings with cited reasons and no hidden
  visibility bypass.
- Creates exclusive claims, records delivery evidence, and accepts completed
  work against the original terms.
- Authorizes payout ledger rows only after accepted delivery.
- Exercises the trial take exhibit with generic effect-transition proof, norm
  refs, and ledger impact when allowed.

## When to use this skill

- A chain needs a board posting, moderation decision, claim, delivery,
  acceptance, or payout authorization that can be audited later.
- A hosted or local board front needs packet-shaped transitions rather than
  prose-only state changes.
- A verifier needs to inspect who acted, under which grant, against which
  posting, and with which receipt/proof refs.
- A demo needs to show allow-and-mark versus deny behavior on a messageboard
  effect family without adding a new core packet or contract enum.

## When not to use this skill

- For ordinary chat, comments, or non-governed task tracking.
- To bypass moderation, funding checks, identity checks, or receipt sealing.
- To mutate board state without selecting the matching runner and returning the
  packet shape for that transition.
- To execute real settlement rails. This skill authorizes board ledger effects;
  real rail settlement belongs to the payment/spend family.

## Procedure

1. Identify the transition: `post`, `moderate`, `claim`, `deliver`, `accept`,
   or `take`.
2. Confirm the caller has authority for that transition. Do not infer authority
   from display names; use stable actor/moderator/claimant identifiers.
3. Check the current state and lazy clocks before deciding. Apply claim fuses,
   delivery deadlines, and acceptance windows before acting.
4. Bind evidence by reference. Use artifact refs, funding refs, verifier output,
   norm refs, and prior receipt refs rather than embedding private artifacts or
   raw secrets.
5. Emit a stop decision instead of guessing when identity, funding, policy,
   clocks, acceptance criteria, or artifacts are unclear.
6. Return the transition packet named by the runner. The receipt should bind the
   authority/grant, posting id, actor id, clock state, amount, and proof refs.

## Edge cases and stop conditions

- `needs_agent`: actor authority, moderator authority, claimant identity,
  constitution, or current board state cannot be verified.
- `needs_more_evidence`: funding, deliverable scope, artifact refs, verifier
  output, norm refs, or acceptance criteria are incomplete.
- `reject`: the request is unfunded, unsafe, impossible, late, duplicate,
  already active-claimed, or outside the board rules.
- `refused`: the requested transition does not match the current state or grant.
- `denied`: an enforced constitution blocks a trial take.
- `escalated`: legal, sanctions, fraud, wash-trading, safety, or dispute signals
  require human/counsel review.

## Output schema

Return one packet shape based on the selected runner. Every packet starts with
`effect_family: "messageboard"` and `operation` equal to the runner name:

- `post`: `posting`, `funding`, `clocks`, `screening_notes`, `stop_conditions`.
- `moderate`: `moderator_kid`, `posting_id`, `decision`, `reasons`,
  `visibility_effect`, `stop_conditions`.
- `claim`: `actor_kid`, `posting_id`, `claim`, `stop_conditions`.
- `deliver`: `actor_kid`, `posting_id`, `delivery`, `acceptance_window`,
  `stop_conditions`.
- `accept`: `actor_kid`, `posting_id`, `acceptance`, `payout_authorization`,
  `stop_conditions`.
- `take`: `phase`, `actor_kid`, `victim_kid`, `norm_refs`, `receipt_ref`,
  `ledger_entries`, `stop_conditions`.

Every runner emits the generic packet `runx.effect.transition.v1` with
`effect_family: "messageboard"` and an operation matching the runner. The
provider owns the operation payload; runx seals the generic transition envelope
with the relevant grant/scope, prior receipt refs, and ledger impact when a
transition changes value or visibility.

## Worked example

A vendor posts `Verify receipt link` with a mock funded hold. The `post` runner
returns a screening packet with clock policy and moderator notes. The
`moderate` runner approves it only after funding and scope are clear. A worker
then uses `claim`, submits a verifier command through `deliver`, and the vendor
uses `accept` to authorize payout from board escrow to the worker. Each packet
binds the same posting id and is independently receipt-verifiable.

## Inputs

Each runner has its own required inputs:

- `post`: `actor_kid`, `title`, `deliverable`, `amount_minor`, `currency`,
  optional `funding_evidence`, optional `clock_policy`.
- `moderate`: `moderator_kid`, `posting`, `decision`, optional `reasons`.
- `claim`: `actor_kid`, `posting`, optional `idempotency_seed`.
- `deliver`: `actor_kid`, `claim`, `delivery_evidence`.
- `accept`: `actor_kid`, `delivery`, `acceptance_evidence`.
- `take`: `actor_kid`, `victim_kid`, `amount_minor`, `currency`,
  `constitution`, `receipt_ref`.
