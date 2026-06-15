---
name: governed-outbound
description: Gather an external source, scrub personal data before it crosses the boundary, plan a human-approved notification, and seal the run to the ledger.
runx:
  category: ops
---

# Governed Outbound

Take something from outside, make it safe to send, send it under approval, and
leave proof. `governed-outbound` is the chain that sits between "an agent found
something" and "the team saw it", with the safety and the gate built into the
path rather than bolted on after.

It composes four catalog skills into one governed run:

1. `web-fetch` gathers the source within an explicit host allowlist.
2. `redact-pii` scrubs personal data and returns a pass/hold verdict before any
   of it can leave the boundary.
3. an approval gate holds the send for a human, who sees the redaction verdict
   and the residual risk, not the raw content.
4. `slack-notify` plans the delivery of the scrubbed content to the channel; a
   connector lane runs the actual post.
5. `sign-receipt` seals the run so the gather, the scrub, the approval, and the
   send link into one auditable receipt.

The point of the chain is the order. The scrub runs before the boundary, the
human gate runs before the send, and the seal runs after, so the proof covers
the whole path. No step can be skipped to make the send faster.

## What this skill does

`governed-outbound` is a graph, not a single agent step. Each hop is a real
catalog skill with its own scope, and authority narrows at every branch:
`web-fetch` may only reach the allowlisted host, `redact-pii` may only read the
fetched content, the approval gate authorizes delivery, and `sign-receipt` may
only append to the ledger. Personal data never reaches the channel or the
receipt; the content travels by digest, and the redaction report carries class
and span offsets, never the values it found.

## When to use this skill

- An agent needs to relay external information (an incident page, a changelog, a
  status update, a thread) into a channel, and that information may carry
  personal data.
- A workflow must prove, after the fact, that what left the boundary was
  scrubbed and approved.
- You want one receipt that links the source, the scrub verdict, the approval,
  and the delivery.

## When not to use this skill

- To post content that was authored in-house and carries no external data. Call
  `slack-notify` directly.
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
- `post-notice` runs only when the approval is `true` and the redaction verdict
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
  send transition, so `post-notice` never runs. Nothing leaves the boundary on a
  hold verdict.
- **Approval denied or absent:** the send transition is not satisfied and the
  chain stops at the gate, scrubbed but unsent.
- **Send fails downstream:** the seal still records the attempt and its blocker,
  so the receipt shows what happened.

## Output

The run seals to `runx.receipt.v1`, linking each step's packet:
`fetch_result` (source + digest), `redaction_report` (verdict + spans + redacted
digest), `approval_decision` (the gate), `notify_plan` (the delivery), and the
`attestation` (the seal). The receipt proves the path without reconstructing the
personal data that was removed along the way.

## Inputs

- `url` (required): source to gather before posting.
- `allowlist` (required): hosts `web-fetch` is permitted to reach.
- `channel` (required): destination channel for the notification.
- `principal` (required): principal the notification is sent as.
- `claim` (optional): what the sealed attestation should assert about the run.
- `operator_context` (optional): boundary, audience, or compliance context.
