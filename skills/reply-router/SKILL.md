---
name: reply-router
description: Classify an inbound reply against a sealed original send receipt and either append a recipient-keyed suppression event to a hosted data-store or emit a bounded governed routing decision. The skill never sends mail.
runx:
  category: ops
---

# Reply Router

`reply-router` reads one inbound reply together with the sealed original send
receipt that produced it, classifies the reply against a suppression policy, and
branches. The skill is a read-and-route judgment: it never sends mail, never
mints a new send, and never edits the original send receipt. The actual send is
a separate governed `send-as` run a downstream driver issues by name.

## What This Skill Does

The skill reads three pieces of evidence:

- `inbound_reply{content, received_from, received_at}`
- `original_send_receipt{send_plan, principal, receipt_id, checksum}`
- `suppression_policy{unsubscribe_signals, confidence_threshold}`

It validates that the original send receipt is sealed (the receipt envelope is
present and the checksum matches the named `send_plan`) and that the policy
names at least one unsubscribe signal. It then classifies the reply by
searching the content for any of the policy's `unsubscribe_signals` strings or
patterns. A high-confidence unsubscribe match appends a suppression event to
the hosted data-store `registry:runx/data-store@0.1.2` via an `append_event`
with an idempotency key and an expected_version CAS. The durable record is the
compliance block the next `send-as` preflight reads as a fail-closed gate.

For other classifications (`interested`, `objection`, `out-of-office`,
`wrong-person`), the skill emits a typed `runx.reply.routing.v1` decision
naming a bounded `send_target` and a `principal`. A downstream `send-as` run
honors that decision later; the skill itself does not dispatch.

For an unsealed or missing original send receipt, or for an inbound reply
whose content does not match any policy signal and where the agent cannot
ground a typed classification, the skill escalates to a human approval lane
and emits no suppression event and no routing decision.

## When To Use It

- An operator has a sealed original send receipt and needs a typed decision
  on how to handle the inbound reply before any subsequent send.
- A workflow needs to prove a recipient was unsubscribed via a durable
  data-store record that the next `send-as` preflight can verify.
- A run should keep suppression and routing out of the actual mail path.

## When Not To Use It

- To actually send, queue, schedule, or otherwise move a message. Use a
  separate governed `send-as` run for that effect.
- To append a suppression event without a sealed original send receipt.
- To emit a routing decision when the inbound content is ambiguous or the
  reply cannot be grounded in a policy signal.
- To invent a classification, an unsubscribe match, or a routing target that
  the input evidence does not support.

## Procedure

1. Read `inbound_reply`, `original_send_receipt`, and `suppression_policy`.
   Reject any missing or unclear top-level object.
2. Verify the `original_send_receipt` is sealed: `receipt_id` and `checksum`
   are present, `send_plan` and `principal` are non-empty strings, and
   `checksum` matches the named `send_plan`. If any of these is missing or
   mismatched, escalate to the human approval lane and emit no outputs.
3. Verify `suppression_policy.unsubscribe_signals` is a non-empty list of
   strings. The `confidence_threshold` must be a number in (0, 1].
4. Search `inbound_reply.content` for each policy `unsubscribe_signals`
   string using a case-insensitive match. If at least one signal is found
   and the match is exact (not negated, not quoted as not-an-unsubscribe),
   classify the reply as `unsubscribe` with confidence 1.0 and evidence
   naming the matched signal and the offset in the reply content.
5. For an `unsubscribe` classification, append a suppression event to the
   hosted data-store via `append_event` with:
   - `aggregate_id` = the reply's `received_from` (the recipient key)
   - `idempotency_key` = sha256 of `{receipt_id}:{received_from}:{signal}`
   - `expected_version` = the value from a prior `read_projection` against
     `aggregate_id` (0 if no prior projection exists)
   - The event payload names the matched signal, the original receipt id,
     and the inbound reply received_at timestamp.
   The skill emits a `suppression_result{aggregate_id, idempotency_key,
   before_version, after_version}`. The skill does NOT emit a routing
   decision on this path.
6. If no unsubscribe signal matches, attempt to ground a typed
   classification from a bounded set (`interested`, `objection`,
   `out-of-office`, `wrong-person`) using the reply content and the
   original send plan. If grounding succeeds with confidence above
   `confidence_threshold`, emit `runx.reply.routing.v1{classification,
   send_target, principal}` naming a bounded send target the downstream
   `send-as` run honors. The skill consumes nothing and does not dispatch.
7. If no typed classification can be grounded above
   `confidence_threshold`, escalate to the human approval lane and emit
   no outputs.
8. Never invent a match, classification, or aggregate version. Never append
   a suppression event without a sealed original send receipt. Never
   classify a reply whose `received_from` does not match the principal of
   the original send receipt.

## Outputs

- `classification{type, confidence, evidence}` for every sealed run.
- `suppression_result{aggregate_id, idempotency_key, before_version,
  after_version}` when the reply is an unsubscribe.
- `runx.reply.routing.v1{classification, send_target, principal}` when the
  reply is routed.
- `escalation_reason` when the run stops for a human approval lane.
