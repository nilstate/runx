---
name: governed-outbound
description: Gather an external source, scrub personal data before it crosses the boundary, plan a human-approved notification, and seal the run to the ledger.
runx:
  category: ops
---

# Governed Outbound

Take something from outside, make it safe to send, authorize the exact outbound
plan, and leave proof. `governed-outbound` prepares the boundary crossing; it
does not claim the configured provider delivered anything.

It composes four catalog skills into one governed run:

1. `web-fetch` gathers the source within an explicit host allowlist.
2. `redact-pii` scrubs personal data and returns a pass/hold verdict before any
   of it can leave the boundary.
3. an approval gate holds the plan for a human, who sees the redaction verdict
   and the residual risk, not the raw content.
4. `send-as` binds the scrubbed content, principal, audience, and provider lane
   into an authorized plan.
5. `sign-receipt` seals the gather, scrub, approval, and plan. A separate
   provider host must execute the plan, record delivery evidence, and read it
   back before any caller may call the notification delivered.

The point of the chain is the order. The scrub runs before authorization and the
human gate runs before `send-as`. This receipt proves preparation and authority,
not provider delivery.

## What this skill does

`governed-outbound` is a graph, not a single agent step. Each hop is a real
catalog skill with its own scope, and authority narrows at every branch:
`web-fetch` may only reach the allowlisted host, `redact-pii` may only read the
fetched content, the approval gate authorizes the plan, and `sign-receipt` may
only append to the ledger. Personal data never reaches the channel or the
receipt; the content travels by digest, and the redaction report carries class
and span offsets, never the values it found.

## When to use this skill

- An agent needs to prepare external information (an incident page, a changelog,
  a status update, a thread) for a provider channel, and that information may
  carry personal data.
- A workflow must prove that the proposed outbound content was scrubbed and the
  exact plan was approved before provider execution.
- You want one receipt that links the source, the scrub verdict, the approval,
  and the send plan.

## When not to use this skill

- To post content that was authored in-house and carries no external data. Call
  `send-as` directly, then use the configured provider host.
- To gather a source with no intent to send it onward. Call `web-fetch`.
- To deliver without a human in the loop. The approval gate is the point; a
  send that needs no review does not need this chain.
- To move money, change a repository, or unseal a secret. Those are other
  governed lanes with their own gates.

## How the chain is wired

- `fetch-source` reads `url` and `allowlist` from the run inputs and returns
  `fetch_result` with the content digest and extracted text.
- `scrub-content` takes `fetch-source`'s extracted text as `content`, runs in
  `redact` mode, and returns `redaction_report` with the `ready` / `needs_review`
  / `blocked` verdict, the detected spans, and `redacted_digest`.
- `approve-send` shows the approver the redaction `decision`, the
  `residual_risk`, and the `redacted_digest`, then records an approval decision.
- `plan-notice` runs only when the approval is `true` and the redaction verdict
  is `ready`; it plans the send of the scrubbed content to `channel` as
  `principal`, naming the provider action a connector lane would run.
- `seal-run` attests the run, binding the source digest and the redacted digest
  as evidence, and appends the receipt to the ledger.

## Edge cases and stop conditions

- **No `url` or `allowlist`:** the run returns `needs_agent`; there is nothing
  to gather and no boundary to respect.
- **Host not allowlisted:** `web-fetch` returns `policy_denied` and the chain
  stops before anything is read.
- **Redaction not `ready`:** a `needs_review` or `blocked` verdict fails the
  send transition, so `plan-notice` never runs. Nothing leaves the boundary on a
  hold verdict.
- **Approval denied or absent:** the send transition is not satisfied and the
  chain stops at the gate, scrubbed but unsent.
- **Provider delivery fails downstream:** preserve this planning receipt, record
  the provider failure in the executing host, and do not produce delivery
  evidence or mark the action complete.

## Output

The run seals to `runx.receipt.v1`, linking each step's packet:
`fetch_result` (source + digest), `redaction_report` (verdict + spans + redacted
digest), `approval_decision` (the gate), `send_plan` (the authorization), and the
`attestation` (the seal). `send_plan` is authorization, not delivery evidence.
The receipt proves the preparation path without reconstructing the personal data
that was removed along the way.

## Inputs

- `url` (required): source to gather before preparing the notification.
- `allowlist` (required): hosts `web-fetch` is permitted to reach.
- `channel` (required): destination channel for the notification.
- `principal` (required): principal the notification is sent as.
- `claim` (optional): what the sealed attestation should assert about the run.
- `operator_context` (optional): boundary, audience, or compliance context.
