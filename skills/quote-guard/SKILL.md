---
name: quote-guard
description: Check a deal ask against account pricing policy, draft an in-policy quote, and emit gated quote-send and settlement-ceiling handoff artifacts.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - quote
    - pricing
    - guardrail
links:
  composes:
    - send-as
    - spend-refund
---

# Quote Guard

Quote Guard reads a bounded deal ask, account pricing policy, and supplied quote
history. It decides whether the request is inside pricing authority, drafts a
quote only when policy allows it, and emits two handoff artifacts:

- `send_proposal`: a gated proposal for a separate governed `send-as` run.
- `settlement_ceiling`: a ceiling that downstream spend/refund runners must not
  exceed.

This skill does not send a quote, mint authority, settle money, modify account
policy, or call external pricing systems.

## Inputs

- `deal_ask`: object with account, counterparty, product, quantity, term,
  currency, list price, requested net price, requested discount, and optional
  quote validity.
- `account_policy`: object with allowed currency, authorized products,
  approval bands, optional minimum margin, and optional default quote validity.
- `quote_history`: array of prior quote records supplied by the caller.

## Outputs

The skill emits `runx.quote_guard.result.v1`:

- `decision`: `{ authorized, reason, policy_band }`.
- `quote_draft`: present only when the request is authorized.
- `send_proposal`: present only when the request is authorized; it is a gated
  proposal for downstream `send-as`.
- `settlement_ceiling`: present only when the request is authorized.
- `escalation`: present when the request is out of policy, ambiguous, or lacks
  enough policy evidence.
- `observations`: source-grounded notes for review and evidence packets.

## Safety Boundaries

Quote Guard is a decision and packaging skill. It never sends email, posts
messages, mints payment authority, settles funds, or writes policy. A downstream
runner or human approver must inspect the gated proposal and run any actual send
or spend action under its own receipt.

The skill refuses to authorize when:

- counterparty identity is missing or ambiguous,
- account policy has no usable approval band,
- product or currency is outside policy,
- requested discount or value exceeds the applicable policy band,
- margin is below policy, or
- quote history is requested but absent from supplied inputs.

Quote history is never invented. Every prior quote cited in the output is copied
from the supplied `quote_history` input by id, status, amount, and timestamp.

## Procedure

1. Validate the deal ask, account policy, and quote history shapes.
2. Normalize requested discount, list price, requested net price, and term.
3. Select the narrowest approval band that allows the requested discount and
   total contract value.
4. Refuse or escalate when required policy evidence is missing or the request is
   outside authority.
5. Draft the quote only for an authorized request.
6. Emit a gated `send_proposal` and a bounded `settlement_ceiling`.
7. Include observations for decision, policy band, prior quote evidence, quote
   digest, proposal status, and refusal or escalation reason.
